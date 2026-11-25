import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import { effect as providerEffect } from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Data, Effect, Option, Redacted } from "effect";
import { connectionString, dropDatabase, ensureDatabase } from "./client.ts";
import type { Credentials, Server } from "./client.ts";
import type { Providers } from "./Providers.ts";
import { DuragresServer, envServerConfig } from "./ServerConfig.ts";
import type { ServerConfig } from "./ServerConfig.ts";

export interface PostgresOrigin {
  scheme: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
}

export type DatabaseTemplate =
  | { name: string; user: string; password?: string | Redacted.Redacted<string> }
  | { database: string; user: string; password?: string | Redacted.Redacted<string> };

export interface DatabaseProps {
  host?: string;
  port?: number;
  sslmode?: "verify-full" | "disable";
  name?: string;
  template?: DatabaseTemplate;
  user?: string;
  password?: string | Redacted.Redacted<string>;
}

export interface DatabaseAttributes {
  name: string;
  host: string;
  port: number;
  sslmode: "verify-full" | "disable";
  user: string;
  password: Redacted.Redacted<string>;
  origin: PostgresOrigin;
  connectionUri: Redacted.Redacted<string>;
}

export class DuragresError extends Data.TaggedError("DuragresError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type Database = Resource<
  "Duragres.Database",
  DatabaseProps,
  DatabaseAttributes,
  never,
  Providers
>;

export const Database = Resource<Database>("Duragres.Database");

const secret = (value: string | Redacted.Redacted<string> | undefined): string | undefined =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const templateName = (t: DatabaseTemplate | undefined): string | undefined =>
  t ? ("name" in t ? t.name : t.database) : undefined;

const resolveTemplate = (t: DatabaseTemplate | undefined): ({ name: string } & Credentials) | undefined =>
  t ? { name: "name" in t ? t.name : t.database, user: t.user, password: secret(t.password) } : undefined;

const toError = (cause: unknown) =>
  new DuragresError({ message: cause instanceof Error ? cause.message : String(cause), cause });

const generatePassword = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const resolveServer = (
  props: DatabaseProps,
  readServerConfig: Effect.Effect<ServerConfig>,
): Effect.Effect<Required<Server>, DuragresError> =>
  Effect.gen(function* () {
    const defaults = yield* readServerConfig;
    const host = props.host ?? defaults.host;
    if (!host) {
      return yield* new DuragresError({
        message: "Duragres host is required: pass `host` on Duragres.Database, pass `{ host }` to Duragres.providers(), or set DURAGRES_HOST.",
      });
    }
    return {
      host,
      port: props.port ?? defaults.port ?? 5432,
      sslmode: props.sslmode ?? defaults.sslmode ?? "verify-full",
    };
  });

export const DatabaseProvider = () =>
  providerEffect(
    Database,
    Effect.gen(function* () {
      const configured = yield* Effect.serviceOption(DuragresServer);
      const readServerConfig = Option.getOrElse(configured, () => envServerConfig);
      return Database.Provider.of({
        stables: ["name", "host", "port", "sslmode"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const defaults = yield* readServerConfig;
          const nextHost = news.host ?? defaults.host;
          const prevHost = output?.host ?? olds.host ?? defaults.host;
          const nextPort = news.port ?? defaults.port ?? 5432;
          const prevPort = output?.port ?? olds.port ?? defaults.port ?? 5432;
          const nextSsl = news.sslmode ?? defaults.sslmode ?? "verify-full";
          const prevSsl = output?.sslmode ?? olds.sslmode ?? defaults.sslmode ?? "verify-full";
          if (nextHost !== prevHost || nextPort !== prevPort || nextSsl !== prevSsl || news.name !== olds.name) {
            return { action: "replace" as const };
          }
          if (templateName(news.template) !== templateName(olds.template)) {
            return {
              action: "replace" as const,
              deleteFirst: news.name !== undefined && news.name === (output?.name ?? olds.name),
            };
          }
          const nextUser = news.user ?? "demo";
          const prevUser = output?.user ?? olds.user ?? "demo";
          const nextPassword = secret(news.password);
          const prevPassword = secret(olds.password);
          const passwordChanged =
            nextPassword !== undefined
              ? nextPassword !== (output ? Redacted.value(output.password) : prevPassword)
              : prevPassword !== undefined;
          if (nextUser !== prevUser || passwordChanged) {
            return { action: "update" as const, stables: ["name", "host", "port", "sslmode"] };
          }
          return { action: "noop" as const };
        }),
        // Never connect when `output` is missing: Duragres creates databases on connect.
        read: ({ output }) => Effect.succeed(output),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const server = yield* resolveServer(news, readServerConfig);
          const name =
            news.name ?? output?.name ?? (yield* createPhysicalName({ id, maxLength: 63, lowercase: true })).replace(/^-+/, "db-");
          const user = news.user ?? "demo";
          const password =
            secret(news.password) ?? (output?.password ? Redacted.value(output.password) : generatePassword());
          const previousOwner: Credentials | undefined = output
            ? { user: output.user, password: Redacted.value(output.password) }
            : undefined;

          yield* Effect.tryPromise({
            try: () =>
              ensureDatabase(server, {
                name,
                template: resolveTemplate(news.template),
                owner: { user, password },
                previousOwner,
              }),
            catch: toError,
          });

          const redactedPassword = Redacted.make(password);
          return {
            name,
            host: server.host,
            port: server.port,
            sslmode: server.sslmode,
            user,
            password: redactedPassword,
            origin: {
              scheme: "postgres" as const,
              host: server.host,
              port: server.port,
              database: name,
              user,
              password: redactedPassword,
            },
            connectionUri: Redacted.make(connectionString(server, name, { user, password })),
          };
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          yield* Effect.tryPromise({
            try: () =>
              dropDatabase(
                { host: output.host, port: output.port, sslmode: output.sslmode },
                {
                  name: output.name,
                  template: resolveTemplate(olds.template),
                  owner: { user: output.user, password: Redacted.value(output.password) },
                },
              ).then(() => undefined),
            catch: toError,
          });
        }),
        list: () => Effect.succeed([]),
      });
    }),
  );
