import { Database, providers as duragresProviders } from "@duragres/alchemy";
import { localState, Stack, Stage } from "alchemy";
import { Effect } from "effect";

const localDefaults = process.env.DURAGRES_HOST
  ? undefined
  : { host: "127.0.0.1", port: 8788, sslmode: "disable" as const };

export default Stack(
  "duragres-example",
  {
    providers: duragresProviders(localDefaults),
    state: localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Stage;

    const seed = yield* Database("SeedDatabase", {
      name: "example-seed",
    });

    const preview = yield* Database("PreviewDatabase", {
      name: `preview-${stage.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}`,
      template: seed.origin,
    });

    return {
      seed: seed.name,
      preview: preview.name,
      origin: preview.origin,
      connectionUri: preview.connectionUri,
    };
  }),
);
