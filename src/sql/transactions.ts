// BEGIN/COMMIT/ROLLBACK on top of DO SQLite, which only offers synchronous
// transactionSync() and rejects BEGIN in exec().
//
// Inside a transaction, every statement runs as: transactionSync(replay the
// transaction's earlier writes; run this statement; throw to roll back). The
// client sees its own writes, nothing is committed. COMMIT replays the log for
// real in one transactionSync; ROLLBACK discards it. After an error the
// transaction is aborted (25P02) until ROLLBACK/COMMIT, like Postgres; the
// protocol marks it failed when any statement errors.
//
// Known difference: non-deterministic values (gen_random_uuid(), now()) seen
// during the transaction can differ from the committed ones, because COMMIT
// re-executes the statements.
import { PgError, type Field, type Result } from "../postgres/wire";
import { describe, run, type Params, type Runnable } from "./exec";
import type { Session } from "./session";
import type { Statement } from "./statement";

interface Write { stmt: Runnable; params: Params; oids: number[] }
export interface Tx { log: Write[]; failed: boolean }

/** Carries a value out of the transactionSync that is rolled back. */
class Preview<R> {
  constructor(readonly value: R) {}
}

/** Runs `fn` on the open transaction's uncommitted state, then rolls everything back. */
function rolledBack<R>(s: Session, fn: () => R): R {
  try {
    inSync(s, () => {
      if (s.tx) replay(s, s.tx.log);
      throw new Preview(fn());
    });
  } catch (e) {
    if (e instanceof Preview) return e.value as R;
    throw e;
  }
  throw new Error("unreachable: rolledBack always throws");
}

const aborted = () => new PgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");

const writes = (stmt: Runnable) => stmt.kind === "addConstraint" || (stmt.kind === "sql" && !stmt.readOnly);

function replay(s: Session, log: Write[]) {
  for (const w of log) run(w.stmt, w.params, s, w.oids);
}

/** DDL executed during replay joins this storage transaction. */
function inSync<R>(s: Session, fn: () => R): R {
  s.inSync = true;
  try {
    return s.storage.transactionSync(fn);
  } finally {
    s.inSync = false;
  }
}

export function execute(stmt: Statement, params: Params, s: Session, oids: number[] = []): Result {
  if (stmt.kind === "transaction") return control(stmt.op, s);
  const tx = s.tx;
  if (!tx) return run(stmt, params, s, oids);
  if (tx.failed) throw aborted();
  if (!tx.log.length && !writes(stmt)) return run(stmt, params, s, oids);
  const result = rolledBack(s, () => run(stmt, params, s, oids));
  if (writes(stmt)) tx.log.push({ stmt, params, oids });
  return result;
}

/**
 * RowDescription fields for a statement, seen from the open transaction, with no side
 * effects. Falls back to running it and rolling back when it can't be described statically.
 */
export function describeStatement(stmt: Statement, params: Params, s: Session, oids: number[]): Field[] | null {
  if (stmt.kind === "transaction") return null;
  if (s.tx?.failed) throw aborted();
  const byRunning = () => {
    const result = run(stmt, params, s, oids);
    return result.kind === "rows" ? result.fields : null;
  };
  const inspect = () => {
    const fields = describe(stmt, s);
    return fields === undefined ? byRunning() : fields;
  };
  if (s.tx?.log.length) return rolledBack(s, inspect);
  const fields = describe(stmt, s);
  if (fields !== undefined) return fields;
  return writes(stmt) ? rolledBack(s, byRunning) : byRunning();
}

function control(op: "begin" | "commit" | "rollback", s: Session): Result {
  if (op === "begin") {
    s.tx ??= { log: [], failed: false }; // a nested BEGIN is a warning in Postgres; keep the outer one
    return { kind: "command", tag: "BEGIN" };
  }
  const tx = s.tx;
  s.tx = undefined;
  // Postgres reports COMMIT of a failed transaction as ROLLBACK.
  if (op === "rollback" || tx?.failed) return { kind: "command", tag: "ROLLBACK" };
  if (tx?.log.length) inSync(s, () => replay(s, tx.log));
  return { kind: "command", tag: "COMMIT" };
}

/** ReadyForQuery status: I idle, T in transaction, E failed transaction. */
export const txStatus = (s: Session): "I" | "T" | "E" => (!s.tx ? "I" : s.tx.failed ? "E" : "T");
