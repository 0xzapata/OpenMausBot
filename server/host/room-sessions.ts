// Which lines of a room a member's own provider session already holds.
//
// Every room turn carries the room's last lines in its text
// (room-transcript.ts). A driver that keeps a process between one bot's
// consecutive turns in a room then reads those lines again on top of the
// session that already has them. With `context.roomSessions` on, this module
// remembers, per room thread and member, the one native session that ran the
// member's last turn there and what that session was handed (HandedState,
// kept by a second Handoffs: the acceptance protocol of the 1:1 path,
// server/delta-context.ts). A turn then takes one of three shapes:
//
//   legacy  the setting is off, the engine is not covered, or the turn is a
//           guest's. Today's call, and nothing is remembered.
//   start   today's call as well, to the byte: the whole window, a reset only
//           when the room asked for one, no cursor. The one difference is
//           that the session which runs the turn is recorded with the window.
//   resume  the recorded session, sent only the lines of the window it has
//           not been handed, with the whole turn as the text a driver
//           rebuilds from if it cannot reopen that session.
//
// The invariant: every line of the window a turn was built from is either in
// the text sent now or was shown to this same native session by an earlier
// accepted turn. A start sends the window. A resume is refused unless every
// line the record does not cover is in the window and the window does not
// reach behind the line the session's start left out. Everything that reads
// the transcript to decide what else the turn says ("in the conversation
// above") therefore stays true.
//
// A resume is only ever chosen where main would have gone on in that same
// session anyway: the same member spoke last on this thread and instance,
// nothing the driver keys its process on changed, and no more time passed
// than the driver keeps a quiet process for. Any doubt gives a start, which
// is what the room does today. Nothing is persisted: a record describes a
// warm process, and warm processes do not outlive this server either.
//
// A host module (server/host/README.md): everything it reads is handed in.
import { createHash } from "node:crypto";

import type { RuntimeEvent } from "../contracts.ts";
import { Handoffs, handedStateUsable, sessionStart, unseenMessages, type HandedState, type HandoffStore, type SessionStart } from "../delta-context.ts";
import { sessionIdlePolicy } from "../drivers/session-idle.ts";
import type { Message } from "../store.ts";
import { isRoomContextMessage, type RoomLine, type RoomWindow } from "./room-transcript.ts";

/** The engines a room session is kept for, by driver kind, each with the name
 * its driver reads its idle policy under (drivers/session-idle.ts). Claude
 * Code alone: it is the engine that goes on in a warm session between room
 * turns today. Widening this is one entry; the engine must also declare
 * `strictResume`, the contract a delta depends on. */
export const ROOM_SESSION_ENGINES: Readonly<Record<string, string>> = { claudeAgent: "CLAUDE" };

/** How long after a member's last turn its room session is still resumed: as
 * long as the engine's driver keeps a quiet process, so a session is never
 * reopened from disk after main would have started a new one. Undefined for
 * an engine that is not covered. */
export function roomSessionIdleMs(driverKind: string, env: Record<string, string | undefined> = process.env): number | undefined {
  return Object.hasOwn(ROOM_SESSION_ENGINES, driverKind) ? sessionIdlePolicy(ROOM_SESSION_ENGINES[driverKind]!, env).idleMs : undefined;
}

/** The provider instance a room turn runs on, as far as this module reads it. */
export interface RoomSessionEngine {
  instanceId: string;
  driverKind: string;
  adapter: { capabilities: { strictResume?: boolean } };
}

export interface RoomSessionsDeps {
  /** `context.roomSessions`, read at every dispatch. */
  enabled(): boolean;
  /** Every stored message of a thread, oldest first. */
  messagesFor(threadId: string): readonly Message[];
  now?(): number;
}

export interface RoomDispatchInput {
  threadId: string;
  botId: string;
  /** This turn's own id on the thread, the one bindTurn is called with. */
  claimId: string;
  instance: RoomSessionEngine;
  guestConfined: boolean;
  /** The room asked for a fresh session: the 90% threshold or Compact now. */
  reset: boolean;
  /** Everything standing the driver is handed with the turn. A session is
   * resumed only while all of it is unchanged: what main's warm process is
   * keyed on, as far as the harness sees it. Fingerprinted, never kept. */
  config: readonly unknown[];
  /** The window the turn's text and its other blocks were built from. */
  window: RoomWindow;
  /** Everything after the transcript in today's turn text. */
  tail: string;
  /** What goes in front of whichever text is sent: the clock, recalled notes. */
  wrap(body: string): string;
}

export interface RoomDispatch {
  mode: "legacy" | "start" | "resume";
  text: string;
  /** Spread into the adapter's sendTurn input. */
  send: { sessionReset?: true; resumeCursor?: string; recoveryText?: string };
}

