// Post-authentication message handling: the simple query protocol (Q) and the
// extended protocol (Parse/Bind/Describe/Execute/Sync) that drivers use for $n parameters.
import { sqliteErrorToPg } from '../sql/exec';
import type { Params } from '../sql/exec';
import { findNodes } from "../sql/polyglot";
import type { Session } from "../sql/session";
import { prepare } from '../sql/statement';
import type { Statement } from '../sql/statement';
import { describeStatement, execute, txStatus } from "../sql/transactions";
import { OID, PgError, Reader, decodeText, encodeResult, msg } from './wire';
import type { Field, Result } from './wire';

// pg-gateway treats an empty iterable as "not handled" and falls back to its own
// handler, so "reply with nothing" must be one zero-length chunk.
const NOTHING = [new Uint8Array(0)];

interface Prepared { stmt?: Statement; oids: Array<number> } // no stmt: an empty query

// A portal runs once, at its first Execute. Later Executes page through the rows
// when the client asked for a row limit, then report zero rows.
interface Portal extends Prepared { params: Params; result?: Result; sent: number; done: boolean }

const zeroTag = (r: Result) => (r.kind === "empty" ? "SELECT 0" : r.tag.replace(/\d+$/, "0"));

/** The number of $n parameters a statement takes. */
function parameterCount(stmt?: Statement): number {
  if (stmt?.kind !== "sql") return 0;
  return Math.max(0, ...findNodes(stmt.node, (n) => "parameter" in n).map((n) => ("parameter" in n ? (n.parameter.index ?? 0) : 0)));
}

export class Protocol {
  private statements = new Map<string, Prepared>();
  private portals = new Map<string, Portal>();
  private failed = false; // after an extended-protocol error, discard until Sync

  constructor(private s: Session) {}

  /** Returns response bytes, or undefined to let pg-gateway handle the message (Terminate). */
  async handle(data: Uint8Array): Promise<Array<Uint8Array> | undefined> {
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
      return await this.extended(r);
    } catch (e) {
      this.failed = true;
      return [this.error(e)];
    }
  }

  private portal(name: string): Portal {
    const p = this.portals.get(name);
    if (!p) throw new PgError("34000", `portal "${name}" does not exist`);
    return p;
  }

  private rowDescription(fields: Array<Field> | null | undefined) {
    return fields ? msg.rowDescription(fields) : msg.noData();
  }

  private ready() {
    return msg.readyForQuery(txStatus(this.s));
  }

  /** An error also aborts the open transaction, as in Postgres. */
  private error(e: unknown) {
    if (this.s.tx) this.s.tx.failed = true;
    return msg.error(sqliteErrorToPg(e));
  }

  private async simple(query: string): Promise<Array<Uint8Array>> {
    const out: Array<Uint8Array> = [];
    try {
      const statements = prepare(query, this.s);
      if (!statements.length) out.push(msg.emptyQuery());
      for (const stmt of statements) out.push(...encodeResult(await execute(stmt, [], this.s)));
    } catch (e) {
      out.push(this.error(e));
    }
    out.push(this.ready());
    return out;
  }

  private async extended(r: Reader): Promise<Array<Uint8Array>> {
    switch (r.type) {
      case "P": {
        const name = r.cstr();
        const statements = prepare(r.cstr(), this.s);
        if (statements.length > 1) throw new PgError("42601", "cannot insert multiple commands into a prepared statement");
        const oids = Array.from({ length: r.int16() }, () => r.int32());
        this.statements.set(name, { stmt: statements[0], oids });
        return [msg.parseComplete()];
      }
      case "B": {
        const portal = r.cstr();
        const name = r.cstr();
        const prepared = this.statements.get(name);
        if (!prepared) throw new PgError("26000", `prepared statement "${name}" does not exist`);
        const formats = r.int16();
        for (let i = 0; i < formats; i++) {
          if (r.int16() !== 0) throw new PgError("0A000", "duragres supports only text-format parameters");
        }
        const params: Params = [];
        const n = r.int16();
        for (let i = 0; i < n; i++) {
          const length = r.int32();
          params.push(length < 0 ? null : decodeText(r.bytes(length)));
        }
        this.portals.set(portal, { ...prepared, params, sent: 0, done: false });
        return [msg.bindComplete()];
      }
      case "D": {
        const kind = String.fromCharCode(r.byte());
        const name = r.cstr();
        if (kind === "S") {
          const prepared = this.statements.get(name);
          if (!prepared) throw new PgError("26000", `prepared statement "${name}" does not exist`);
          const n = parameterCount(prepared.stmt);
          const params = Array<null>(n).fill(null);
          return [msg.parameterDescription(Array(n).fill(OID.text)), this.rowDescription(prepared.stmt && describeStatement(prepared.stmt, params, this.s, prepared.oids))];
        }
        const p = this.portal(name);
        return [this.rowDescription(p.result?.kind === "rows" ? p.result.fields : p.stmt && describeStatement(p.stmt, p.params, this.s, p.oids))];
      }
      case "E": {
        const p = this.portal(r.cstr());
        const maxRows = r.int32();
        if (!p.stmt) return [msg.emptyQuery()];
        if (p.done) return [msg.commandComplete(zeroTag(p.result!))];
        p.result ??= await execute(p.stmt, p.params, this.s, p.oids);
        if (p.result.kind !== "rows") {
          p.done = true;
          return encodeResult(p.result, false);
        }
        const rows = p.result.rows.slice(p.sent, maxRows > 0 ? p.sent + maxRows : undefined);
        p.sent += rows.length;
        const out = rows.map((row) => msg.dataRow(row));
        p.done = p.sent === p.result.rows.length;
        out.push(p.done ? msg.commandComplete(p.result.tag.replace(/\d+$/, String(rows.length))) : msg.portalSuspended());
        return out;
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
