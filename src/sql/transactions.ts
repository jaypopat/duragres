// BEGIN/COMMIT/ROLLBACK on top of DO SQLite, which only offers synchronous
// transactionSync() and rejects BEGIN in exec().
//
// Inside a transaction, every statement runs as: transactionSync(replay the
// transaction's earlier writes; run this statement; throw to roll back). The
// client sees its own writes, nothing is committed. COMMIT replays the log for
// real in one transactionSync; ROLLBACK discards it. After an error the
// transaction is aborted (25P02) until ROLLBACK/COMMIT, like Postgres.
//
// Known difference: non-deterministic values (gen_random_uuid(), now()) seen
// during the transaction can differ from the committed ones, because COMMIT
// re-executes the statements.
import { runStatement } from "./exec";
import type { Session } from "./intercept";
import { PgError, type Result } from "../postgres/wire";

interface TxStatement { pg: string; params: (string | null)[]; oids: number[] }
export interface Tx { log: TxStatement[]; failed: boolean }

const TX_CONTROL = /^\s*(begin|start\s+transaction|commit|end|rollback|abort)\b/i;
const READ_ONLY = /^\s*(select|show|values|with\s+(?![\s\S]*\b(insert|update|delete)\b))/i;

class Preview {
  constructor(readonly result: Result) {}
}

function replay(s: Session, log: TxStatement[]) {
  for (const t of log) runStatement(t.pg, t.params, s, t.oids);
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

export function execute(pg: string, params: (string | null)[], s: Session, oids: number[] = []): Result {
  const ctl = TX_CONTROL.exec(pg)?.[1]?.toLowerCase();
  if (ctl) {
    if (ctl === "begin" || ctl.startsWith("start")) {
      s.tx ??= { log: [], failed: false }; // nested BEGIN is a warning in Postgres; keep the outer one
      return { kind: "command", tag: "BEGIN" };
    }
    const tx = s.tx;
    s.tx = undefined;
    if (ctl === "rollback" || ctl === "abort") return { kind: "command", tag: "ROLLBACK" };
    if (tx?.failed) return { kind: "command", tag: "ROLLBACK" }; // Postgres reports COMMIT of a failed tx as ROLLBACK
    if (tx?.log.length) inSync(s, () => replay(s, tx.log));
    return { kind: "command", tag: "COMMIT" };
  }

  const tx = s.tx;
  if (!tx) return runStatement(pg, params, s, oids);
  if (tx.failed) throw new PgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
  try {
    if (!tx.log.length && READ_ONLY.test(pg)) return runStatement(pg, params, s, oids);
    let result: Result | undefined;
    try {
      inSync(s, () => {
        replay(s, tx.log);
        throw new Preview(runStatement(pg, params, s, oids));
      });
    } catch (e) {
      if (!(e instanceof Preview)) throw e;
      result = e.result;
    }
    if (!READ_ONLY.test(pg)) tx.log.push({ pg, params, oids });
    return result!;
  } catch (e) {
    tx.failed = true;
    throw e;
  }
}

/** ReadyForQuery status: I idle, T in transaction, E failed transaction. */
export const txStatus = (s: Session): "I" | "T" | "E" => (!s.tx ? "I" : s.tx.failed ? "E" : "T");
