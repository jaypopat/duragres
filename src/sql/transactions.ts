// BEGIN/COMMIT/ROLLBACK on top of DO SQLite, which rejects BEGIN and SAVEPOINT in
// exec() and freezes the object while an async storage.transaction() is open, so no
// SQLite transaction can stay open while the client thinks between statements.
//
// Instead, each statement in a transaction runs inside transactionSync(replay the
// transaction's earlier writes; run this statement; roll back). The client sees its
// own writes and nothing is committed. COMMIT replays the log for real in one
// transactionSync; ROLLBACK discards it.
//
// The replay reproduces exactly what the client saw because:
// - from its first write to COMMIT, the transaction holds the database's WriterLock,
//   so no other connection changes the committed state it replays on;
// - each write is made deterministic before it is logged (determinism.ts).
//
// After an error the transaction is aborted (25P02) until ROLLBACK/COMMIT, like
// Postgres; the protocol marks it failed when any statement errors.
import { PgError, type Field, type Result } from "../postgres/wire";
import { runDatabaseCommand } from "./databases";
import { materializeInsert } from "./determinism";
import { describe, run, type Params, type Runnable } from "./exec";
import type { Session } from "./session";
import type { Statement } from "./statement";

interface Write { stmt: Runnable; params: Params; oids: number[] }
export interface Tx { log: Write[]; failed: boolean; startedAt: number }

/** Thrown to make transactionSync roll back. */
const ROLLBACK = Symbol("rollback");

/** Runs `fn` on the open transaction's uncommitted state, then rolls everything back. */
function rolledBack<R>(s: Session, fn: () => R): R {
  let value: R | undefined;
  try {
    inSync(s, () => {
      if (s.tx) replay(s, s.tx.log);
      value = fn();
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return value as R;
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

export async function execute(stmt: Statement, params: Params, s: Session, oids: number[] = []): Promise<Result> {
  if (stmt.kind === "transaction") return control(stmt.op, s);
  if (stmt.kind === "createDatabase" || stmt.kind === "dropDatabase") return runDatabaseCommand(stmt, s);
  const tx = s.tx;
  if (!tx) {
    if (!writes(stmt)) return run(stmt, params, s, oids);
    await s.lock.acquire(s); // wait for any open write transaction to finish
    try {
      return run(stmt, params, s, oids);
    } finally {
      s.lock.release(s);
    }
  }
  if (tx.failed) throw aborted();
  if (writes(stmt)) await s.lock.acquire(s);
  // Fixing defaults reads the table, which may exist only in this transaction.
  const fixed = tx.log.length ? rolledBack(s, () => deterministic(stmt, s, tx.startedAt)) : deterministic(stmt, s, tx.startedAt);
  if (!tx.log.length && !writes(fixed)) return run(fixed, params, s, oids);
  const result = rolledBack(s, () => run(fixed, params, s, oids));
  if (writes(fixed)) tx.log.push({ stmt: fixed, params, oids });
  return result;
}

/** The statement as it must be logged: reading the transaction's clock, with volatile INSERT values fixed. */
function deterministic(stmt: Runnable, s: Session, clock: number): Runnable {
  if (stmt.kind !== "sql") return stmt;
  return { ...materializeInsert(stmt, s, clock), clock };
}

/**
 * RowDescription fields for a statement, seen from the open transaction, with no side
 * effects. Falls back to running it and rolling back when it can't be described statically.
 */
export function describeStatement(stmt: Statement, params: Params, s: Session, oids: number[]): Field[] | null {
  if (stmt.kind === "transaction" || stmt.kind === "createDatabase" || stmt.kind === "dropDatabase") return null;
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
    s.tx ??= { log: [], failed: false, startedAt: Date.now() }; // a nested BEGIN is a warning in Postgres; keep the outer one
    return { kind: "command", tag: "BEGIN" };
  }
  const tx = s.tx;
  s.tx = undefined;
  try {
    // Postgres reports COMMIT of a failed transaction as ROLLBACK.
    if (op === "rollback" || tx?.failed) return { kind: "command", tag: "ROLLBACK" };
    if (tx?.log.length) inSync(s, () => replay(s, tx.log));
    return { kind: "command", tag: "COMMIT" };
  } finally {
    s.lock.release(s);
  }
}

/** ReadyForQuery status: I idle, T in transaction, E failed transaction. */
export const txStatus = (s: Session): "I" | "T" | "E" => (!s.tx ? "I" : s.tx.failed ? "E" : "T");
