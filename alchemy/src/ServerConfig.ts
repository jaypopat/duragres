import { Config, Context, Effect, Layer, Option } from "effect";

export interface ServerConfig {
  readonly host?: string;
  readonly port?: number;
  readonly sslmode?: "verify-full" | "disable";
}

export class DuragresServer extends Context.Service<
  DuragresServer,
  Effect.Effect<ServerConfig>
>()("Duragres.Server") {}

export const envServerConfig: Effect.Effect<ServerConfig> = Effect.gen(function* () {
  const host = Option.getOrUndefined(yield* Config.String("DURAGRES_HOST").pipe(Config.option));
  const port = Option.getOrUndefined(yield* Config.Number("DURAGRES_PORT").pipe(Config.option));
  const sslmodeRaw = Option.getOrUndefined(
    yield* Config.String("DURAGRES_SSLMODE").pipe(Config.option),
  );
  const sslmode: ServerConfig["sslmode"] =
    sslmodeRaw === "verify-full" || sslmodeRaw === "disable" ? sslmodeRaw : undefined;
  return { host, port, sslmode };
}).pipe(Effect.orDie);

export const serverConfigLayer = (config?: ServerConfig) =>
  Layer.succeed(
    DuragresServer,
    Effect.map(envServerConfig, (env) => ({
      host: config?.host ?? env.host,
      port: config?.port ?? env.port,
      sslmode: config?.sslmode ?? env.sslmode,
    })),
  );