export interface RoomSessions {
  /** Immediately before sendTurn, in the same synchronous step. */
  dispatch(input: RoomDispatchInput): RoomDispatch;
  bindTurn(threadId: string, claimId: string, turnId: string | undefined): void;
  /** Every provider event of a room thread, from the main fold. */
  onEvent(event: RuntimeEvent): void;
  /** The thread is gone. */
  forget(threadId: string): void;
}

interface MemberRecord {
  instanceId: string;
  /** The adapter the session lives in. An instance reloaded under the same
   * id is a new adapter, and the old one's processes went with it. */
  adapter: object;
  handed: HandedState;
  /** When its last managed turn was seen to complete ok. Absent until then:
   * a record is trusted for the next turn only after that. */
  settledAt?: number;
}

interface Flight {
  botId: string;
  instanceId: string;
  adapter: object;
  claimId: string;
  turnId?: string;
}

const DELTA_NOTE = "[Messages this conversation received since your last turn in this room, oldest first. Your session already holds the conversation before them.]";
const DELTA_NONE = "[Messages this conversation received since your last turn in this room: none.]";

/** The lines a resumed session has not been handed, as the window renders
 * them, under one note. The note's opening is one escapeNotes already
 * defuses in every transcript line (server/peer-provenance.ts), so no line
 * can pose as this block. */
export function renderRoomDelta(lines: ReadonlyArray<RoomLine & { earlier?: boolean }>): string {
  if (lines.length === 0) return DELTA_NONE;
  const earlier = lines.filter((line) => line.earlier).length;
  return [
    DELTA_NOTE,
    ...(earlier > 0 ? [`(The first ${earlier === 1 ? "message is" : `${earlier} messages are`} older than messages you have already seen.)`] : []),
    ...lines.map((line) => line.text),
  ].join("\n");
}

/** A fingerprint of the turn's standing input, or undefined when it cannot
 * be taken: such a turn is not managed rather than failed. */
function fingerprint(config: readonly unknown[]): string | undefined {
  try {
    return createHash("sha256").update(JSON.stringify(config)).digest("hex");
  } catch {
    return undefined;
  }
}

