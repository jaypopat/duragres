import { connect } from "./gateway";
import { fetch } from "./fork";

export { PgDO } from "./database/object";
export default { connect, fetch } satisfies ExportedHandler<Env>;
