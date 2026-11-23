import { DurableObject } from "cloudflare:workers";
import { PostgresConnection } from "pg-gateway";
import type { Env } from "../env";
import { initPolyglot } from "../sql/polyglot";
import { SERVER_VERSION, type Session } from "../sql/intercept";
import { Protocol } from "../postgres/protocol";
import { closeQuietly, refuse } from "../postgres/socket";
import { msg } from "../postgres/wire";
import { capture, restore } from "./snapshot";
import { CATALOG_DDL } from "../sql/catalog";
import { config, humanDuration, initialise, readMeta, type Meta } from "./lifecycle";

// ParameterStatus values psql/node-postgres look at, sent after AuthenticationOk.
const STARTUP_PARAMS: [string, string][] = [
  ["server_encoding", "UTF8"], ["client_encoding", "UTF8"], ["DateStyle", "ISO, MDY"],
  ["integer_datetimes", "on"], ["standard_conforming_strings", "on"], ["TimeZone", "UTC"],
  ["application_name", ""], ["IntervalStyle", "postgres"], ["is_superuser", "on"],
  ["session_authorization", "demo"],
];

interface Connection { terminate(code: string, message: string): Promise<void> }

export class PgDO extends DurableObject<Env> {
  private connections = new Set<Connection>();
  private meta?: Promise<{ meta: Meta; created: boolean } | { refused: string }>;

  /** Metadata for this database, creating it on first use (subject to the global creation cap). */
  private async ensureDatabase(name: string) {
    this.meta ??= this.loadOrCreate(name);
    const r = await this.meta.catch((e) => { this.meta = undefined; throw e; });
    if ("refused" in r) this.meta = undefined; // a refusal must not stick
    else if (r.created) this.meta = Promise.resolve({ meta: r.meta, created: false }); // only the creating connection gets the NOTICE
    return r;
  }

  private async loadOrCreate(name: string): Promise<{ meta: Meta; created: boolean } | { refused: string }> {
    const existing = readMeta(this.ctx.storage.sql);
    if (existing) return { meta: existing, created: false };
    const cfg = config(this.env);
    if (!(await this.env.LIMITS.getByName("global").tryCreateDatabase(cfg.maxNewPerHour))) {
      return { refused: `duragres: database creation limit reached (${cfg.maxNewPerHour} per hour), try again later` };
    }
    return { meta: await initialise(this.ctx.storage, name, cfg.ttlSeconds), created: true };
  }

  /** One Postgres client connection. The Worker already answered SSLRequest and replays the StartupMessage. */
  async connect(socket: Socket): Promise<void> {
    const cfg = config(this.env);
    const name = this.ctx.id.name ?? "postgres";
    if (this.connections.size >= cfg.maxConnections) return refuse(socket, "53300", "sorry, too many clients already");
    const db = await this.ensureDatabase(name);
    if ("refused" in db) return refuse(socket, "53400", db.refused);

    await initPolyglot();
    const sql = this.ctx.storage.sql;
    sql.exec(CATALOG_DDL);
    const env = this.env;
    const storage = this.ctx.storage;
    let protocol: Protocol | undefined;
    let idle: number | null = null;
    let closed = false;

    const self: Connection = {
      async terminate(code, message) {
        if (closed) return;
        closed = true;
        clearTimeout(idle);
        await conn.streamWriter?.write(msg.fatal(code, message)).catch(() => { });
        await closeQuietly(socket);
      },
    };
    const touch = () => {
      clearTimeout(idle);
      if (cfg.idleSeconds > 0) idle = setTimeout(() => void self.terminate("57P05", "terminating connection due to idle-session timeout"), cfg.idleSeconds * 1000);
    };

    // With allowHalfOpen the socket stays open after the client stops sending; treat
    // end of input as the end of the connection so its slot is freed immediately.
    let inputEnded!: () => void;
    const clientGone = new Promise<void>((r) => (inputEnded = r));
    const input = socket.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => inputEnded() }));

    const conn: PostgresConnection = new PostgresConnection(
      { readable: input, writable: socket.writable },
      {
        serverVersion: SERVER_VERSION,
        auth: { method: "trust" },
        async onAuthenticated(state) {
          const params = state.clientParams!;
          for (const [k, v] of STARTUP_PARAMS) await conn.streamWriter!.write(msg.parameterStatus(k, v));
          // Shown by psql at connect time, like Postgres' own login notices.
          if (db.created) await conn.streamWriter!.write(msg.notice(cfg.notice.replace("{db}", name).replace("{ttl}", humanDuration(cfg.ttlSeconds))));
          const session: Session = { sql, storage, database: name, user: params.user };
          protocol = new Protocol(session, env.LOG_SQL ? (l) => console.log(`[${name}] ${l.replace(/\s+/g, " ").slice(0, 400)}`) : undefined);
          touch();
        },
        onMessage: (data, state) => {
          if (!state.isAuthenticated || !protocol) return undefined;
          touch();
          return protocol.handle(data);
        },
      },
    );
    this.connections.add(self);
    try {
      const peerClosed = socket.closed.then(() => true, () => true);
      const first = await Promise.race([peerClosed, clientGone.then(() => false)]);
      // Client stopped sending: finish our side with a FIN (half-close) instead of
      // socket.close(), which workerd reports as an error once the peer is gone.
      if (!first) await socket.writable.close().catch(() => { });
    } finally {
      closed = true;
      clearTimeout(idle);
      this.connections.delete(self);
    }
  }

  /** Expiry: unclaimed databases are deleted when their TTL alarm fires. */
  async alarm() {
    const meta = readMeta(this.ctx.storage.sql);
    if (!meta || meta.claimed) return;
    if (Date.now() < Date.parse(meta.expiresAt)) {
      await this.ctx.storage.setAlarm(Date.parse(meta.expiresAt));
      return;
    }
    await Promise.all([...this.connections].map((c) => c.terminate("57P01", `duragres: database "${meta.name}" expired and was deleted`)));
    await this.ctx.storage.deleteAll();
    this.meta = undefined;
    console.log(`duragres: expired and deleted "${meta.name}"`);
  }

  async saveSnapshot(key: string) {
    const bucket = this.env.SNAPSHOTS;
    if (!bucket) throw new Error("Snapshot bucket is unavailable");
    const meta = readMeta(this.ctx.storage.sql);
    if (!meta || (!meta.claimed && Date.now() >= Date.parse(meta.expiresAt))) return false;
    const body = JSON.stringify(capture(this.ctx.storage));
    if (new TextEncoder().encode(body).byteLength > 1024 * 1024) throw new Error("Snapshot exceeds the 1 MiB limit");
    await bucket.put(key, body);
    return true;
  }

  async loadSnapshot(key: string) {
    const object = await this.env.SNAPSHOTS?.get(key);
    if (!object) throw new Error("Snapshot is unavailable");
    const snapshot = await object.json<ReturnType<typeof capture>>();
    await this.ctx.blockConcurrencyWhile(async () => {
      if (readMeta(this.ctx.storage.sql) || this.meta) throw new Error("Fork destination already exists");
      const name = this.ctx.id.name;
      if (!name) throw new Error("Fork destination needs a name");
      await initialise(this.ctx.storage, name, config(this.env).ttlSeconds);
      restore(this.ctx.storage, snapshot);
    });
  }
}
