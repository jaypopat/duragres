import { collection, ProviderCollection } from "alchemy/Provider";
import { Layer } from "effect";
import { Database, DatabaseProvider } from "./Database.ts";
import { serverConfigLayer } from "./ServerConfig.ts";
import type { ServerConfig } from "./ServerConfig.ts";

export class Providers extends ProviderCollection<Providers>()("Duragres") {}

export const providers = (config?: ServerConfig) =>
  Layer.effect(Providers, collection([Database])).pipe(
    Layer.provideMerge(DatabaseProvider()),
    Layer.provide(serverConfigLayer(config)),
    Layer.orDie,
  );
