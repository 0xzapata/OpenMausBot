// How full each bot's context is in a room, and when its next room turn
// should start from a fresh provider session instead.
//
// A room turn re-sends the room's bounded recent transcript
// (host/room-transcript.ts) and resumes no stored session. What grows is a
// warm provider process the driver keeps between one bot's consecutive turns
// in the same room (Claude's idle session reuse), which re-reads that
// transcript on top of everything it already holds. Starting the turn with
// the existing `sessionReset` flag drops exactly that native backlog and
// nothing the room relies on, so it is a room's compaction: the transcript
// stays whole, and the fresh session gets the same bounded context a room
// turn has always carried.
//
// Room sessions (host/room-sessions.ts; `context.roomSessions`, off by
// default) change one thing: a member whose own session is known to hold the
// room is sent only the lines it has not been handed, so that session grows
// more slowly. Claude Code only, and only on a turn that mounts the
// engine-hook channel, because that is how the harness hears of the engine's
// own compaction: when Claude Code compacts a member's session, what the
// session was handed is no longer what it holds, and the member's next turn
// carries the whole transcript again, as every turn does without the setting.
// A hook that never arrives is caught by the reading kept here: one that is
// lower than after the member's turn before, in the same session, means the
// session was compacted. Not when that turn reported none; when no earlier
// reading of the session is held (it began on that turn, no turn in it
// reported a reading before, the member's earlier turns in it ran while the
// setting was off or were not managed, its turn before waited more than a
// day on a person and was given up, or the module forgot the thread after a
// fault); or when the turn regrew the session past its earlier reading. The doc
// (docs/verification/context-compaction.md) lists exactly these, and what a
// process kept warm past the idle time changes.
//
// Measurements live in memory on purpose. They describe a warm process, and
// warm processes do not outlive this server either.

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

export class RoomContextTracker {
  private threads = new Map<string, Map<string, RoomMemberContext>>();

  /** A settled room turn's last model call, as the driver reported it. */
  record(threadId: string, botId: string, reading: { tokens?: number; window?: number } | undefined, model: string | undefined, catalog?: ModelCatalog): void {
    const tokens = reading?.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
    const members = this.threads.get(threadId) ?? new Map<string, RoomMemberContext>();
    const previous = members.get(botId);
    members.set(botId, {
      tokens: Math.trunc(tokens),
      window: contextWindowFor(model, catalog, reading?.window),
      // A request made while the turn ran still applies to the next one.
      ...(previous?.compactRequested ? { compactRequested: true as const } : {}),
    });
    this.threads.set(threadId, members);
  }

  /** "Compact now": the bot's next turn in this room starts fresh. Returns
   * false when there is nothing measured to compact. */
  request(threadId: string, botId: string): boolean {
    const current = this.threads.get(threadId)?.get(botId);
    if (!current) return false;
    current.compactRequested = true;
    return true;
  }

  /** Every measured member of one room thread, for the wire. */
  forThread(threadId: string): Record<string, RoomMemberContext> | undefined {
    const members = this.threads.get(threadId);
    if (!members?.size) return undefined;
    return Object.fromEntries([...members].map(([botId, value]) => [botId, { ...value }]));
  }

  /** At dispatch: whether this turn starts a fresh session, and why. The
   * reading is consumed either way it fires, so one reset follows one
   * measurement; the turn records a new one when it settles. */
  takeReset(threadId: string, botId: string, settings: { autoCompact?: boolean; roomCompactAt?: number } | undefined):
    { reason: "requested" | "threshold"; percent: number } | null {
    const members = this.threads.get(threadId);
    const current = members?.get(botId);
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
  }
}
