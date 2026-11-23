// Post-authentication message handling: the simple query protocol (Q) and the
// extended protocol (Parse/Bind/Describe/Execute/Sync) that drivers use for $n parameters.
import { sqliteErrorToPg, type Params } from "../sql/exec";
import { findNodes, parse } from "../sql/polyglot";
import type { Session } from "../sql/session";
import { prepare } from "../sql/statement";
import { execute, txStatus } from "../sql/transactions";
import { OID, PgError, Reader, decodeText, encodeResult, msg, type Result } from "./wire";

// pg-gateway treats an empty iterable as "not handled" and falls back to its own
// handler, so "reply with nothing" must be one zero-length chunk.
const NOTHING = [new Uint8Array(0)];

// A portal runs at most once: Describe runs it and caches the result, Execute
// returns the cache. A repeated Execute on a finished portal returns no rows.
interface Portal { sql: string; params: Params; oids: number[]; result?: Result; done?: boolean }

function zeroTag(r?: Result): string {
  const tag = r && r.kind !== "empty" ? r.tag : "SELECT 0";
  return tag.replace(/\d+$/, "0");
}

/** The number of $n parameters a statement takes. Unparseable SQL fails later, at Execute. */
function parameterCount(sql: string): number {
  try {
    return Math.max(0, ...parse(sql).flatMap((node) => findNodes(node, (n) => n?.parameter).map((n) => n.parameter.index)));
  } catch {
    return 0;
  }
}

export class Protocol {
  private statements = new Map<string, { sql: string; oids: number[] }>();
  private portals = new Map<string, Portal>();
  private failed = false; // after an extended-protocol error, discard until Sync

  constructor(private s: Session) {}

  /** Returns response bytes, or undefined to let pg-gateway handle the message (Terminate). */
  handle(data: Uint8Array): Uint8Array[] | undefined {
    const r = new Reader(data);
    if (r.type === "X") return undefined;
    if (r.type === "Q") return this.simple(r.cstr());
    if (r.type === "S") {
      this.failed = false;
      return [this.ready()];
    }
    if (r.type === "H") return NOTHING;
    if (this.failed) return NOTHING;
    try {
      return this.extended(r);
    } catch (e) {
      this.failed = true;
      return [this.error(e)];
    }
  }

  private ready() {
    return msg.readyForQuery(txStatus(this.s));
  }

  /** An error also aborts the open transaction, as in Postgres. */
  private error(e: unknown) {
    if (this.s.tx) this.s.tx.failed = true;
    return msg.error(sqliteErrorToPg(e));
  }

  private simple(query: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    try {
      const statements = prepare(query, this.s);
      if (!statements.length) out.push(msg.emptyQuery());
      for (const stmt of statements) out.push(...encodeResult(execute(stmt, [], this.s)));
    } catch (e) {
      out.push(this.error(e));
    }
    out.push(this.ready());
    return out;
  }

  /** One extended-protocol statement. */
  private run(p: Portal): Result {
    const statements = prepare(p.sql, this.s);
    if (statements.length > 1) throw new PgError("42601", "cannot insert multiple commands into a prepared statement");
    return statements.length ? execute(statements[0], p.params, this.s, p.oids) : { kind: "empty" };
  }

  private extended(r: Reader): Uint8Array[] {
    switch (r.type) {
      case "P": {
        const name = r.cstr();
        const sql = r.cstr();
        const oids = Array.from({ length: r.int16() }, () => r.int32());
        this.statements.set(name, { sql, oids });
        return [msg.parseComplete()];
      }
      case "B": {
        const portal = r.cstr();
        const { sql, oids } = this.statements.get(r.cstr()) ?? { sql: "", oids: [] };
        const formats = r.int16();
        for (let i = 0; i < formats; i++) r.int16(); // text format assumed
        const params: Params = [];
        const n = r.int16();
        for (let i = 0; i < n; i++) {
          const length = r.int32();
          params.push(length < 0 ? null : decodeText(r.bytes(length)));
        }
        this.portals.set(portal, { sql, params, oids });
        return [msg.bindComplete()];
      }
      case "D": {
        const kind = String.fromCharCode(r.byte());
        const name = r.cstr();
        if (kind === "S") {
          const n = parameterCount(this.statements.get(name)?.sql ?? "");
          return [msg.parameterDescription(Array(n).fill(OID.text)), msg.noData()];
        }
        // Portal: run now to describe the real columns; Execute returns the cached result.
        const p = this.portals.get(name)!;
        p.result ??= this.run(p);
        return [p.result.kind === "rows" ? msg.rowDescription(p.result.fields) : msg.noData()];
      }
      case "E": {
        const p = this.portals.get(r.cstr())!;
        if (p.done) return [msg.commandComplete(zeroTag(p.result))];
        p.result ??= this.run(p);
        p.done = true;
        return encodeResult(p.result, false);
      }
      case "C": {
        const kind = String.fromCharCode(r.byte());
        (kind === "S" ? this.statements : this.portals).delete(r.cstr());
        return [msg.closeComplete()];
      }
      default:
        throw new Error(`unsupported message type '${r.type}'`);
    }
  }
}
