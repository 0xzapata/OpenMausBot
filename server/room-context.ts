// How full each bot's context is in a room, and when its next room turn
// should start from a fresh provider session instead.
//
// A room turn never resumes a stored session: every turn re-sends the room's
// bounded recent transcript (serializeRoomContext). What grows is a warm
// provider process the driver keeps between one bot's consecutive turns in
// the same room (Claude's idle session reuse), which re-reads that transcript
// on top of everything it already holds. Starting the turn with the existing
// `sessionReset` flag drops exactly that native backlog and nothing the room
// relies on, so it is a room's compaction: the transcript stays whole, and
// the fresh session gets the same bounded context every turn gets.
//
// Measurements live in memory on purpose. They describe a warm process, and
// warm processes do not outlive this server either.
//
// Nor do they outlive the process itself. A driver keeps one warm process per
// thread, and a room's members share the room's thread: when another member
// speaks on the same engine, the previous member's process is closed
// ("spawn contract changed"), and a quiet one closes after the session idle
// window. A reading of a closed process is a ghost: its warning stays up and
// its next turn compacts nothing that still exists. So a reading goes when
// another member's turn dispatches on its engine, and when it is older than
// the idle window (or the room's keep-warm hold, whichever ends later).

import type { ModelCatalog } from "./contracts.ts";
import { contextWindowFor } from "./context-budget.ts";

/** Before a room turn, at or above this share of the window, start fresh. */
export const DEFAULT_ROOM_COMPACT_AT = 0.9;

export type RoomMemberContext = { tokens: number; window: number; compactRequested?: true };

/** The configured threshold as a token count for this window, or null when
 * automatic compaction is off. `roomCompactAt` reads like `compactAt`: a
 * fraction below 1, or a token count. */
export function roomCompactTokens(window: number, settings: { autoCompact?: boolean; roomCompactAt?: number } | undefined): number | null {
  if (settings?.autoCompact === false) return null;
  const at = settings?.roomCompactAt;
  const value = typeof at === "number" && Number.isFinite(at) && at > 0 ? at : DEFAULT_ROOM_COMPACT_AT;
  return value < 1 ? Math.floor(window * value) : Math.floor(value);
}

/** A reading, with the engine its process runs on and when it was taken. */
type Measured = RoomMemberContext & { instanceId?: string; at: number };

export type RoomContextClock = {
  /** How long a quiet warm process lives (sessionIdlePolicy). */
  idleMs: number;
  /** When the room thread's keep-warm hold ends, if it has one. */
  heldUntil?: (threadId: string) => number | undefined;
  now?: () => number;
  /** A reading aged out on its own: the room's banner should update. */
  expired?: (threadId: string) => void;
};

export class RoomContextTracker {
  private threads = new Map<string, Map<string, Measured>>();
  /** The engine each member's latest turn in a thread was dispatched on. */
  private engines = new Map<string, Map<string, string>>();

  private readonly clock: RoomContextClock;

  constructor(clock: RoomContextClock) {
    this.clock = clock;
  }

  /** A settled room turn's last model call, as the driver reported it. */
  record(threadId: string, botId: string, reading: { tokens?: number; window?: number } | undefined, model: string | undefined, catalog?: ModelCatalog): void {
    const tokens = reading?.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
    const members = this.threads.get(threadId) ?? new Map<string, Measured>();
    const previous = this.live(threadId, botId);
    const instanceId = this.engines.get(threadId)?.get(botId);
    const measured: Measured = {
      tokens: Math.trunc(tokens),
      window: contextWindowFor(model, catalog, reading?.window),
      // A request made while the turn ran still applies to the next one.
      ...(previous?.compactRequested ? { compactRequested: true as const } : {}),
      ...(instanceId ? { instanceId } : {}),
      at: this.now(),
    };
    members.set(botId, measured);
    this.threads.set(threadId, members);
    this.watch(threadId, botId, measured);
  }

