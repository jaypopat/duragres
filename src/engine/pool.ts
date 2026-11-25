// Many client connections, one Postgres backend: PgBouncer-style transaction pooling with a pool of one.
//
// A client owns the backend from its first message until Postgres reports ReadyForQuery with status
// idle ('I'): through a whole transaction, and through a Parse/Bind/Execute batch up to its Sync.
// Other clients queue meanwhile. Each client's named statements and portals get a prefix so two
// clients' "s1" never collide. As in PgBouncer transaction mode, plain SET, temp tables, LISTEN,
// session advisory locks and the unnamed prepared statement are shared by every client.
//
// The backend is authenticated as postgres and switches to each owner's role with SET SESSION
// AUTHORIZATION, so a role is not a security boundary inside one database: any client can switch back.
import { readyStatus, renameStatements } from "../postgres/messages";
import { quoteIdent } from "./postgres";
import type { Postgres } from "./postgres";

const IDLE_IN_TRANSACTION_MS = 30_000; // a client holding the backend this long without a message is disconnected
const IDLE_WHILE_OTHERS_WAIT_MS = 5000; // ... or this long while other clients wait for it
const CHECKPOINT_AFTER_IDLE_MS = 3000; // an evicted object replays WAL since its last checkpoint on boot

/** One client connection's view of the backend. */
export interface Client {
  readonly user: string;
  /** Runs one protocol message, waiting for the backend if another client holds it. */
  send(message: Uint8Array): Promise<Uint8Array>;
  /** This client's transaction status for a ReadyForQuery Duragres writes itself. */
  status(): string;
  /** Rolls back what the client left open and drops its statements. Waits for a message in flight. */
  close(): Promise<void>;
}

interface Holder {
  /** The role the backend runs as while this holder owns it. */
  user: string;
  /** Called when the client held the backend idle for too long; ends its connection. */
  evict(code: string, message: string): void;
}

export class Pool {
  private owner: Holder | null = null;
  private waiters: Array<{ holder: Holder; grant: () => void }> = [];
  private running = false; // a message is executing, so the owner is not idle
  private txStatus = "I";
  private nextId = 1;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private writesAtCheckpoint = 0;
  private disposed = false;

  constructor(private pg: Postgres) {}

  /** A client for `user`, creating the role on first use. */
  async connect(user: string, evict: Holder["evict"]): Promise<Client> {
    await this.hold(async () => {
      const found = await this.pg.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [user]);
      if (!found.length) await this.pg.exec(`CREATE ROLE ${quoteIdent(user)} LOGIN SUPERUSER`);
    });
    const holder: Holder = { user, evict };
    const prefix = `c${this.nextId++}_`;
    const statements = new Set<string>();
    const track = (event: "parse" | "close", name: string) => (event === "parse" ? statements.add(name) : statements.delete(name));
    let inFlight: Promise<unknown> = Promise.resolve();
    let closed = false;

    const send = async (message: Uint8Array) => {
      await this.acquire(holder);
      if (closed) {
        this.release(holder); // a message queued behind others when its connection went away
        throw new Error("connection closed");
      }
      this.running = true;
      let reply: Uint8Array;
      try {
        reply = await this.pg.run(renameStatements(message, prefix, track));
      } finally {
        this.running = false;
      }
      const status = readyStatus(reply);
      this.txStatus = status ?? this.txStatus;
      if (status === "I") this.release(holder);
      else this.armIdleTimer();
      return reply;
    };

    return {
      user,
      status: () => (this.owner === holder ? this.txStatus : "I"),
      send: (message) => {
        const reply = send(message);
        inFlight = reply.catch(() => {});
        return reply;
      },
      close: async () => {
        closed = true;
        await inFlight;
        if (this.owner !== holder) {
          this.release(holder); // drops it from the waiters
          if (statements.size) await this.hold(() => this.deallocate([...statements]));
          return;
        }
        try {
          await this.pg.run(SYNC); // ends a half-sent extended-protocol batch
          if (this.txStatus !== "I") await this.pg.exec("ROLLBACK");
          this.txStatus = "I";
          if (statements.size) await this.deallocate([...statements]);
        } finally {
          this.release(holder);
        }
      },
    };
  }

  /** Runs `work` as postgres on the idle backend, for the server's own SQL (roles, auth lookups, checkpoints, branch copies). */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    const server: Holder = { user: "postgres", evict: () => {} };
    await this.acquire(server);
    try {
      return await work();
    } finally {
      this.release(server);
    }
  }

  /** Stops the timers. The pool is unusable afterwards; the object is deleting its storage. */
  dispose() {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.checkpointTimer);
  }

  private async deallocate(names: Array<string>) {
    try {
      await this.pg.exec(names.map((name) => `DEALLOCATE ${quoteIdent(name)};`).join(" "));
    } catch {
      // One of them was already gone, which aborts the batch; drop the rest one by one.
      for (const name of names) await this.pg.exec(`DEALLOCATE ${quoteIdent(name)}`).catch(() => {});
    }
  }

  private async acquire(holder: Holder) {
    if (this.owner === holder) {
      clearTimeout(this.idleTimer);
      return;
    }
    if (this.owner) {
      const granted = new Promise<void>((grant) => {
        this.waiters.push({ holder, grant });
      });
      if (this.waiters.length === 1 && !this.running) this.armIdleTimer(); // the owner is idle; others now wait on it
      await granted;
    } else {
      this.owner = holder;
    }
    clearTimeout(this.checkpointTimer);
    // Every handoff sets the role again: a client can change it (SET ROLE, RESET SESSION AUTHORIZATION).
    try {
      await this.pg.exec(`RESET ROLE; SET SESSION AUTHORIZATION ${quoteIdent(holder.user)}`);
    } catch (error) {
      this.release(holder);
      throw error;
    }
  }

  private release(holder: Holder) {
    this.waiters = this.waiters.filter((w) => w.holder !== holder);
    if (this.owner !== holder) return;
    clearTimeout(this.idleTimer);
    this.owner = null;
    const next = this.waiters.shift();
    if (next) {
      this.owner = next.holder;
      next.grant();
    } else {
      this.scheduleCheckpoint();
    }
  }

  /** The owner sent nothing but still holds the backend (open transaction, or a batch without Sync). */
  private armIdleTimer() {
    clearTimeout(this.idleTimer);
    const owner = this.owner;
    if (!owner) return;
    const ms = this.waiters.length ? IDLE_WHILE_OTHERS_WAIT_MS : IDLE_IN_TRANSACTION_MS;
    this.idleTimer = setTimeout(() => {
      if (this.owner !== owner || this.running) return;
      owner.evict("25P03", `terminating connection: idle in transaction for ${ms / 1000}s while this database's single backend was held`);
    }, ms);
  }

  private scheduleCheckpoint() {
    clearTimeout(this.checkpointTimer);
    if (this.disposed || this.pg.fs.stats.pageWrites === this.writesAtCheckpoint) return;
    this.checkpointTimer = setTimeout(() => {
      if (this.owner || this.disposed) return; // busy again; the next idle period reschedules
      void this.hold(async () => {
        await this.pg.exec("CHECKPOINT");
        this.writesAtCheckpoint = this.pg.fs.stats.pageWrites;
      }).catch(() => {}); // retried after the next idle period; an engine failure also surfaces on the next message
    }, CHECKPOINT_AFTER_IDLE_MS);
  }
}

const SYNC = Uint8Array.of(0x53, 0, 0, 0, 4);
