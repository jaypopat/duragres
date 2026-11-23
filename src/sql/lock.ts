// One writer per database. A connection holds the lock from its transaction's first
// write until COMMIT or ROLLBACK, so the committed state its replay runs on cannot
// change underneath it. Writes outside a transaction wait for it too; reads never do.

type Owner = object;

export class WriterLock {
  private holder?: Owner;
  private queue: Array<{ owner: Owner; grant: () => void }> = [];

  async acquire(owner: Owner): Promise<void> {
    if (this.holder === owner) return;
    if (!this.holder) {
      this.holder = owner;
      return;
    }
    await new Promise<void>((grant) => this.queue.push({ owner, grant }));
  }

  /** Releases the lock if `owner` holds it, and stops `owner` waiting for it. */
  release(owner: Owner) {
    this.queue = this.queue.filter((w) => w.owner !== owner);
    if (this.holder !== owner) return;
    const next = this.queue.shift();
    this.holder = next?.owner;
    next?.grant();
  }
}
