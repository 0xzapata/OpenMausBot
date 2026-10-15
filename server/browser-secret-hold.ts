/** A filled password or code that may still be on the page at `url`. Page scripts there are refused for `ms`; with
 * `clear`, until `clear` has emptied it, run once `ms` pass. */
export interface SecretHold {
  url: string;
  ms: number;
  clear?: () => Promise<void>;
}

type Hold = { url: string; until: number; clears: boolean; timer?: NodeJS.Timeout };

export const SECRET_ON_PAGE = "A saved password was just filled on this page, so agent_browser_eval is refused here for now. Submit the form or open another page first; to read this page, use agent_browser_snapshot or agent_browser_get_text.";

/** Per browser session, the page a fill left a secret on. `runClear` runs a clear in the browser's lane and says whether
 * it ran. */
export class SecretHolds {
  private readonly holds = new Map<string, Hold>();
  private readonly runClear: (session: string, clear: () => Promise<void>) => Promise<boolean>;

  constructor(runClear: (session: string, clear: () => Promise<void>) => Promise<boolean>) {
    this.runClear = runClear;
  }

  hold(session: string, held: SecretHold): void {
    this.drop(session);
    const hold: Hold = { url: held.url, until: Date.now() + held.ms, clears: Boolean(held.clear) };
    const clear = held.clear;
    if (clear) {
      hold.timer = setTimeout(() => {
        hold.timer = undefined;
        // A clear that could not run (a person holds the browser, or it stayed busy) leaves the hold until the page moves.
        void this.runClear(session, clear).then((ran) => { if (ran && this.holds.get(session) === hold) this.holds.delete(session); }, () => undefined);
      }, held.ms);
      hold.timer.unref();
    }
    this.holds.set(session, hold);
  }

  /** Fails closed: a page whose address cannot be read counts as the page that holds the secret. */
  async refuses(session: string, pageUrl: () => Promise<string>): Promise<boolean> {
    const hold = this.holds.get(session);
    if (!hold) return false;
    if (!hold.clears && Date.now() >= hold.until) { this.holds.delete(session); return false; }
    const url = await pageUrl();
    if (!url || url.split("#", 1)[0] === hold.url.split("#", 1)[0]) return true;
    if (!hold.clears) this.holds.delete(session);
    return false;
  }

  drop(session: string): void {
    clearTimeout(this.holds.get(session)?.timer);
    this.holds.delete(session);
  }

  sessions(): string[] {
    return [...this.holds.keys()];
  }
}
