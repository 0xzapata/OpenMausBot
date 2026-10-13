// Which lines of a room a member's own provider session already holds.
//
// Every room turn carries the room's last lines in its text
// (room-transcript.ts). A driver that keeps a process between one bot's
// consecutive turns in a room then reads those lines again on top of the
// session that already has them. With `context.roomSessions` on, this module
// remembers, per room thread and member, the one native session that ran the
// member's last turn there, which lines that session was handed
// (HandedState, kept by a second Handoffs: the acceptance protocol of the
// 1:1 path, server/delta-context.ts) and how each line of the window read
// when it was handed. A turn then takes one of three shapes:
//
//   legacy  the setting is off, the engine is not covered, the engine-hook
//           channel is not mounted, or the turn is a guest's. Today's call,
//           and nothing is remembered.
//   start   today's call as well, to the byte: the whole window, a reset only
//           when the room asked for one, no cursor. The one difference is
//           that the session which runs the turn is recorded with the window.
//   resume  the recorded session, sent only the lines of the window it has
//           not been handed or that read differently now, with the whole turn
//           as the text a driver rebuilds from if it cannot reopen it.
//
// The invariant: every line of the window a turn was built from, as it reads
// now, is either in the text sent now or was shown to this same native
// session in exactly this form by an earlier accepted turn (or is that
// session's own reply). A start sends the window. A resume is refused unless
// every line the record does not cover is in the window and the window does
// not reach behind the line the session's start left out, and it sends again
// any line whose text changed since it was shown. A teammate's report is the
// case that happens: its row stores no text and is rendered from the
// request's state as it is now. So is the latest line, which reads without
// its attachment tag on the turn that carries the image and with it
// afterwards. (A digest row gains its file list only where a turn took a
// checkpoint, which a room turn does not; it would be sent again too.)
// Everything that reads the transcript to decide what else the turn says
// ("in the conversation above") therefore stays true.
//
// When a record is not trusted, and the next turn is a start:
//
//   no record            first turn here, a server restart, the thread forgotten
//   the room's reset     the 90% threshold or Compact now (sent with the reset)
//   a native compaction  the engine's PreCompact / SessionStart(compact) hook
//                        names the thread and member: the session now holds
//                        the engine's summary in place of the room's lines.
//                        The record is dropped, and a turn in flight is not
//                        trusted when it settles, though it completes ok
//   close to compaction  the member's last measured context here is at 80% or
//                        more of what the engine compacts at
//   how the turn ended   not ok, never seen to end, or in another session
//                        than the one the record names
//   who spoke last       another member's turn on this thread and instance:
//                        a driver keeps one process per thread
//   what changed         the instance or its adapter, or anything in the
//                        turn's standing input (the fingerprint)
//   time                 longer than the driver keeps a quiet process
//   the lines            one it was never shown is outside the window, the
//                        window reaches behind its start, or its anchors left
//
// The aim is a resume only where main would have gone on in that same
// session: the same member spoke last, nothing the harness hands the driver
// changed, and the driver's idle time has not passed. The harness cannot see
// everything a driver keys its process on (the project's .mcp.json, the
// account's credentials, a base URL, a model alias), nor a warm process that
// ended by itself. In those cases the driver reopens the recorded session
// from disk, which holds what the record says, where main would have started
// a new one. Any doubt the harness can see gives a start, which is what the
// room does today. Nothing is persisted: a record describes a warm process,
// and warm processes do not outlive this server either.
//
// A host module (server/host/README.md): everything it reads is handed in.
import { createHash } from "node:crypto";

import type { RuntimeEvent } from "../contracts.ts";
import { Handoffs, handedStateUsable, sessionStart, unseenMessages, type HandedState, type HandoffStore, type SessionStart } from "../delta-context.ts";
import { sessionIdlePolicy } from "../drivers/session-idle.ts";
import { roomSessionsEnabled } from "../room-context-settings.ts";
import type { Message } from "../store.ts";
import { isRoomContextMessage, type RoomLine, type RoomWindow } from "./room-transcript.ts";

/** The engines a room session is kept for, by driver kind, each with the name
 * its driver reads its idle policy under (drivers/session-idle.ts). Claude
 * Code alone: it is the engine that goes on in a warm session between room
 * turns today. Widening this is one entry; the engine must also declare
 * `strictResume`, the contract a delta depends on, and report its own
 * compactions through the engine-hook channel. */
export const ROOM_SESSION_ENGINES: Readonly<Record<string, string>> = { claudeAgent: "CLAUDE" };

