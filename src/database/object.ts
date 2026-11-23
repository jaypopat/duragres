import { DurableObject } from "cloudflare:workers";
import { PostgresConnection } from "pg-gateway";
import { initPolyglot } from "../sql/polyglot";
import { SERVER_VERSION, type Session } from "../sql/session";
import { Protocol } from "../postgres/protocol";
import { closeQuietly, refuse } from "../postgres/socket";
import { msg } from "../postgres/wire";
import { capture, restore, type Snapshot } from "./snapshot";
import { createDatabase, createNotice, isLive, readMeta } from "./lifecycle";

// ParameterStatus values psql/node-postgres look at, sent after AuthenticationOk.
const STARTUP_PARAMS: [string, string][] = [
  ["server_encoding", "UTF8"], ["client_encoding", "UTF8"], ["DateStyle", "ISO, MDY"],
  ["integer_datetimes", "on"], ["standard_conforming_strings", "on"], ["TimeZone", "UTC"],
  ["application_name", ""], ["IntervalStyle", "postgres"], ["is_superuser", "on"],
];

const SNAPSHOT_LIMIT = 1024 * 1024;

type Terminate = (code: string, message: string) => Promise<void>;

/** One Postgres database. Its name is the Durable Object name. */
export class PgDO extends DurableObject<Env> {
  private connections = new Set<Terminate>();
  private expiring = false; // set while alarm() closes connections and deletes storage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(initPolyglot);
  }

  private get name() {
    const name = this.ctx.id.name;
    if (!name) throw new Error("PgDO must be addressed by name");
    return name;
  }

  /** One client connection. The gateway already answered SSLRequest and replays the StartupMessage. */
  async connect(socket: Socket): Promise<void> {
    const { ttlSeconds, idleSeconds, maxConnections } = this.env.LIMITS;
    if (this.expiring) return refuse(socket, "57P03", "duragres: the database is being deleted, try again");
    if (this.connections.size >= maxConnections) return refuse(socket, "53300", "sorry, too many clients already");

    const name = this.name;
    const existing = readMeta(this.ctx.storage);
    const created = !existing;
    if (created) createDatabase(this.ctx.storage, name, ttlSeconds);

    let protocol: Protocol | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const terminate: Terminate = async (code, message) => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      await conn.streamWriter?.write(msg.fatal(code, message)).catch(() => {});
      await closeQuietly(socket);
    };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => void terminate("57P05", "terminating connection due to idle-session timeout"), idleSeconds * 1000);
    };

    // With allowHalfOpen the socket stays open after the client stops sending; treat
    // end of input as the end of the connection so its slot is freed immediately.
    const { promise: inputEnded, resolve: endInput } = Promise.withResolvers<void>();
    const input = socket.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => endInput() }));

    const conn: PostgresConnection = new PostgresConnection(
      { readable: input, writable: socket.writable },
      {
        serverVersion: SERVER_VERSION,
        auth: { method: "trust" },
        onAuthenticated: async (state) => {
          const writer = conn.streamWriter!;
          const user = state.clientParams!.user;
          for (const [k, v] of [...STARTUP_PARAMS, ["session_authorization", user]]) await writer.write(msg.parameterStatus(k, v));
          if (created) await writer.write(msg.notice(createNotice(name, ttlSeconds)));
          const session: Session = { sql: this.ctx.storage.sql, storage: this.ctx.storage, database: name, user };
          protocol = new Protocol(session);
          touch();
        },
        onMessage: (data, state) => {
          if (!state.isAuthenticated || !protocol) return undefined;
          touch();
          return protocol.handle(data);
        },
      },
    );

    this.connections.add(terminate);
    try {
      const peerClosed = socket.closed.then(() => true, () => true);
      // Client stopped sending: finish our side with a FIN (half-close) instead of
      // socket.close(), which workerd reports as an error once the peer is gone.
      if (!(await Promise.race([peerClosed, inputEnded.then(() => false)]))) await socket.writable.close().catch(() => {});
    } finally {
      closed = true;
      clearTimeout(idle);
      this.connections.delete(terminate);
    }
  }

  /** Expiry: unclaimed databases are deleted when their TTL alarm fires. */
  async alarm() {
    const meta = readMeta(this.ctx.storage);
    if (!meta) return;
    if (isLive(meta)) {
      if (!meta.claimed) await this.ctx.storage.setAlarm(meta.expiresAt);
      return;
    }
    this.expiring = true;
    try {
      await Promise.all([...this.connections].map((terminate) => terminate("57P01", `duragres: database "${meta.name}" expired and was deleted`)));
      await this.ctx.storage.deleteAll();
    } finally {
      this.expiring = false;
    }
  }

  /** Writes this database to R2 for a fork. Returns false if it does not exist. */
  async saveSnapshot(key: string): Promise<boolean> {
    const meta = readMeta(this.ctx.storage);
    if (!meta || !isLive(meta)) return false;
    const body = JSON.stringify(capture(this.ctx.storage));
    if (new TextEncoder().encode(body).byteLength > SNAPSHOT_LIMIT) throw new Error("Snapshot exceeds the 1 MiB limit");
    await this.env.SNAPSHOTS.put(key, body);
    return true;
  }

  /** Creates this database from a snapshot in R2. */
  async loadSnapshot(key: string): Promise<void> {
    const object = await this.env.SNAPSHOTS.get(key);
    if (!object) throw new Error("Snapshot is unavailable");
    const snapshot = await object.json<Snapshot>();
    if (readMeta(this.ctx.storage)) throw new Error("Fork destination already exists");
    restore(this.ctx.storage, snapshot);
    createDatabase(this.ctx.storage, this.name, this.env.LIMITS.ttlSeconds, false);
  }
}
