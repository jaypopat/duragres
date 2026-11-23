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
import { PgError, type Result } from "../postgres/wire";
import { run, type Params, type Runnable } from "./exec";
import type { Session } from "./session";
import type { Statement } from "./statement";

interface Write { stmt: Runnable; params: Params; oids: number[] }
export interface Tx { log: Write[]; failed: boolean }

/** Carries a statement's result out of the transactionSync that is rolled back. */
class Preview {
  constructor(readonly result: Result) {}
}

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
  if (tx.failed) throw new PgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
  if (!tx.log.length && !writes(stmt)) return run(stmt, params, s, oids);
  let result: Result | undefined;
  try {
    inSync(s, () => {
      replay(s, tx.log);
      throw new Preview(run(stmt, params, s, oids));
    });
  } catch (e) {
    if (!(e instanceof Preview)) throw e;
    result = e.result;
  }
  if (writes(stmt)) tx.log.push({ stmt, params, oids });
  return result!;
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
