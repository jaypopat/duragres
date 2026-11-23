import { connect } from "./gateway";

export { PgDO } from "./database/object";
export default { connect } satisfies ExportedHandler<Env>;