/** How long after a member's last turn its room session is still resumed: as
 * long as the engine's driver keeps a quiet process, the same number the
 * driver arms its idle timer with. Undefined for an engine that is not
 * covered. */
export function roomSessionIdleMs(driverKind: string, env: Record<string, string | undefined> = process.env): number | undefined {
  return Object.hasOwn(ROOM_SESSION_ENGINES, driverKind) ? sessionIdlePolicy(ROOM_SESSION_ENGINES[driverKind]!, env).idleMs : undefined;
}

/** A session this close to where its engine compacts is not handed a delta:
 * the turn that compacts would be answered from the engine's summary plus
 * the new lines alone. */
const NEAR_COMPACTION = 0.8;

/** A turn never seen to end is given up after this long, with its record. No
 * room turn is given longer (rooms.turnTimeoutMinutes tops out at a day); one
 * that waits on a person past it simply starts again afterwards. */
const ABANDONED_TURN_MS = 24 * 60 * 60_000;

/** The provider instance a room turn runs on, as far as this module reads it. */
export interface RoomSessionEngine {
  instanceId: string;
  driverKind: string;
  adapter: { capabilities: { strictResume?: boolean } };
}

export interface RoomSessionsDeps {
  /** config.json's `context` group, read at every dispatch. */
  settings(): { roomSessions?: boolean } | undefined;
  /** Where OMB_ROOM_SESSIONS is read; the process environment unless given. */
  env?: NodeJS.ProcessEnv;
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
  /** The engine-hook channel is mounted for this turn: the one way the
   * harness hears that the engine compacted the session. */
  hooks: boolean;
  /** The member's last measured context in this room, and the token count
   * its engine compacts a session at when that is a known number. Asked for
   * only when a resume is otherwise possible. */
  context?(): { tokens?: number; window?: number; compactAt?: number } | undefined;
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
  /** Immediately before sendTurn, in the same synchronous step. Never
   * throws for a reason of its own: a fault inside is answered with today's
   * call. */
  dispatch(input: RoomDispatchInput): RoomDispatch;
  bindTurn(threadId: string, claimId: string, turnId: string | undefined): void;
  /** Every provider event of a room thread, from the main fold. */
  onEvent(event: RuntimeEvent): void;
  /** The engine compacted this member's session on this thread: what it was
   * handed is no longer what it holds. */
  distrust(threadId: string, botId: string): void;
  /** The thread is gone. */
  forget(threadId: string): void;
  /** How much is held, for tests and diagnostics: records, turns in flight,
   * last speakers, and remembered line hashes across all records. */
  tracked(): { records: number; flights: number; speakers: number; lines: number };
}

/** How a line the session wrote itself is marked until it first appears in a
 * window: its own words, taken as they read then. */
const OWN = "";

interface MemberRecord {
  instanceId: string;
  /** The adapter the session lives in. An instance reloaded under the same
   * id is a new adapter, and the old one's processes went with it. */
  adapter: object;
  handed: HandedState;
  /** A short hash of each window line as this session was handed it, by
   * message id (OWN for a reply it wrote). Kept to the lines of the last
   * window read: a line outside it cannot be sent again anyway. */
  texts: Map<string, string>;
  /** When its last managed turn was seen to complete ok. Absent until then:
   * a record is trusted for the next turn only after that. */
  settledAt?: number;
}

interface Flight {
  botId: string;
  instanceId: string;
  adapter: object;
  claimId: string;
  since: number;
  turnId?: string;
  /** The last session the driver announced for the turn. */
  session?: string;
  /** The engine compacted the session while the turn ran. */
  distrusted?: true;
  /** What a session that starts on this turn is shown: every window line. */
  window: Map<string, string>;
  /** What the session this turn resumes is shown on top of what it holds. */
  delta: Map<string, string>;
}

type DeltaLine = RoomLine & { earlier?: boolean; updated?: boolean };

const DELTA_NOTE = "[Messages this conversation received since your last turn in this room, oldest first. Your session already holds the conversation before them.]";
const DELTA_NONE = "[Messages this conversation received since your last turn in this room: none.]";

/** The lines a resumed session is sent, as the window renders them, under one
 * note: first those it was shown before that read differently now, then
 * those older than what it holds, then the new ones. The note's opening is
 * one escapeNotes already defuses in every transcript line
 * (server/peer-provenance.ts), so no line can pose as this block. */
