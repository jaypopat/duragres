// Transaction-mode pooling over PGlite's single backend, with per-client statement prefixes.
import { readyStatus, renameStatements } from "../postgres/messages";
import { quoteIdent } from "./postgres";
import type { Postgres } from "./postgres";

const IDLE_IN_TRANSACTION_MS = 30_000;
const IDLE_WHILE_OTHERS_WAIT_MS = 5000;
const CHECKPOINT_AFTER_IDLE_MS = 3000;

export interface Client {
  readonly user: string;
  send(message: Uint8Array): Promise<Uint8Array>;
  status(): string;
  close(): Promise<void>;
}

interface Holder {
  user: string;
  evict(code: string, message: string): void;
}

export class Pool {
  private owner: Holder | null = null;
  private waiters: Array<{ holder: Holder; grant: () => void }> = [];
  private running = false;
  private txStatus = "I";
  private nextId = 1;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private writesAtCheckpoint = 0;
  private disposed = false;

  constructor(private pg: Postgres) {}

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
        this.release(holder);
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
          this.release(holder);
          if (statements.size) await this.hold(() => this.deallocate([...statements]));
          return;
        }
        try {
          await this.pg.run(SYNC);
          if (this.txStatus !== "I") await this.pg.exec("ROLLBACK");
          this.txStatus = "I";
          if (statements.size) await this.deallocate([...statements]);
        } finally {
          this.release(holder);
        }
      },
    };
  }

  async hold<T>(work: () => Promise<T>): Promise<T> {
    const server: Holder = { user: "postgres", evict: () => {} };
    await this.acquire(server);
    try {
      return await work();
    } finally {
      this.release(server);
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.checkpointTimer);
  }

  private async deallocate(names: Array<string>) {
    try {
      await this.pg.exec(names.map((name) => `DEALLOCATE ${quoteIdent(name)};`).join(" "));
    } catch {
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
      if (this.waiters.length === 1 && !this.running) this.armIdleTimer();
      await granted;
    } else {
      this.owner = holder;
    }
    clearTimeout(this.checkpointTimer);
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
      if (this.owner || this.disposed) return;
      void this.hold(async () => {
        await this.pg.exec("CHECKPOINT");
        this.writesAtCheckpoint = this.pg.fs.stats.pageWrites;
      }).catch(() => {});
    }, CHECKPOINT_AFTER_IDLE_MS);
  }
}

const SYNC = Uint8Array.of(0x53, 0, 0, 0, 4);
