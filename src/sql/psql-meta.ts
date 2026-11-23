// Answers for the catalog queries psql 18 sends for \dt, \d <table> and \l.
// The handlers match the exact queries psql sends (see them with `psql -E`).
// Everything is derived from sqlite_master and pragma_table_info().
import { OID, PgError, rows as table } from "../postgres/wire";
import type { Result } from "../postgres/wire";
import type { Session } from "./session";
import { loadCatalog } from "./catalog";

const OID_BASE = 16_384; // first user OID in Postgres
const HIDDEN = /^(sqlite_|_cf_|__|_pg_|_duragres_)/; // SQLite internals, DO metadata, Miniflare's __miniflare_do_name, our shadow catalog

interface Handler {
  name: string;
  re: RegExp;
  run(m: RegExpExecArray, s: Session): Result;
}

interface Rel { oid: number; name: string; kind: "r" | "i"; sql: string | null; tbl: string }

function relations(s: Session): Array<Rel> {
  return [...s.sql.exec("SELECT rowid, type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY rowid").raw()]
    .map(([rowid, type, name, tbl, sql]) => ({ oid: OID_BASE + Number(rowid), name: String(name), kind: type === "table" ? ("r" as const) : ("i" as const), sql: typeof sql === "string" ? sql : null, tbl: String(tbl) }))
    .filter((r) => !HIDDEN.test(r.name) && !HIDDEN.test(r.tbl));
}

/** psql turns `\d users` into `c.relname OPERATOR(pg_catalog.~) '^(users)$'`. */
function namePattern(q: string): RegExp | undefined {
  const m = /relname OPERATOR\(pg_catalog\.~\) '((?:[^']|'')*)'/.exec(q);
  return m ? new RegExp(m[1].replaceAll('\'\'', "'")) : undefined;
}

function relByOid(q: string, s: Session): Rel | undefined {
  const m = /(?:c\.oid|attrelid|indrelid|conrelid|i\.inhrelid|inhparent|polrelid|stxrelid|prrelid|adrelid) = '(\d+)'/.exec(q);
  return m ? relations(s).find((r) => r.oid === Number(m[1])) : undefined;
}

/** Postgres-flavoured type name for a SQLite declared type, for \d output. */
function formatType(decl: string): string {
  const t = decl.toUpperCase();
  if (t === "INTEGER" || t === "INT") return "integer";
  if (t === "TEXT") return "text";
  if (t === "BOOLEAN") return "boolean";
  if (t === "JSON") return "jsonb";
  if (t === "REAL" || t === "DOUBLE") return "double precision";
  return decl.toLowerCase() || "text";
}

interface Column { name: string; type: string; notnull: boolean; dflt: string | null; pk: boolean }

function columns(s: Session, r: Rel): Array<Column> {
  const autoinc = /AUTOINCREMENT/i.test(r.sql ?? "");
  const declared = new Map((loadCatalog(s.sql).get(r.name) ?? []).map((c) => [c.name, c.type.name]));
  return [...s.sql.exec("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?)", r.name).raw()].map(([name, type, nn, dflt, pk]) => {
    const serial = Boolean(pk) && autoinc && String(type).toUpperCase() === "INTEGER";
    return {
      name: String(name),
      type: declared.get(String(name)) ?? formatType(String(type)),
      notnull: Boolean(nn) || Boolean(pk),
      dflt: serial ? `nextval('${r.name}_${name}_seq'::regclass)` : pgDefault(typeof dflt === "string" ? dflt : null),
      pk: Boolean(pk),
    };
  });
}

/** Show patched defaults the way the user wrote them. */
function pgDefault(d: string | null): string | null {
  if (d === null) return null;
  if (/randomblob\(4\)/.test(d)) return "gen_random_uuid()";
  if (/^CURRENT_TIMESTAMP$/i.test(d) || /strftime\('%Y-%m-%d %H:%M:%f', 'now'\)/.test(d)) return "now()";
  if (/^(TRUE|FALSE)$/i.test(d)) return d.toLowerCase();
  return d;
}

