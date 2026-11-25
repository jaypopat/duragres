import { Service } from "alchemy/Binding";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer, Redacted } from "effect";
import type { Database } from "./Database.ts";

export interface ConnectClient {
  connectionString: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
}

export type Connect = Service<
  Connect,
  "Duragres.Connect",
  (database: Pick<Database, "FQN" | "connectionUri">) => Effect.Effect<ConnectClient>
>;

export const Connect = Service<Connect>("Duragres.Connect");

export const connectEnvKey = (database: Pick<Database, "FQN">): string => {
  const encoded = Array.from(database.FQN, (ch) => (ch.codePointAt(0) ?? 0).toString(16)).join("_");
  return `DURAGRES_${encoded}_DATABASE_URL`;
};

declare global {
  var __ALCHEMY_RUNTIME__: boolean | undefined;
}

export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const context = yield* CurrentRuntimeContext;
    if (!context) return yield* Effect.die(new Error("Duragres.Connect requires a Platform host"));
    return Effect.fn(function* (database: Pick<Database, "FQN" | "connectionUri">) {
      const key = connectEnvKey(database);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* context.set(key, database.connectionUri);
      }
      return {
        connectionString: Effect.gen(function* () {
          const value = yield* context.get<string | Redacted.Redacted<string>>(key);
          if (value === undefined || value === "") {
            return yield* Effect.die(new Error(`Missing Duragres database environment value: ${key}`));
          }
          return Redacted.isRedacted(value) ? value : Redacted.make(value);
        }),
      } satisfies ConnectClient;
    });
  }),
);
