// One save at a time per page. The next save uses the version the previous one
// returned, so a late result cannot overwrite a newer edit. A timeout is not a
// final failure: the edit stays queued and the next attempt tries again.

export class SaveConflict extends Error {
  constructor(readonly currentVersion: number) {
    super("The page changed somewhere else");
    this.name = "SaveConflict";
  }
}

export class SaveTimeout extends Error {
  constructor() {
    super("The save timed out");
    this.name = "SaveTimeout";
  }
}

export type SaveResult<T> = { version: number; value: T };

export class DocSaveQueue<T> {
  private chain: Promise<void> = Promise.resolve();
  private version: number;
  /** Set when the last attempt timed out. The edit is still waiting. */
  timedOut = false;

  constructor(version: number) {
    this.version = version;
  }

  currentVersion(): number {
    return this.version;
  }

  /** Runs `save` after earlier saves, passing the version those returned. */
  enqueue(save: (expectedVersion: number) => Promise<SaveResult<T>>): Promise<SaveResult<T>> {
    const run = async (): Promise<SaveResult<T>> => {
      try {
        const saved = await save(this.version);
        this.version = saved.version;
        this.timedOut = false;
        return saved;
      } catch (error) {
        if (error instanceof SaveConflict) this.version = error.currentVersion;
        if (error instanceof SaveTimeout) this.timedOut = true;
        throw error;
      }
    };
    const pending = this.chain.then(run, run);
    this.chain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
