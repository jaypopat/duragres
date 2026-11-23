import { DurableObject } from "cloudflare:workers";
import { PostgresConnection } from "pg-gateway";
import { initPolyglot } from "../sql/polyglot";
import { WriterLock } from "../sql/lock";
import { SERVER_VERSION, type Databases, type Session } from "../sql/session";
import { Protocol } from "../postgres/protocol";
import { closeQuietly, refuse } from "../postgres/socket";
import { msg, PgError } from "../postgres/wire";
import { capture, restore, type Snapshot } from "./snapshot";
import { createDatabase, createNotice, isLive, readMeta } from "./lifecycle";

// ParameterStatus values psql/node-postgres look at, sent after AuthenticationOk.
const STARTUP_PARAMS: Array<[string, string]> = [
  ["server_encoding", "UTF8"], ["client_encoding", "UTF8"], ["DateStyle", "ISO, MDY"],
  ["integer_datetimes", "on"], ["standard_conforming_strings", "on"], ["TimeZone", "UTC"],
  ["application_name", ""], ["IntervalStyle", "postgres"], ["is_superuser", "on"],
];

type Terminate = (code: string, message: string) => Promise<void>;

/** One Postgres database. Its name is the Durable Object name. */
export class PgDO extends DurableObject<Env> {
  private connections = new Set<Terminate>();
  private deleting = false; // set while destroy() closes connections and deletes storage
  private lock = new WriterLock();

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
    if (this.deleting) return refuse(socket, "57P03", "duragres: the database is being deleted, try again");
    if (this.connections.size >= maxConnections) return refuse(socket, "53300", "sorry, too many clients already");

    const name = this.name;
    const existing = readMeta(this.ctx.storage);
    const created = !existing;
    if (created) createDatabase(this.ctx.storage, name, ttlSeconds);

    let session: Session | undefined;
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
          session = { sql: this.ctx.storage.sql, storage: this.ctx.storage, database: name, user, lock: this.lock, databases: this.databases, isolation: "read committed" };
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
      // A connection that goes away mid-transaction rolls it back, which frees the lock.
      if (session) this.lock.release(session);
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
    await this.destroy("57P01", `duragres: database "${meta.name}" expired and was deleted`);
  }

  /** Closes every connection and deletes all storage, refusing new connections meanwhile. */
  private async destroy(code: string, message: string) {
    this.deleting = true;
    try {
      await Promise.all([...this.connections].map((terminate) => terminate(code, message)));
      await this.ctx.storage.deleteAll();
    } finally {
      this.deleting = false;
    }
  }

  /** CREATE/DROP DATABASE run by a connection to this database, on another one. */
  private databases: Databases = {
    create: async (name, copy) => {
      // Bounds how fast one database can spawn branches.
      if (!(await this.env.CONNECT_LIMIT.limit({ key: `create:${this.name}` })).success) {
        throw new PgError("53400", "duragres: too many new databases from this one, try again in a minute");
      }
      return this.env.PG.getByName(name).create(copy ? capture(this.ctx.storage) : null);
    },
    drop: (name, force) => this.env.PG.getByName(name).drop(force),
  };

  // --- RPC from other databases

  /** Creates this database, empty or from another database's snapshot. */
  async create(snapshot: Snapshot | null): Promise<"created" | "exists"> {
    if (readMeta(this.ctx.storage)) return "exists";
    if (snapshot) restore(this.ctx.storage, snapshot);
    createDatabase(this.ctx.storage, this.name, this.env.LIMITS.ttlSeconds, !snapshot);
    return "created";
  }

  /** Deletes this database. It is in use while it has connections, unless `force` closes them. */
  async drop(force: boolean): Promise<"dropped" | "missing" | "in-use"> {
    if (!readMeta(this.ctx.storage)) return "missing";
    if (this.connections.size && !force) return "in-use";
    await this.destroy("57P01", "terminating connection due to administrator command");
    return "dropped";
  }
}
