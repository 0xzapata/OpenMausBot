// One bot call per browser at a time, from its first read of the page to its
// last (browser-steps.ts). The engine already runs one command per session;
// the lane keeps a whole call together, so a second call's "empty the
// console" never lands between the first call's action and its read of what
// the page reported, and fill_login's typing never shares the browser with
// a capture. Calls of different browsers never wait for each other.
export class BrowserLanes {
  private lanes = new Map<string, Promise<void>>();

  /** A call holds or waits for this browser. */
  held(session: string): boolean { return this.lanes.has(session); }

  /** Runs `fn` after the browser's earlier calls, waiting at most `waitMs`
   * for them. Null, without running it, when the wait ran out. */
  async run<T>(session: string, fn: () => Promise<T>, waitMs: number): Promise<T | null> {
    const previous = this.lanes.get(session);
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous ? previous.then(() => mine) : mine;
    this.lanes.set(session, tail);
    const leave = () => { if (this.lanes.get(session) === tail) this.lanes.delete(session); };
    if (previous) {
      let timer: NodeJS.Timeout | undefined;
      const ready = await Promise.race([previous.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), waitMs); timer.unref(); })]);
      clearTimeout(timer);
      // Gave up: later calls still wait for the earlier one, not for this.
      if (!ready) { release(); void tail.then(leave); return null; }
    }
    try { return await fn(); } finally { release(); leave(); }
  }
}
