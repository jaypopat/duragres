// CREATE DATABASE ... TEMPLATE and DROP DATABASE: branching and cleanup over the wire.
// Knowing a database's name is what lets you connect to it, so it is also what lets
// you drop it; copying one requires being connected to it.
import { DB_NAME } from "../database/lifecycle";
import { PgError, type Result } from "../postgres/wire";
import type { Session } from "./session";
import type { Statement } from "./statement";

type DatabaseCommand = Extract<Statement, { kind: "createDatabase" | "dropDatabase" }>;

export async function runDatabaseCommand(stmt: DatabaseCommand, s: Session): Promise<Result> {
  const verb = stmt.kind === "createDatabase" ? "CREATE" : "DROP";
  if (s.tx) throw new PgError("25001", `${verb} DATABASE cannot run inside a transaction block`);
  if (!DB_NAME.test(stmt.name)) {
    throw new PgError("42602", `invalid database name "${stmt.name}" (duragres names: 3-63 chars, a-z 0-9 and "-", starting with a letter or digit)`);
  }

  if (stmt.kind === "createDatabase") {
    if (stmt.template !== undefined && stmt.template !== s.database) {
      throw new PgError("0A000", `connect to "${stmt.template}" to use it as a template`);
    }
    if ((await s.databases.create(stmt.name, stmt.template !== undefined)) === "exists") {
      throw new PgError("42P04", `database "${stmt.name}" already exists`);
    }
    return { kind: "command", tag: "CREATE DATABASE" };
  }

  if (stmt.name === s.database) throw new PgError("55006", "cannot drop the currently open database");
  const outcome = await s.databases.drop(stmt.name, stmt.force);
  if (outcome === "missing" && !stmt.ifExists) throw new PgError("3D000", `database "${stmt.name}" does not exist`);
  if (outcome === "in-use") throw new PgError("55006", `database "${stmt.name}" is being accessed by other users; use DROP DATABASE ... WITH (FORCE)`);
  return { kind: "command", tag: "DROP DATABASE" };
}
