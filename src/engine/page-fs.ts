import { BaseFilesystem, ERRNO_CODES } from "@electric-sql/pglite/basefs";
import type { FsStats } from "@electric-sql/pglite/basefs";

const PAGE = 8192;
const S_IFDIR = 0o4_0000;
const S_IFREG = 0o10_0000;

interface Node { id: number; path: string; mode: number; size: number; mtime: number }

const fail = (code: keyof typeof ERRNO_CODES): never => {
  throw Object.assign(new Error(code), { code: ERRNO_CODES[code] });
};
const norm = (p: string) => "/" + p.split("/").filter((s) => s && s !== ".").join("/");
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const isDir = (n: Node) => (n.mode & 0o17_0000) === S_IFDIR;

function createTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_nodes (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_pages (node INTEGER NOT NULL, page INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (node, page)) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

export class PageFs extends BaseFilesystem {
  private nodes = new Map<string, Node>();
  private fds = new Map<number, Node>();
  private nextFd = 1;
  private nextId = 1;
  readonly fresh: boolean;
  stats = { pageReads: 0, pageWrites: 0 };

  private sql: SqlStorage;

  constructor(private storage: DurableObjectStorage) {
    super();
    const sql = (this.sql = storage.sql);
    createTables(sql);
    this.fresh = sql.exec("SELECT 1 FROM fs_meta WHERE key = 'initialized'").toArray().length === 0;
    if (this.fresh) {
      storage.transactionSync(() => {
        sql.exec("DELETE FROM fs_pages");
        sql.exec("DELETE FROM fs_nodes");
        this.insert("/", S_IFDIR | 0o700);
      });
      return;
    }
    for (const row of sql.exec<{ id: number; path: string; mode: number; size: number; mtime: number }>("SELECT * FROM fs_nodes")) {
      this.nodes.set(row.path, { ...row });
      this.nextId = Math.max(this.nextId, row.id + 1);
    }
  }

  markInitialized(database: string) {
    this.storage.transactionSync(() => {
      this.flush();
      this.sql.exec("INSERT OR REPLACE INTO fs_meta VALUES ('initialized', '1'), ('database', ?)", database);
    });
  }

  get database(): string | undefined {
    return this.sql.exec<{ value: string }>("SELECT value FROM fs_meta WHERE key = 'database'").toArray()[0]?.value;
  }
  set database(name: string) {
    this.sql.exec("INSERT OR REPLACE INTO fs_meta VALUES ('database', ?)", name);
  }

  private insert(path: string, mode: number): Node {
    const node = { id: this.nextId++, path, mode, size: 0, mtime: Date.now() };
    this.sql.exec("INSERT INTO fs_nodes VALUES (?, ?, ?, ?, ?)", node.id, path, mode, 0, node.mtime);
    this.nodes.set(path, node);
    return node;
  }
  private save(n: Node) {
    this.sql.exec("UPDATE fs_nodes SET path = ?, mode = ?, size = ?, mtime = ? WHERE id = ?", n.path, n.mode, n.size, n.mtime, n.id);
  }
  private node(path: string): Node {
    return this.nodes.get(norm(path)) ?? fail("ENOENT");
  }
  private fd(fd: number): Node {
    return this.fds.get(fd) ?? fail("EBADF");
  }
  private stat(n: Node): FsStats {
    return { dev: 1, ino: n.id, mode: n.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size: n.size, blksize: PAGE, blocks: Math.ceil(n.size / 512), atime: n.mtime, mtime: n.mtime, ctime: n.mtime };
  }

  private dirty = new Map<string, { node: number; page: number; data: Uint8Array }>();
  private dirtyNodes = new Set<Node>();
  private static readonly FLUSH_AT = 1024;

  private readPage(n: Node, page: number): Uint8Array {
    const buffered = this.dirty.get(`${n.id}:${page}`);
    if (buffered) return buffered.data.slice();
    this.stats.pageReads++;
    const row = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM fs_pages WHERE node = ? AND page = ?", n.id, page).toArray()[0];
    const out = new Uint8Array(PAGE);
    if (row) out.set(new Uint8Array(row.data));
    return out;
  }
  private writePage(n: Node, page: number, data: Uint8Array) {
    this.dirty.set(`${n.id}:${page}`, { node: n.id, page, data });
    if (this.dirty.size >= PageFs.FLUSH_AT) this.flush();
  }
  private dropDirty(n: Node, fromPage = 0) {
    for (const [key, d] of this.dirty) if (d.node === n.id && d.page >= fromPage) this.dirty.delete(key);
  }

  flush(database?: string) {
    if (!this.dirty.size && !this.dirtyNodes.size && database === undefined) return;
    this.storage.transactionSync(() => {
      for (const d of this.dirty.values()) {
        this.stats.pageWrites++;
        this.sql.exec("INSERT OR REPLACE INTO fs_pages VALUES (?, ?, ?)", d.node, d.page, d.data);
      }
      for (const n of this.dirtyNodes) if (this.nodes.get(n.path) === n) this.save(n);
      if (database !== undefined) this.database = database;
    });
    this.dirty.clear();
    this.dirtyNodes.clear();
  }

  lstat(path: string) { return this.stat(this.node(path)); }
  fstat(fd: number) { return this.stat(this.fd(fd)); }

  chmod(path: string, mode: number) {
    const n = this.node(path);
    n.mode = (n.mode & 0o17_0000) | (mode & 0o7777);
    this.save(n);
  }
  utimes(path: string, _atime: number, mtime: number) {
    const n = this.node(path);
    n.mtime = Number(mtime);
    this.save(n);
  }

  mkdir(path: string, { recursive = false, mode = 0o700 } = {}) {
    const p = norm(path);
    const existing = this.nodes.get(p);
    if (existing) {
      if (recursive && isDir(existing)) return;
      fail("EEXIST");
    }
    const parent = this.nodes.get(parentOf(p));
    if (!parent) {
      if (!recursive) fail("ENOENT");
      this.mkdir(parentOf(p), { recursive, mode });
    } else if (!isDir(parent)) fail("ENOTDIR");
    this.insert(p, S_IFDIR | (mode & 0o7777));
  }

  readdir(path: string) {
    const p = norm(path);
    if (!isDir(this.node(p))) fail("ENOTDIR");
    const prefix = p === "/" ? "/" : p + "/";
    const names: Array<string> = [];
    for (const key of this.nodes.keys()) {
      if (key !== p && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) names.push(key.slice(prefix.length));
    }
    return [".", "..", ...names];
  }

  open(path: string, flags = "r", mode = 0o600) {
    const p = norm(path);
    let n = this.nodes.get(p);
    if (n && flags.includes("x")) fail("EEXIST");
    if (!n) {
      if (!flags.includes("w") && !flags.includes("a") && !flags.includes("+")) fail("ENOENT");
      if (!this.nodes.has(parentOf(p))) fail("ENOENT");
      n = this.insert(p, S_IFREG | (mode & 0o7777));
    } else if (isDir(n) && flags !== "r") fail("EISDIR");
    if (flags.startsWith("w")) this.truncate(p, 0);
    const fd = this.nextFd++;
    this.fds.set(fd, n);
    return fd;
  }
  close(fd: number) {
    this.fd(fd);
    this.fds.delete(fd);
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number) {
    const n = this.fd(fd);
    const count = Math.max(0, Math.min(length, n.size - position));
    for (let done = 0; done < count;) {
      const at = position + done;
      const within = at % PAGE;
      const take = Math.min(PAGE - within, count - done);
      buffer.set(this.readPage(n, Math.floor(at / PAGE)).subarray(within, within + take), offset + done);
      done += take;
    }
    return count;
  }

  write(fd: number, data: Uint8Array | ArrayBuffer, offset: number, length: number, position: number) {
    const n = this.fd(fd);
    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (length === 0) return 0;
    for (let done = 0; done < length;) {
      const at = position + done;
      const within = at % PAGE;
      const take = Math.min(PAGE - within, length - done);
      const page = Math.floor(at / PAGE);
      const bytes = take === PAGE ? new Uint8Array(PAGE) : this.readPage(n, page);
      bytes.set(buffer.subarray(offset + done, offset + done + take), within);
      this.writePage(n, page, bytes);
      done += take;
    }
    if (position + length > n.size) n.size = position + length;
    n.mtime = Date.now();
    this.dirtyNodes.add(n);
    return length;
  }

  truncate(path: string, len = 0) {
    const n = this.node(path);
    if (isDir(n)) fail("EISDIR");
    this.flush();
    this.storage.transactionSync(() => {
      if (len < n.size) {
        this.sql.exec("DELETE FROM fs_pages WHERE node = ? AND page >= ?", n.id, Math.ceil(len / PAGE));
        if (len % PAGE) {
          const page = Math.floor(len / PAGE);
          const bytes = this.readPage(n, page);
          bytes.fill(0, len % PAGE);
          this.sql.exec("INSERT OR REPLACE INTO fs_pages VALUES (?, ?, ?)", n.id, page, bytes);
        }
      }
      n.size = len;
      n.mtime = Date.now();
      this.save(n);
    });
  }

  writeFile(path: string, data: string | Uint8Array, { mode = 0o600 } = {}) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const fd = this.open(path, "w", mode);
    try {
      this.write(fd, bytes, 0, bytes.length, 0);
    } finally {
      this.close(fd);
    }
  }

  unlink(path: string) {
    const n = this.node(path);
    if (isDir(n)) fail("EISDIR");
    this.flush();
    this.storage.transactionSync(() => this.remove(n));
  }
  rmdir(path: string) {
    const n = this.node(path);
    if (!isDir(n)) fail("ENOTDIR");
    if (n.path === "/") fail("EINVAL");
    if (this.readdir(n.path).length > 2) fail("ENOTEMPTY");
    this.flush();
    this.storage.transactionSync(() => this.remove(n));
  }
  private remove(n: Node) {
    this.dropDirty(n);
    this.dirtyNodes.delete(n);
    this.sql.exec("DELETE FROM fs_pages WHERE node = ?", n.id);
    this.sql.exec("DELETE FROM fs_nodes WHERE id = ?", n.id);
    this.nodes.delete(n.path);
  }

  rename(oldPath: string, newPath: string) {
    const from = norm(oldPath);
    const to = norm(newPath);
    if (from === to) return;
    const n = this.node(from);
    if (!this.nodes.has(parentOf(to))) fail("ENOENT");
    const existing = this.nodes.get(to);
    if (existing && isDir(existing) && this.readdir(to).length > 2) fail("ENOTEMPTY");
    this.flush();
    this.storage.transactionSync(() => {
      if (existing) this.remove(existing);
      const moved = [n, ...[...this.nodes.values()].filter((m) => m.path.startsWith(from + "/"))];
      for (const m of moved) {
        this.nodes.delete(m.path);
        m.path = to + m.path.slice(from.length);
        this.nodes.set(m.path, m);
        this.save(m);
      }
    });
  }
}