export function createRoomSessions(deps: RoomSessionsDeps): RoomSessions {
  const now = deps.now ?? Date.now;
  /** thread → member → the one session recorded for it there */
  const records = new Map<string, Map<string, MemberRecord>>();
  /** thread → the managed turn dispatched there whose completion the fold has not seen */
  const inFlight = new Map<string, Flight>();
  /** thread → instance → the member whose turn was dispatched there last,
   * managed or not: a driver keeps one process per thread, and it belongs to
   * whoever spoke last on that instance */
  const lastSpeakers = new Map<string, Map<string, string>>();

  const drop = (threadId: string, botId: string) => {
    const members = records.get(threadId);
    if (!members?.delete(botId)) return;
    if (!members.size) records.delete(threadId);
  };

  const roomStore: HandoffStore = {
    order: (threadId) => deps.messagesFor(threadId).filter(isRoomContextMessage).map((m) => m.id),
    read: (botId, threadId, instanceId) => {
      const record = records.get(threadId)?.get(botId);
      return record?.instanceId === instanceId ? record.handed : undefined;
    },
    write: (botId, threadId, instanceId, state) => {
      // Only the turn in flight on the thread writes.
      const flight = inFlight.get(threadId);
      if (!flight || flight.botId !== botId || flight.instanceId !== instanceId) return;
      const members = records.get(threadId) ?? new Map<string, MemberRecord>();
      records.set(threadId, members);
      let handed = state;
      // One native session belongs to one member. Two members recorded with
      // the same one means the harness does not know whose it is: neither is
      // trusted.
      if (state.session !== undefined) {
        for (const [otherId, other] of members) {
          if (otherId === botId || other.handed.session !== state.session) continue;
          members.delete(otherId);
          handed = { ids: [] };
        }
      }
      members.set(botId, { instanceId, adapter: flight.adapter, handed });
    },
    // Working notes included: the session wrote them itself.
    replies: (threadId, turnId) => deps.messagesFor(threadId)
      .filter((m) => m.role === "bot" && m.kind === "text" && m.turnId === turnId).map((m) => m.id),
  };
  const handoffs = new Handoffs(roomStore);

  /** The window's lines the member's session has not been handed, when every
   * condition for sending only those holds. Undefined: start instead. */
  function unseenLines(
    record: MemberRecord | undefined, input: RoomDispatchInput, config: string, idleMs: number,
  ): { session: string; lines: Array<RoomLine & { earlier?: boolean }> } | undefined {
    if (!record || input.reset) return undefined;
    const { handed } = record;
    const { order, lines: shown, readable } = input.window;
    if (record.instanceId !== input.instance.instanceId || record.adapter !== input.instance.adapter) return undefined;
    if (handed.config !== config) return undefined;
    if (record.settledAt === undefined || now() - record.settledAt > idleMs) return undefined;
    if (handed.session === undefined || !handedStateUsable(handed, handed.session, order)) return undefined;
    // The window must not reach behind the line the session's start left
    // out: such a line is in the window, was never shown, and is not offered.
    if (handed.omitted !== undefined && shown.length && order.indexOf(shown[0]!.id) <= order.indexOf(handed.omitted)) return undefined;
    const byId = new Map(shown.map((line) => [line.id, line]));
    const lines: Array<RoomLine & { earlier?: boolean }> = [];
    for (const unseen of unseenMessages(readable.map((id) => ({ id, role: "user" as const, text: "" })), order, handed)) {
      const line = byId.get(unseen.id);
      // It missed more than the window holds: a delta would have a hole in it.
      if (!line) return undefined;
      lines.push(unseen.earlier ? { ...line, earlier: true } : line);
    }
    return { session: handed.session, lines };
  }

  function dispatch(input: RoomDispatchInput): RoomDispatch {
    const { threadId, botId, instance, window } = input;
    const full = input.wrap(window.text + input.tail);
    // What main sends, and what every turn that is not a delta sends.
    const today: RoomDispatch["send"] = input.reset ? { sessionReset: true } : {};

    // A managed turn that was never seen to end (timed out, stalled, stopped
    // in the handshake, rejected at dispatch): its member's record is not
    // trusted any more.
    const stale = inFlight.get(threadId);
    if (stale) {
      inFlight.delete(threadId);
      drop(threadId, stale.botId);
    }
    handoffs.forget(threadId);

    const speakers = lastSpeakers.get(threadId) ?? new Map<string, string>();
    lastSpeakers.set(threadId, speakers);
    const spokeLast = speakers.get(instance.instanceId) === botId;
    speakers.set(instance.instanceId, botId);

    const idleMs = roomSessionIdleMs(instance.driverKind);
    const config = fingerprint(input.config);
    if (!deps.enabled() || idleMs === undefined || instance.adapter.capabilities.strictResume !== true || input.guestConfined || config === undefined) {
      drop(threadId, botId);
      return { mode: "legacy", text: full, send: today };
    }

    const { order } = window;
    const shown = window.lines.map((line) => line.id);
    const first = shown.length ? order.indexOf(shown[0]!) : order.length;
    // A session that starts on this turn holds the window and what lies
    // between its lines; everything before it is left out, as it is today.
    const started = sessionStart(order, shown, order.slice(first));
    // Never credited with anything it was not sent.
    const nothing: SessionStart = { ...(order.length ? { omitted: order.at(-1)! } : {}), sent: [] };
    const handoff = { botId, instanceId: instance.instanceId, config, started, recovery: started, resumed: nothing, carried: [], own: [] };
    const fly = () => {
      handoffs.dispatching(threadId, input.claimId);
      inFlight.set(threadId, { botId, instanceId: instance.instanceId, adapter: instance.adapter, claimId: input.claimId });
    };

    // Another member's turn on this instance took the driver's one process
    // for the thread: main starts a new session here, and so does this.
    const delta = spokeLast ? unseenLines(records.get(threadId)?.get(botId), input, config, idleMs) : undefined;
    if (!delta) {
      drop(threadId, botId);
      handoffs.begin(threadId, input.claimId, { ...handoff, resumeCursor: undefined, placed: [] });
      fly();
      return { mode: "start", text: full, send: today };
    }
    // Once the provider acts on this turn its session is current through
    // everything the thread held when the window was read: the lines it is
    // shown now, and the working notes between them that no reader is shown.
    handoffs.begin(threadId, input.claimId, { ...handoff, resumeCursor: delta.session, placed: [...order] });
    fly();
    return {
      mode: "resume",
      text: input.wrap(renderRoomDelta(delta.lines) + input.tail),
      send: { resumeCursor: delta.session, recoveryText: full },
    };
  }

  return {
    dispatch,
    bindTurn(threadId, claimId, turnId) {
      handoffs.bindTurn(threadId, claimId, turnId);
      const flight = inFlight.get(threadId);
      if (flight?.claimId === claimId) flight.turnId ??= turnId;
    },
    onEvent(event) {
      handoffs.onEvent(event);
      if (event.type !== "turn.completed") return;
      const flight = inFlight.get(event.threadId);
      if (!flight || event.providerInstanceId !== flight.instanceId) return;
      if (flight.turnId && event.turnId && event.turnId !== flight.turnId) return;
      inFlight.delete(event.threadId);
      // Trusted for the member's next turn only when this one was seen to
      // complete ok in a session the record names. A stop, a provider error,
      // a hold or a parked seat ends the turn not ok.
      const record = records.get(event.threadId)?.get(flight.botId);
      if (event.ok && record?.handed.session !== undefined) record.settledAt = now();
      else drop(event.threadId, flight.botId);
    },
    forget(threadId) {
      records.delete(threadId);
      inFlight.delete(threadId);
      lastSpeakers.delete(threadId);
      handoffs.forget(threadId);
    },
  };
}
