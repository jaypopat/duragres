import { DurableObject } from "cloudflare:workers";
import { PostgresConnection } from "pg-gateway";
import type { ScramSha256Data } from "pg-gateway";
import { EngineFailure, Postgres } from "../engine/postgres";
import { finishImport, importChunk } from "../engine/page-fs";
import type { Chunk } from "../engine/page-fs";
import { Pool } from "../engine/pool";
import type { Client } from "../engine/pool";
import { databaseCommand, isCopyFromStdin, sqlText } from "../postgres/messages";
import type { DatabaseCommand } from "../postgres/messages";
import { byteStreams, closeQuietly, refuse } from "../postgres/socket";
import { msg, PgError } from "../postgres/wire";
import { createDatabase, createNotice, NAME_RULE, readMeta, validName, writeMeta } from "./lifecycle";
import type { Meta } from "./lifecycle";

type Terminate = (code: string, message: string) => Promise<void>;
const SYNC = 0x53;

// Schema-qualified so a client's temp table named pg_authid cannot shadow the catalog.
const LOGIN_PASSWORDS = `FROM pg_catalog.pg_authid
  WHERE rolcanlogin AND rolpassword IS NOT NULL AND (rolvaliduntil IS NULL OR rolvaliduntil > now())`;

export class PgDO extends DurableObject<Env> {
  private connections = new Set<Terminate>();
  private deleting = false;
  private engine?: Promise<{ pg: Postgres; pool: Pool }>;

  private get name() {
    const name = this.ctx.id.name;
    if (!name) throw new Error("PgDO must be addressed by name");
    return name;
  }

  private start() {
    return (this.engine ??= Postgres.open(this.ctx.storage, this.name).then((pg) => ({ pg, pool: new Pool(pg) })).catch((error: unknown) => {
      this.engine = undefined;
      throw error;
    }));
  }

  private fail(error: unknown): never {
    if (error instanceof EngineFailure) this.ctx.abort(error.message);
    throw error;
  }