type NodeRow = { id: number; path: string; mode: number; size: number; mtime: number };
export type Chunk = { nodes?: Array<NodeRow>; pages: Array<[number, number, ArrayBuffer]> };

const PAGES_PER_CHUNK = 1024;

export function* exportChunks(sql: SqlStorage): Generator<Chunk> {
  let pages: Chunk["pages"] = [];
  let nodes: Array<NodeRow> | undefined = sql.exec<NodeRow>("SELECT id, path, mode, size, mtime FROM fs_nodes").toArray();
  for (const row of sql.exec<{ node: number; page: number; data: ArrayBuffer }>("SELECT node, page, data FROM fs_pages")) {
    pages.push([row.node, row.page, row.data]);
    if (pages.length === PAGES_PER_CHUNK) {
      yield { nodes, pages };
      nodes = undefined;
      pages = [];
    }
  }
  yield { nodes, pages };
}

export function importChunk(storage: DurableObjectStorage, chunk: Chunk) {
  const sql = storage.sql;
  storage.transactionSync(() => {
    if (chunk.nodes) {
      createTables(sql);
      sql.exec("DELETE FROM fs_meta");
      sql.exec("DELETE FROM fs_pages");
      sql.exec("DELETE FROM fs_nodes");
      for (const n of chunk.nodes) sql.exec("INSERT INTO fs_nodes VALUES (?, ?, ?, ?, ?)", n.id, n.path, n.mode, n.size, n.mtime);
    }
    for (const [node, page, data] of chunk.pages) sql.exec("INSERT INTO fs_pages VALUES (?, ?, ?)", node, page, data);
  });
}

export function finishImport(storage: DurableObjectStorage, database: string) {
  storage.sql.exec("INSERT OR REPLACE INTO fs_meta VALUES ('initialized', '1'), ('database', ?)", database);
}
