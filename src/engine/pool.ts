// Many client connections, one Postgres backend: PgBouncer-style transaction pooling with a pool of one.
//
// A client owns the backend from its first message until Postgres reports ReadyForQuery with status
// idle ('I'): through a whole transaction, and through a Parse/Bind/Execute batch up to its Sync.
// Other clients queue meanwhile. Each client's named statements and portals get a prefix so two
// clients' "s1" never collide. As in PgBouncer transaction mode, plain SET, temp tables, LISTEN and
// session advisory locks are shared by every client.
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
  /** Rolls back what the client left open and drops its statements. */
  close(): Promise<void>;
}

interface Holder {
  user: string;
  /** Called when the client held the backend idle for too long; ends its connection. */
  evict(code: string, message: string): void;
}

export class Pool {
  private owner: Holder | null = null;
  private waiters: Array<{ holder: Holder; grant: () => void }> = [];
  private running = false; // a message is executing, so the owner is not idle
  private role = "postgres"; // the backend's session authorization
  private txStatus = "I";
  private nextId = 1;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private writesAtCheckpoint = 0;

  constructor(private pg: Postgres) {}

  /** A client for `user`, creating the role on first use. */
  async connect(user: string, evict: Holder["evict"]): Promise<Client> {
    await this.hold(async () => {
      const found = await this.pg.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
      if (!found.length) await this.pg.exec(`CREATE ROLE ${quoteIdent(user)} LOGIN SUPERUSER`);
    });
    const holder: Holder = { user, evict };
    const prefix = `c${this.nextId++}_`;
    const statements = new Set<string>();

    return {
      user,
      status: () => (this.owner === holder ? this.txStatus : "I"),
      send: async (message) => {
        await this.acquire(holder);
        this.running = true;
        let reply: Uint8Array;
        try {
          reply = await this.pg.run(renameStatements(message, prefix, (name) => statements.add(name)));
        } finally {
          this.running = false;
        }
        this.txStatus = readyStatus(reply) ?? this.txStatus;
        if (readyStatus(reply) === "I") this.release(holder);
        else this.armIdleTimer();
        return reply;
      },
      close: async () => {
        const owned = this.owner === holder;
        if (!owned && !statements.size) return this.release(holder);
        await this.acquire(holder);
        try {
          if (owned) {
            await this.pg.run(SYNC); // ends a half-sent extended-protocol batch
            if (this.txStatus !== "I") await this.pg.exec("ROLLBACK");
            this.txStatus = "I";
          }
          for (const name of statements) await this.pg.exec(`DEALLOCATE ${quoteIdent(name)}`).catch(() => {}); // may be closed already
        } finally {
          this.release(holder);
        }
      },
    };
  }

  /** Runs `work` on the idle backend, for the server's own SQL (roles, checkpoints, branch copies). */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    const holder: Holder = { user: this.role, evict: () => {} };
    await this.acquire(holder, false);
    try {
      return await work();
    } finally {
      this.release(holder);
    }
  }

  private async acquire(holder: Holder, switchRole = true) {
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
    if (switchRole && this.role !== holder.user) {
      await this.pg.exec(`SET SESSION AUTHORIZATION ${quoteIdent(holder.user)}`);
      this.role = holder.user;
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
    if (this.pg.fs.stats.pageWrites === this.writesAtCheckpoint) return;
    this.checkpointTimer = setTimeout(() => {
      if (this.owner) return; // busy again; the next idle period reschedules
      void this.hold(async () => {
        await this.pg.exec("CHECKPOINT");
        this.writesAtCheckpoint = this.pg.fs.stats.pageWrites;
      }).catch(() => {}); // retried after the next idle period; an engine failure also surfaces on the next message
    }, CHECKPOINT_AFTER_IDLE_MS);
  }
}

const SYNC = Uint8Array.of(0x53, 0, 0, 0, 4);