  /** "Compact now": the bot's next turn in this room starts fresh. Returns
   * false when there is nothing measured to compact. */
  request(threadId: string, botId: string): boolean {
    const current = this.live(threadId, botId);
    if (!current) return false;
    current.compactRequested = true;
    return true;
  }

  /** Every measured member of one room thread, for the wire. */
  forThread(threadId: string): Record<string, RoomMemberContext> | undefined {
    const members = this.threads.get(threadId);
    if (!members) return undefined;
    for (const botId of members.keys()) this.live(threadId, botId);
    if (!members.size) return undefined;
    return Object.fromEntries([...members].map(([botId, { tokens, window, compactRequested }]) =>
      [botId, { tokens, window, ...(compactRequested ? { compactRequested } : {}) }]));
  }

  /** At dispatch, after takeReset: this member's turn takes the thread's
   * warm process slot on its engine, so the other members measured on that
   * engine lose theirs. Members on another engine keep their process (each
   * engine pools its own). Returns whether any reading went. */
  dispatched(threadId: string, botId: string, instanceId: string): boolean {
    const engines = this.engines.get(threadId) ?? new Map<string, string>();
    engines.set(botId, instanceId);
    this.engines.set(threadId, engines);
    const members = this.threads.get(threadId);
    if (!members) return false;
    let dropped = false;
    for (const [other, reading] of members) {
      // A reading from before its engine was known is assumed to share it.
      if (other === botId || (reading.instanceId && reading.instanceId !== instanceId)) continue;
      members.delete(other);
      dropped = true;
    }
    if (!members.size) this.threads.delete(threadId);
    return dropped;
  }

  /** At dispatch: whether this turn starts a fresh session, and why. The
   * reading is consumed either way it fires, so one reset follows one
   * measurement; the turn records a new one when it settles. */
  takeReset(threadId: string, botId: string, settings: { autoCompact?: boolean; roomCompactAt?: number } | undefined):
    { reason: "requested" | "threshold"; percent: number } | null {
    const current = this.live(threadId, botId);
    const members = this.threads.get(threadId);
    if (!members || !current) return null;
    const percent = Math.round((current.tokens / current.window) * 100);
    const limit = roomCompactTokens(current.window, settings);
    const reason = current.compactRequested ? "requested" : limit !== null && current.tokens >= limit ? "threshold" : null;
    if (!reason) return null;
    members.delete(botId);
    if (!members.size) this.threads.delete(threadId);
    return { reason, percent };
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
    this.engines.delete(threadId);
  }

  private now(): number {
    return this.clock.now?.() ?? Date.now();
  }

  /** Idle closes count from when the turn settled, which is when the
   * reading was taken; a keep-warm hold can keep the process past that. */
  private warmUntil(threadId: string, reading: Measured): number {
    return Math.max(reading.at + this.clock.idleMs, this.clock.heldUntil?.(threadId) ?? 0);
  }

  /** Tells `expired` once this reading ages out, unless it was replaced or
   * consumed first. The timer never keeps the server alive. */
  private watch(threadId: string, botId: string, reading: Measured): void {
    const expired = this.clock.expired;
    if (!expired) return;
    const check = () => {
      if (this.threads.get(threadId)?.get(botId) !== reading) return;
      if (this.live(threadId, botId)) return arm(this.warmUntil(threadId, reading) - this.now());
      expired(threadId);
    };
    const arm = (ms: number) => {
      const timer = setTimeout(check, Math.min(2_147_483_647, Math.max(0, ms)));
      timer.unref?.();
    };
    arm(this.warmUntil(threadId, reading) - this.now());
  }

  /** A member's reading while its process can still be warm; a stale one
   * is dropped. */
  private live(threadId: string, botId: string): Measured | undefined {
    const members = this.threads.get(threadId);
    const current = members?.get(botId);
    if (!members || !current) return undefined;
    if (this.now() < this.warmUntil(threadId, current)) return current;
    members.delete(botId);
    if (!members.size) this.threads.delete(threadId);
    return undefined;
  }
}
