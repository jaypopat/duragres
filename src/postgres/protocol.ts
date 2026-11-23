// Post-authentication message handling: simple query (Q) and the extended
// protocol (Parse/Bind/Describe/Execute/Sync) that node-postgres uses for $1 params.
import { splitStatements, sqliteErrorToPg } from "../sql/exec";
import { execute, txStatus } from "../sql/transactions";
import type { Session } from "../sql/intercept";
import { OID, Reader, decodeText, encodeResult, msg, type Result } from "./wire";

// pg-gateway treats an empty iterable as "not handled" and falls back to its own
// handler, so "reply with nothing" must be one zero-length chunk.
const NOTHING = [new Uint8Array(0)];

// A portal runs at most once: Describe runs it and caches the result, Execute
// returns the cache. A repeated Execute on a finished portal returns no rows.
interface Portal { sql: string; params: (string | null)[]; oids: number[]; result?: Result; done?: boolean }

function zeroTag(r?: Result): string {
  const tag = r && r.kind !== "empty" ? r.tag : "SELECT 0";
  return tag.replace(/\d+$/, "0");
}

export class Protocol {
  private statements = new Map<string, { sql: string; oids: number[] }>();
  private portals = new Map<string, Portal>();
  private failed = false; // after an extended-protocol error, discard until Sync

  constructor(private s: Session) {}

  private ready() {
    return msg.readyForQuery(txStatus(this.s));
  }

  /** Returns response bytes, or undefined to let pg-gateway handle the message (Terminate). */
  handle(data: Uint8Array): Uint8Array[] | undefined {
    const r = new Reader(data);
    if (r.type === "X") return undefined;
    if (r.type === "Q") return this.simple(r.cstr());
    if (r.type === "S") { this.failed = false; return [this.ready()]; }
    if (r.type === "H") return NOTHING;
    if (this.failed) return NOTHING;
    try {
      return this.extended(r);
    } catch (e) {
      this.failed = true;
      return [msg.error(sqliteErrorToPg(e))];
    }
  }

  private simple(query: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    const stmts = splitStatements(query);
    if (!stmts.length) out.push(msg.emptyQuery());
    for (const stmt of stmts) {
      try {
        out.push(...encodeResult(execute(stmt, [], this.s)));
      } catch (e) {
        out.push(msg.error(sqliteErrorToPg(e)));
        break;
      }
    }
    out.push(this.ready());
    return out;
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
        const nfmt = r.int16();
        for (let i = 0; i < nfmt; i++) r.int16(); // text format assumed
        const params: (string | null)[] = [];
        const n = r.int16();
        for (let i = 0; i < n; i++) {
          const len = r.int32();
          params.push(len < 0 ? null : decodeText(r.bytes(len)));
        }
        this.portals.set(portal, { sql, params, oids });
        return [msg.bindComplete()];
      }
      case "D": {
        const kind = String.fromCharCode(r.byte());
        const name = r.cstr();
        if (kind === "S") {
          const sql = this.statements.get(name)?.sql ?? "";
          const n = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
          return [msg.parameterDescription(Array(n).fill(OID.text)), msg.noData()];
        }
        // Portal: run now so we can describe the real columns; Execute replays the cached result.
        const p = this.portals.get(name)!;
        p.result ??= execute(p.sql, p.params, this.s, p.oids);
        return [p.result.kind === "rows" ? msg.rowDescription(p.result.fields) : msg.noData()];
      }
      case "E": {
        const name = r.cstr();
        const p = this.portals.get(name)!;
        if (p.done) return [msg.commandComplete(zeroTag(p.result))];
        p.result ??= execute(p.sql, p.params, this.s, p.oids);
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