export function renderRoomDelta(lines: ReadonlyArray<DeltaLine>): string {
  if (lines.length === 0) return DELTA_NONE;
  const updated = lines.filter((line) => line.updated);
  const earlier = lines.filter((line) => line.earlier && !line.updated);
  const fresh = lines.filter((line) => !line.earlier && !line.updated);
  return [
    DELTA_NOTE,
    ...(updated.length ? [updated.length === 1
      ? "(The first message was shown to you before and has changed since: this copy replaces what you were shown.)"
      : `(The first ${updated.length} messages were shown to you before and have changed since: these copies replace what you were shown.)`] : []),
    ...updated.map((line) => line.text),
    ...(earlier.length ? [`(The ${updated.length ? "next" : "first"} ${earlier.length === 1 ? "message is" : `${earlier.length} messages are`} older than messages you have already seen.)`] : []),
    ...earlier.map((line) => line.text),
    ...fresh.map((line) => line.text),
  ].join("\n");
}

const lineHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function createRoomSessions(deps: RoomSessionsDeps): RoomSessions {
  const now = deps.now ?? Date.now;
  /** thread → member → the one session recorded for it there */
  const records = new Map<string, Map<string, MemberRecord>>();
  /** thread → the managed turn dispatched there whose completion the fold has not seen */
  const inFlight = new Map<string, Flight>();
  /** thread → instance → the member whose turn was dispatched there last,
   * managed or not: a driver keeps one process per thread, and it belongs to
   * whoever spoke last on that instance */
  const lastSpeakers = new Map<string, Map<string, { botId: string; at: number }>>();

  const drop = (threadId: string, botId: string) => {
    const members = records.get(threadId);
    if (!members?.delete(botId)) return;
    if (!members.size) records.delete(threadId);
  };
  const land = (threadId: string) => {
    inFlight.delete(threadId);
    handoffs.forget(threadId);
  };

  const roomStore: HandoffStore = {
    order: (threadId) => deps.messagesFor(threadId).filter(isRoomContextMessage).map((m) => m.id),
    read: (botId, threadId, instanceId) => {
      const record = records.get(threadId)?.get(botId);
      return record?.instanceId === instanceId ? record.handed : undefined;
    },
    write: (botId, threadId, instanceId, state) => {
      // Only the turn in flight on the thread writes, and not one whose
      // session the engine compacted meanwhile.
      const flight = inFlight.get(threadId);
      if (!flight || flight.distrusted || flight.botId !== botId || flight.instanceId !== instanceId) return;
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
      // Handoffs writes once the provider acted on the prompt. The session
      // the turn resumed then holds the delta on top of what it was shown
      // before; a session that starts on the turn, or that a driver rebuilt
      // from the whole turn, was shown the window.
      const previous = members.get(botId);
      const texts = handed.session === undefined ? new Map<string, string>()
        : previous?.handed.session === handed.session ? new Map([...previous.texts, ...flight.delta])
        : new Map(flight.window);
      members.set(botId, { instanceId, adapter: flight.adapter, handed, texts });
    },
    // Working notes included: the session wrote them itself.
    replies: (threadId, turnId) => deps.messagesFor(threadId)
      .filter((m) => m.role === "bot" && m.kind === "text" && m.turnId === turnId).map((m) => m.id),
  };
  const handoffs = new Handoffs(roomStore);

  /** Everything held is let go: the setting is off. */
  function clear(): void {
    for (const threadId of inFlight.keys()) handoffs.forget(threadId);
    records.clear();
    inFlight.clear();
    lastSpeakers.clear();
  }

  /** Let go of what can no longer matter: a record or a last speaker older
   * than any session lives, and a turn nobody saw end. A thread that was
   * deleted or abandoned would otherwise hold its adapter for good. */
  function prune(at: number): void {
    const life = Math.max(0, ...Object.keys(ROOM_SESSION_ENGINES).map((kind) => roomSessionIdleMs(kind) ?? 0));
    for (const [threadId, flight] of inFlight) {
      if (at - flight.since <= ABANDONED_TURN_MS) continue;
      land(threadId);
      drop(threadId, flight.botId);
    }
    for (const [threadId, members] of records) {
      for (const [botId, record] of members) {
        const stale = record.settledAt === undefined ? inFlight.get(threadId)?.botId !== botId : at - record.settledAt > life;
        if (stale) members.delete(botId);
      }
      if (!members.size) records.delete(threadId);
    }
    for (const [threadId, speakers] of lastSpeakers) {
      for (const [instanceId, last] of speakers) if (at - last.at > life) speakers.delete(instanceId);
      if (!speakers.size) lastSpeakers.delete(threadId);
    }
  }

  /** Whether the member's session is close to where its engine compacts it.
   * "auto" and "off" give the engine's threshold no number; the model's
   * window is then the only bound known. No reading, nothing to compare. */
  function nearCompaction(context: ReturnType<NonNullable<RoomDispatchInput["context"]>>): boolean {
    const tokens = context?.tokens;
    if (typeof tokens !== "number" || !(tokens > 0)) return false;
    const usable = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
    const threshold = usable(context?.compactAt) ?? usable(context?.window);
    return threshold !== undefined && tokens >= NEAR_COMPACTION * threshold;
  }

  /** The window's lines the member's session must be sent, when every
   * condition for sending only those holds. Undefined: start instead. */
  function unseenLines(
    record: MemberRecord | undefined, input: RoomDispatchInput, config: string, idleMs: number,
  ): { session: string; lines: DeltaLine[]; shown: Map<string, string> } | undefined {
    if (!record || input.reset) return undefined;
    const { handed, texts } = record;
    const { order, lines: window, readable } = input.window;
    if (record.instanceId !== input.instance.instanceId || record.adapter !== input.instance.adapter) return undefined;
    if (handed.config !== config) return undefined;
    if (record.settledAt === undefined || now() - record.settledAt > idleMs) return undefined;
    if (handed.session === undefined || !handedStateUsable(handed, handed.session, order)) return undefined;
    if (nearCompaction(input.context?.())) return undefined;
    // The window must not reach behind the line the session's start left
    // out: such a line is in the window, was never shown, and is not offered.
    if (handed.omitted !== undefined && window.length && order.indexOf(window[0]!.id) <= order.indexOf(handed.omitted)) return undefined;
    const inWindow = new Set(window.map((line) => line.id));
    const unseen = new Map(unseenMessages(readable.map((id) => ({ id, role: "user" as const, text: "" })), order, handed)
      .map((message) => [message.id, message.earlier === true]));
    // It missed more than the window holds: a delta would have a hole in it.
    for (const id of unseen.keys()) if (!inWindow.has(id)) return undefined;
    // A line outside the window cannot be sent again; its hash is let go.
    for (const id of texts.keys()) if (!inWindow.has(id)) texts.delete(id);
    const lines: DeltaLine[] = [];
    const shown = new Map<string, string>();
    for (const line of window) {
      const hash = lineHash(line.text);
      const earlier = unseen.get(line.id);
      const known = texts.get(line.id);
      if (earlier === undefined && known === OWN) {
        // Its own reply: the session holds the words, and the room's line
        // for them is taken as it reads the first time a window shows it.
        texts.set(line.id, hash);
        continue;
      }
      if (earlier === undefined && known === hash) continue;
      shown.set(line.id, hash);
      // Not handed yet; or handed, and reading differently now; or counted
      // as handed without ever having been a line of this session's window
      // (it returned to the window after scrolling out): sent as older.
      lines.push(earlier !== undefined ? (earlier ? { ...line, earlier: true } : line)
        : known === undefined ? { ...line, earlier: true } : { ...line, updated: true });
    }
    return { session: handed.session, lines, shown };
  }

  function decide(input: RoomDispatchInput, full: string, today: RoomDispatch["send"]): RoomDispatch {
    const { threadId, botId, instance, window } = input;
    const legacy = (): RoomDispatch => ({ mode: "legacy", text: full, send: today });
    // Off: no fingerprint, no hash, no record. What was held is let go.
    if (!roomSessionsEnabled(deps.settings(), deps.env)) {
      clear();
      return legacy();
    }
    const at = now();
    prune(at);

    // A managed turn that was never seen to end (timed out, stalled, stopped
    // in the handshake, rejected at dispatch): its member's record is not
    // trusted any more.
    const stale = inFlight.get(threadId);
    if (stale) drop(threadId, stale.botId);
    land(threadId);

    const speakers = lastSpeakers.get(threadId) ?? new Map<string, { botId: string; at: number }>();
    lastSpeakers.set(threadId, speakers);
    const spokeLast = speakers.get(instance.instanceId)?.botId === botId;
    speakers.set(instance.instanceId, { botId, at });

    const idleMs = roomSessionIdleMs(instance.driverKind);
    if (idleMs === undefined || instance.adapter.capabilities.strictResume !== true || !input.hooks || input.guestConfined) {
      drop(threadId, botId);
      return legacy();
    }

    const config = createHash("sha256").update(JSON.stringify(input.config)).digest("hex");
    const { order } = window;
    const ids = window.lines.map((line) => line.id);
    const first = ids.length ? order.indexOf(ids[0]!) : order.length;
    // A session that starts on this turn holds the window and what lies
    // between its lines; everything before it is left out, as it is today.
    const started = sessionStart(order, ids, order.slice(first));
    // Never credited with anything it was not sent.
    const nothing: SessionStart = { ...(order.length ? { omitted: order.at(-1)! } : {}), sent: [] };
    const handoff = { botId, instanceId: instance.instanceId, config, started, recovery: started, resumed: nothing, carried: [], own: [] };
    const fly = (delta: Map<string, string>) => {
      handoffs.dispatching(threadId, input.claimId);
      inFlight.set(threadId, {
        botId, instanceId: instance.instanceId, adapter: instance.adapter, claimId: input.claimId, since: at,
        window: new Map(window.lines.map((line) => [line.id, lineHash(line.text)])), delta,
      });
    };

    // Another member's turn on this instance took the driver's one process
    // for the thread: main starts a new session here, and so does this.
    const delta = spokeLast ? unseenLines(records.get(threadId)?.get(botId), input, config, idleMs) : undefined;
    if (!delta) {
      drop(threadId, botId);
      handoffs.begin(threadId, input.claimId, { ...handoff, resumeCursor: undefined, placed: [] });
      fly(new Map());
      return { mode: "start", text: full, send: today };
    }
    // Once the provider acts on this turn its session is current through
    // everything the thread held when the window was read: the lines it is
    // shown now, and the working notes between them that no reader is shown.
    handoffs.begin(threadId, input.claimId, { ...handoff, resumeCursor: delta.session, placed: [...order] });
    fly(delta.shown);
    return {
      mode: "resume",
      text: input.wrap(renderRoomDelta(delta.lines) + input.tail),
      send: { resumeCursor: delta.session, recoveryText: full },
    };
  }

  return {
    dispatch(input) {
      // Main's own expressions: if these throw, main's call would have too.
      const full = input.wrap(input.window.text + input.tail);
      const today: RoomDispatch["send"] = input.reset ? { sessionReset: true } : {};
      try {
        return decide(input, full, today);
      } catch (error) {
        // A fault in the bookkeeping must never cost the room its turn: the
        // turn goes out as it does today, and nothing of it is remembered.
        try {
          land(input.threadId);
          drop(input.threadId, input.botId);
        } catch { /* nothing more to let go of */ }
        console.warn(`room sessions: sent the whole window instead (${error instanceof Error ? error.message : String(error)})`);
        return { mode: "legacy", text: full, send: today };
      }
    },
    bindTurn(threadId, claimId, turnId) {
      handoffs.bindTurn(threadId, claimId, turnId);
      const flight = inFlight.get(threadId);
      if (flight?.claimId === claimId) flight.turnId ??= turnId;
    },
    onEvent(event) {
      handoffs.onEvent(event);
      if (event.type !== "turn.completed" && event.type !== "session.started") return;
      const flight = inFlight.get(event.threadId);
      if (!flight || event.providerInstanceId !== flight.instanceId) return;
      if (flight.turnId && event.turnId && event.turnId !== flight.turnId) return;
      if (event.type === "session.started") {
        // Handoffs stops listening for a session once the provider has
        // acted; a driver that relaunches after that ends the turn somewhere
        // the record does not describe. Kept to compare at the end.
        if (event.sessionId) flight.session = event.sessionId;
        return;
      }
      inFlight.delete(event.threadId);
      // Trusted for the member's next turn only when this one was seen to
      // complete ok, in the session the record names, with no compaction
      // reported meanwhile. A stop, a provider error, a hold or a parked
      // seat ends the turn not ok.
      const record = records.get(event.threadId)?.get(flight.botId);
      if (!event.ok || flight.distrusted || !record || record.handed.session === undefined || record.handed.session !== flight.session) {
        drop(event.threadId, flight.botId);
        return;
      }
      record.settledAt = now();
      const turnId = event.turnId ?? flight.turnId;
      if (turnId) for (const id of roomStore.replies(event.threadId, turnId)) record.texts.set(id, OWN);
    },
    distrust(threadId, botId) {
      drop(threadId, botId);
      const flight = inFlight.get(threadId);
      if (flight?.botId === botId) flight.distrusted = true;
    },
    forget(threadId) {
      records.delete(threadId);
      lastSpeakers.delete(threadId);
      land(threadId);
    },
    tracked() {
      const count = (map: Map<string, Map<string, unknown>>) => [...map.values()].reduce((n, inner) => n + inner.size, 0);
      const lines = [...records.values()].flatMap((members) => [...members.values()]).reduce((n, record) => n + record.texts.size, 0);
      return { records: count(records), flights: inFlight.size, speakers: count(lastSpeakers), lines };
    },
  };
}
