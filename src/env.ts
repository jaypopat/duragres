import type { PgDO } from "./database/object";
import type { LimitsDO } from "./database/limits";
import type { LifecycleEnv } from "./database/lifecycle";

export interface Env extends LifecycleEnv {
  PG: DurableObjectNamespace<PgDO>;
  LIMITS: DurableObjectNamespace<LimitsDO>;
  SNAPSHOTS: R2Bucket;
  FORK_TOKEN?: string;
  POSTGRES_URL?: string;
  LOG_SQL?: string;
  LOG_CONNECTIONS?: string; // log client address + database per connection (deploy smoke test)
}
