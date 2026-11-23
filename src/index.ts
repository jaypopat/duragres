import { connect } from "./postgres/gateway";
import { handleRequest } from "./fork";
import type { Env } from "./env";

export { PgDO } from "./database/object";
export { LimitsDO } from "./database/limits";
export default { connect, fetch: handleRequest } satisfies ExportedHandler<Env>;