  async connect(socket: Socket): Promise<void> {
    const { ttlSeconds, idleSeconds, maxConnections } = this.env.LIMITS;
    if (this.deleting) return refuse(socket, "57P03", "duragres: the database is being deleted, try again");
    if (this.connections.size >= maxConnections) return refuse(socket, "53300", "sorry, too many clients already");
    const meta = readMeta(this.ctx.storage);
    if (meta?.importing) return refuse(socket, "57P03", "duragres: the database is still being copied, try again");

    let conn: PostgresConnection | undefined;
    let client: Client | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const terminate: Terminate = async (code, message) => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      await conn?.streamWriter?.write(msg.fatal(code, message)).catch(() => {});
      await closeQuietly(socket);
    };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => void terminate("57P05", "terminating connection due to idle-session timeout"), idleSeconds * 1000);
    };
    // Claim the slot and arm the idle timer before the first await so bursts cannot bypass the cap or stall auth.
    this.connections.add(terminate);
    touch();

    try {
      const name = this.name;
      const created = !meta;
      if (created) createDatabase(this.ctx.storage, name, ttlSeconds);
      const { pg, pool } = await this.start();
      if (this.deleting || closed) return void (await terminate("57P03", "duragres: the database is being deleted, try again"));
      const passwords = await this.protected(pool, pg);

      // With allowHalfOpen, treat client EOF as disconnect so the connection slot frees immediately.
      const { promise: inputEnded, resolve: endInput } = Promise.withResolvers<void>();
      const streams = byteStreams(socket);
      const input = streams.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: () => endInput() }));
      let discarding = false;

      const connection: PostgresConnection = new PostgresConnection(
        { readable: input, writable: streams.writable },
        {
          auth: passwords
            ? { method: "scram-sha-256", getScramSha256Data: ({ username }) => this.verifier(pool, pg, username) }
            : { method: "trust" },
          onAuthenticated: async (state) => {
            const writer = connection.streamWriter;
            const user = state.clientParams?.user;
            if (!writer || user === undefined) throw new Error("pg-gateway authenticated a connection with no stream or user");
            client = await pool.connect(user, (code, message) => void terminate(code, message));
            for (const status of parameterStatus(pg, user, state.clientParams?.application_name ?? "")) await writer.write(status);
            if (created) await writer.write(msg.notice(createNotice(name, ttlSeconds)));
            touch();
          },
          onMessage: async (data, state) => {
            if (!state.isAuthenticated || !client || data[0] === 0x58) return undefined;
            touch();
            if (discarding) {
              if (data[0] !== SYNC) return new Uint8Array(0);
              discarding = false;
              return msg.readyForQuery(client.status());
            }
            const sql = sqlText(data);
            if (sql !== undefined) {
              const simple = data[0] === 0x51;
              const refusal = await this.intercept(sql, simple, client);
              if (refusal) {
                discarding = !simple;
                return refusal;
              }
            }
            return client.send(data).catch((error: unknown) => this.fail(error));
          },
        },
      );
      conn = connection;

      const peerClosed = socket.closed.then(() => true, () => true);
      // Half-close on client EOF instead of socket.close(), which workerd errors on once the peer is gone.
      if (!(await Promise.race([peerClosed, inputEnded.then(() => false)]))) await socket.writable.close().catch(() => {});
    } finally {
      closed = true;
      clearTimeout(idle);
      this.connections.delete(terminate);
      await client?.close().catch((error: unknown) => this.fail(error));
    }
  }

  private async intercept(sql: string, simple: boolean, client: Client): Promise<Uint8Array | undefined> {
    let command: DatabaseCommand | undefined;
    try {
      // PGlite reads COPY FROM STDIN from the command buffer itself and exits the backend.
      if (isCopyFromStdin(sql)) throw new PgError("0A000", "COPY FROM STDIN is not supported; use INSERT, or COPY FROM a file");
      command = databaseCommand(sql);
      if (!command) return undefined;
      if (!simple) throw new PgError("0A000", `${command.kind === "create" ? "CREATE" : "DROP"} DATABASE must be sent as a simple query`);
      if (client.status() !== "I") throw new PgError("25001", `${command.kind === "create" ? "CREATE" : "DROP"} DATABASE cannot run inside a transaction block`);
      const tag = await this.runDatabaseCommand(command);
      return reply(msg.commandComplete(tag), msg.readyForQuery("I"));
    } catch (error) {
      if (!(error instanceof PgError)) throw error;
      return simple ? reply(msg.error(error), msg.readyForQuery(client.status())) : msg.error(error);
    }
  }

  private async runDatabaseCommand(command: DatabaseCommand): Promise<string> {
    if (!validName(command.name)) {
      throw new PgError("42602", `invalid database name "${command.name}" (${NAME_RULE})`);
    }
    const target = this.env.PG.getByName(command.name);
    if (command.kind === "drop") {
      if (command.name === this.name) throw new PgError("55006", "cannot drop the currently open database");
      const outcome = await target.drop(command.force, this.name);
      if (outcome === "missing" && !command.ifExists) throw new PgError("3D000", `database "${command.name}" does not exist`);
      if (outcome === "in-use") throw new PgError("55006", `database "${command.name}" is being accessed by other users; use DROP DATABASE ... WITH (FORCE)`);
      if (outcome === "protected") {
        throw new PgError("42501", `database "${command.name}" has passwords; remove them there (ALTER ROLE ... PASSWORD NULL) to drop it from elsewhere`);
      }
      return "DROP DATABASE";
    }

    if (command.template !== undefined && command.template !== this.name) {
      throw new PgError("0A000", `connect to "${command.template}" to use it as a template`);
    }
    if (!(await this.env.CONNECT_LIMIT.limit({ key: `create:${this.name}` })).success) {
      throw new PgError("53400", "duragres: too many new databases from this one, try again in a minute");
    }
    if ((await target.reserve(command.template !== undefined)) === "exists") throw new PgError("42P04", `database "${command.name}" already exists`);
    if (command.template !== undefined) {
      const { pg, pool } = await this.start();
      try {
        const inherited = await pool.hold(async () => {
          for await (const chunk of pg.chunks()) await target.receive(chunk);
          return (await pg.query<{ rolpassword: string }>(`SELECT rolpassword ${LOGIN_PASSWORDS}`)).map((r) => r.rolpassword);
        });
        await target.finish(this.name, inherited);
      } catch (error) {
        await target.drop(true, this.name).catch(() => {});
        throw new PgError("XX000", `copying "${this.name}" failed: ${String(error)}`);
      }
    }
    return "CREATE DATABASE";
  }

  async reserve(copy: boolean): Promise<"created" | "exists"> {
    if (readMeta(this.ctx.storage)) return "exists";
    createDatabase(this.ctx.storage, this.name, this.env.LIMITS.ttlSeconds, copy);
    return "created";
  }

  async receive(chunk: Chunk) {
    if (!readMeta(this.ctx.storage)?.importing) throw new Error("not importing");
    importChunk(this.ctx.storage, chunk);
  }

  async finish(source: string, inherited: Array<string>) {
    const meta = readMeta(this.ctx.storage);
    if (!meta?.importing) throw new Error("not importing");
    finishImport(this.ctx.storage, source);
    writeMeta(this.ctx.storage, { ...meta, importing: false, source, inherited });
  }

  async drop(force: boolean, from: string): Promise<"dropped" | "missing" | "in-use" | "protected"> {
    const meta = readMeta(this.ctx.storage);
    if (!meta) return "missing";
    // Source database may always drop its copies; anyone else only while it has no passwords.
    if (!meta.importing && meta.source !== from) {
      const { pg, pool } = await this.start();
      if (await this.protected(pool, pg)) return "protected";
    }
    if (this.connections.size && !force) return "in-use";
    await this.destroy("57P01", "terminating connection due to administrator command");
    return "dropped";
  }

  async alarm() {
    const meta = readMeta(this.ctx.storage);
    if (!meta) return;
    if (Date.now() < meta.expiresAt) return void (await this.ctx.storage.setAlarm(meta.expiresAt));
    if (!meta.importing) {
      const { pg, pool } = await this.start();
      if (await this.claimed(pool, pg, meta)) return;
    }
    await this.destroy("57P01", `duragres: database "${meta.name}" expired and was deleted`);
  }

  private async destroy(code: string, message: string) {
    this.deleting = true;
    try {
      await Promise.all([...this.connections].map((terminate) => terminate(code, message)));
      const engine = await this.engine?.catch(() => undefined);
      this.engine = undefined;
      engine?.pool.dispose();
      await engine?.pg.close().catch(() => {});
      await this.ctx.storage.deleteAll();
    } finally {
      this.deleting = false;
    }
  }

  private async protected(pool: Pool, pg: Postgres) {
    return pool.hold(async () => (await pg.query(`SELECT 1 ${LOGIN_PASSWORDS} LIMIT 1`)).length > 0);
  }

  private async claimed(pool: Pool, pg: Postgres, meta: Meta) {
    const inherited = meta.inherited ?? [];
    return pool.hold(async () => (await pg.query(`SELECT 1 ${LOGIN_PASSWORDS} AND rolpassword <> ALL($1::text[]) LIMIT 1`, [inherited])).length > 0);
  }

  private async verifier(pool: Pool, pg: Postgres, user: string): Promise<ScramSha256Data> {
    const rows = await pool.hold(() => pg.query<{ rolpassword: string }>(`SELECT rolpassword ${LOGIN_PASSWORDS} AND rolname = $1`, [user]));
    const parsed = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(rows[0]?.rolpassword ?? "");
    if (parsed) return { iterations: Number(parsed[1]), salt: parsed[2], storedKey: parsed[3], serverKey: parsed[4] };
    return { iterations: 4096, salt: random(), storedKey: random(), serverKey: random() };
  }
}

const reply = (...parts: Array<Uint8Array>) => new Uint8Array(parts.flatMap((p) => [...p]));
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function parameterStatus(pg: Postgres, user: string, applicationName: string): Array<Uint8Array> {
  const decoder = new TextDecoder();
  return pg.parameterStatus.map((m) => {
    const [name] = decoder.decode(m.subarray(5)).split("\0");
    if (name === "session_authorization") return msg.parameterStatus(name, user);
    if (name === "application_name") return msg.parameterStatus(name, applicationName);
    return m;
  });
}