interface Index { name: string; unique: boolean; primary: boolean; cols: Array<string> }

/** Indexes as Postgres would name them: SQLite autoindexes become <table>_<col>_key / _pkey. */
function indexes(s: Session, r: Rel): Array<Index> {
  const out: Array<Index> = [];
  const pk = columns(s, r).filter((c) => c.pk).map((c) => c.name);
  const list = [...s.sql.exec("SELECT name, \"unique\", origin FROM pragma_index_list(?)", r.name).raw()];
  if (pk.length && !list.some(([, , origin]) => origin === "pk")) out.push({ name: `${r.name}_pkey`, unique: true, primary: true, cols: pk });
  for (const [name, unique, origin] of list) {
    const cols = [...s.sql.exec("SELECT name FROM pragma_index_info(?)", name).raw()].map(([c]) => String(c));
    const pgName = origin === "pk" ? `${r.name}_pkey` : origin === "u" ? `${r.name}_${cols.join("_")}_key` : String(name);
    out.push({ name: pgName, unique: Boolean(unique), primary: origin === "pk", cols });
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

interface ForeignKey { name: string; from: string; to: string; def: string }

function foreignKeys(s: Session, r: Rel): Array<ForeignKey> {
  const rows = [...s.sql.exec('SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq', r.name).raw()];
  return rows.map(([, to, from, toCol]) => ({
    name: `${r.name}_${from}_fkey`,
    from: r.name,
    def: `FOREIGN KEY (${from}) REFERENCES ${to}(${toCol ?? "id"})`,
    to: String(to),
  }));
}

const HANDLERS: Array<Handler> = [
  {
    name: String.raw`\dt`,
    re: /FROM pg_catalog\.pg_class c[\s\S]*WHERE c\.relkind IN \('r','p',''\)/,
    run: (_m, s) => {
      const q = _m.input;
      const pat = namePattern(q);
      const rows = relations(s).filter((r) => r.kind === "r" && (!pat || pat.test(r.name))).sort((a, b) => a.name.localeCompare(b.name));
      return table([["Schema", OID.name], ["Name", OID.name], ["Type", OID.text], ["Owner", OID.name]], rows.map((r) => ["public", r.name, "table", s.user]));
    },
  },
  {
    name: String.raw`\d lookup`,
    re: /^SELECT c\.oid,\s+n\.nspname,\s+c\.relname\s+FROM pg_catalog\.pg_class c/,
    run: (m, s) => {
      const pat = namePattern(m.input);
      const rows = relations(s).filter((r) => !pat || pat.test(r.name));
      return table([["oid", OID.oid], ["nspname", OID.name], ["relname", OID.name]], rows.map((r) => [r.oid, "public", r.name]));
    },
  },
  {
    name: String.raw`\l`,
    re: /FROM pg_catalog\.pg_database d/,
    run: (_m, s) =>
      table(
        [["Name", OID.name], ["Owner", OID.name], ["Encoding", OID.name], ["Locale Provider", OID.text], ["Collate", OID.name], ["Ctype", OID.name], ["Locale", OID.text], ["ICU Rules", OID.text], ["Access privileges", OID.text]],
        [[s.database, s.user, "UTF8", "builtin", "C", "C", null, null, null]],
      ),
  },
  {
    name: String.raw`\d relation flags`,
    re: /^SELECT c\.relchecks, c\.relkind, c\.relhasindex/,
    run: (m, s) => {
      const r = relByOid(m.input, s);
      if (!r) return table([], [], "SELECT 0");
      const hasIndex = r.kind === "r" && indexes(s, r).length ? "t" : "f";
      const cols: Array<[string, number]> = ["relchecks", "relkind", "relhasindex", "relhasrules", "relhastriggers", "relrowsecurity", "relforcerowsecurity", "relhasoids", "relispartition", "?column?", "reltablespace", "reloftype", "relpersistence", "relreplident", "amname"].map((n) => [n, OID.text]);
      return table(cols, [[0, r.kind, hasIndex, "f", "f", "f", "f", "f", "f", "", 0, "", "p", "d", r.kind === "r" ? "heap" : "btree"]]);
    },
  },
  {
    name: String.raw`\d columns`,
    re: /^SELECT a\.attname,\s+pg_catalog\.format_type\(a\.atttypid, a\.atttypmod\)/,
    run: (m, s) => {
      const r = relByOid(m.input, s);
      const cols = r ? columns(s, r) : [];
      return table(
        [["attname", OID.name], ["format_type", OID.text], ["pg_get_expr", OID.text], ["attnotnull", OID.bool], ["attcollation", OID.name], ["attidentity", OID.char], ["attgenerated", OID.char]],
        cols.map((c) => [c.name, c.type, c.dflt, c.notnull ? "t" : "f", null, "", ""]),
      );
    },
  },
  {
    name: String.raw`\d indexes`,
    re: /^SELECT c2\.relname, i\.indisprimary, i\.indisunique/,
    run: (m, s) => {
      const r = relByOid(m.input, s);
      const cols: Array<[string, number]> = ["relname", "indisprimary", "indisunique", "indisclustered", "indisvalid", "pg_get_indexdef", "pg_get_constraintdef", "contype", "condeferrable", "condeferred", "indisreplident", "reltablespace", "conperiod"].map((n) => [n, OID.text]);
      const tf = (b: boolean) => (b ? "t" : "f");
      const rows = (r ? indexes(s, r) : []).map((ix) => {
        const constraint = ix.primary ? `PRIMARY KEY (${ix.cols.join(", ")})` : ix.name.endsWith("_key") ? `UNIQUE (${ix.cols.join(", ")})` : null;
        const def = `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${ix.name} ON public.${r!.name} USING btree (${ix.cols.join(", ")})`;
        return [ix.name, tf(ix.primary), tf(ix.unique), "f", "t", def, constraint, ix.primary ? "p" : constraint ? "u" : null, "f", "f", "f", 0, "f"];
      });
      return table(cols, rows);
    },
  },
  {
    name: String.raw`\d foreign keys`,
    re: /^SELECT true as sametable, conname,/,
    run: (m, s) => {
      const r = relByOid(m.input, s);
      return table([["sametable", OID.bool], ["conname", OID.name], ["condef", OID.text], ["ontable", OID.text]], (r ? foreignKeys(s, r) : []).map((fk) => ["t", fk.name, fk.def, fk.from]));
    },
  },
  {
    name: String.raw`\d referenced by`,
    re: /^SELECT conname, conrelid::pg_catalog\.regclass AS ontable,[\s\S]*WHERE confrelid IN/,
    run: (m, s) => {
      const id = /pg_partition_ancestors\('(\d+)'\)/.exec(m.input)?.[1];
      const target = relations(s).find((r) => r.oid === Number(id));
      const rows = target
        ? relations(s).filter((r) => r.kind === "r").flatMap((r) => foreignKeys(s, r).filter((fk) => fk.to === target.name).map((fk) => [fk.name, fk.from, fk.def]))
        : [];
      return table([["conname", OID.name], ["ontable", OID.text], ["condef", OID.text]], rows);
    },
  },
  {
    // \d also asks for row-level policies, extended statistics, publications and table
    // inheritance. Duragres has none of these, so the true answer is no rows.
    name: String.raw`\d empty catalogs`,
    re: /\bFROM pg_catalog\.(pg_policy|pg_statistic_ext|pg_publication|pg_class c, pg_catalog\.pg_inherits)\b/,
    run: () => table([], [], "SELECT 0"),
  },
];

/** The answer to a query that reads pg_catalog; unsupported ones fail with 0A000. */
export function answerCatalogQuery(sql: string, s: Session): Result {
  for (const h of HANDLERS) {
    const m = h.re.exec(sql);
    if (m) return h.run(m, s);
  }
  throw new PgError("0A000", "duragres does not support this pg_catalog query");
}
