import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { sessionIdlePolicy } from "../drivers/session-idle.ts";
import { escapeNotes } from "../peer-provenance.ts";
import type { Message } from "../store.ts";
import { turnClockLine, withTurnClock } from "../turn-clock.ts";
import {
  createRoomSessions, renderRoomDelta, ROOM_SESSION_ENGINES, roomSessionIdleMs,
  type RoomDispatch, type RoomDispatchInput, type RoomSessionEngine,
} from "./room-sessions.ts";
import { createRoomTranscript, GROUP_CONTEXT_MESSAGES } from "./room-transcript.ts";

const NOTE = "[Messages this conversation received since your last turn in this room, oldest first. Your session already holds the conversation before them.]";
const NONE = "[Messages this conversation received since your last turn in this room: none.]";
const CLOCK = turnClockLine(Date.UTC(2026, 9, 13, 9, 30), "UTC");
const IDLE_MS = sessionIdlePolicy("CLAUDE").idleMs;

const engine = (instanceId: string, driverKind = "claudeAgent", strictResume = true): RoomSessionEngine =>
  ({ instanceId, driverKind, adapter: { capabilities: { strictResume } } });
const colors: Record<string, string> = { editor: "green", writer: "blue", scout: "red" };
const from = (botId: string) => ({ botId, name: botId[0]!.toUpperCase() + botId.slice(1), color: colors[botId] ?? "green" });
const tailFor = (botId: string, extra = "") => `\n\n(Reply to the conversation above as ${from(botId).name}.)${extra}`;
/** What server/index.ts wraps a room turn's text in: the clock line and the recalled block. */
const wrapWith = (recalled = "") => (body: string) => withTurnClock(CLOCK, recalled ? `${recalled}\n\n${body}` : body);

/** One room on a fake store, with the engine's side of a turn played by hand:
 * what the fold in server/index.ts would see, in the order it sees it. */
function room(options: { threadId?: string; shared?: { messages: Map<string, Message[]>; sessions: ReturnType<typeof createRoomSessions> } } = {}) {
  const threadId = options.threadId ?? "room";
  const state = { enabled: true, now: 1_000_000 };
  const threads = options.shared?.messages ?? new Map<string, Message[]>();
  if (!threads.has(threadId)) threads.set(threadId, []);
  const messages = threads.get(threadId)!;
  const transcript = createRoomTranscript({
    store: { messagesFor: (id) => threads.get(id) ?? [] },
    teammateReportContext: (requestId) => `[report ${requestId}]`,
  });
  const create = () => createRoomSessions({ enabled: () => state.enabled, messagesFor: (id) => threads.get(id) ?? [], now: () => state.now });
  let sessions = options.shared?.sessions ?? create();
  const claude = engine("claude");
  let serial = 0;
  let events = 0;

  const add = (fields: Partial<Message>): string => {
    const id = `${threadId}-m${messages.length}`;
    messages.push({ id, at: messages.length, role: "user", kind: "text", ...fields });
    return id;
  };
  /** A line the person typed; the returned sentinel is in its text exactly once. */
  const say = (text: string) => add({ text });
  const botSays = (botId: string, text: string, fields: Partial<Message> = {}) => add({ role: "bot", text, from: from(botId), ...fields });

  type Turn = { botId: string; claimId: string; turnId: string; instance: RoomSessionEngine; result: RoomDispatch; input: RoomDispatchInput };
  const dispatch = (botId: string, overrides: Partial<RoomDispatchInput> = {}): Turn => {
    serial += 1;
    const input: RoomDispatchInput = {
      threadId, botId, claimId: `claim-${serial}`, instance: claude, guestConfined: false, reset: false,
      config: ["You are a bot in the room.", "/work", { instanceId: "claude", model: "opus" }],
      window: transcript.window(threadId, "Omkar", undefined, botId), tail: tailFor(botId), wrap: wrapWith(),
      ...overrides,
    };
    const turn = { botId, claimId: input.claimId, turnId: `turn-${serial}`, instance: input.instance, result: sessions.dispatch(input), input };
    return turn;
  };
  const emit = (turn: Turn, event: Record<string, unknown>) => sessions.onEvent({
    eventId: `e${events++}`, provider: turn.instance.driverKind, providerInstanceId: turn.instance.instanceId, threadId, createdAt: "", turnId: turn.turnId, ...event,
  } as RuntimeEvent);
  const bind = (turn: Turn) => sessions.bindTurn(threadId, turn.claimId, turn.turnId);
  const output = { type: "content.delta", streamKind: "assistant_text", delta: "…" };
  /** The provider runs the turn in `session`, says `reply` (after any working
   * `notes`), and completes. The store marks the final message afterwards, as
   * the fold does. */
  const finish = (turn: Turn, session: string, play: { reply?: string; notes?: string[]; ok?: boolean; rebuilt?: boolean; during?: () => void } = {}) => {
    bind(turn);
    emit(turn, { type: "turn.started" });
    emit(turn, { type: "session.started", sessionId: session, ...(play.rebuilt ? { rebuilt: true } : {}) });
    emit(turn, output);
    play.during?.();
    for (const note of play.notes ?? []) botSays(turn.botId, note, { turnId: turn.turnId });
    const reply = play.reply === undefined ? undefined : botSays(turn.botId, play.reply, { turnId: turn.turnId });
    emit(turn, { type: "turn.completed", ok: play.ok ?? true });
    const terminal = messages.find((m) => m.id === reply);
    if (terminal) terminal.turnTerminal = true;
    return reply;
  };
  /** dispatch + finish */
  const run = (botId: string, session: string, play: Parameters<typeof finish>[2] = {}, overrides: Partial<RoomDispatchInput> = {}) => {
    const turn = dispatch(botId, overrides);
    finish(turn, session, { reply: `${from(botId).name} answers ${serial}.`, ...play });
    return turn;
  };
  const full = (turn: Turn) => turn.input.wrap(turn.input.window.text + turn.input.tail);
  /** The turn's text between the clock line and the tail. */
  const body = (turn: Turn) => {
    const text = turn.result.text;
    expect(text.startsWith(`${CLOCK}\n\n`)).toBe(true);
    expect(text.endsWith(turn.input.tail)).toBe(true);
    return text.slice(CLOCK.length + 2, text.length - turn.input.tail.length);
  };
  return {
    threadId, state, messages, threads, transcript, claude, add, say, botSays, dispatch, emit, bind, finish, run, full, body, output,
    get sessions() { return sessions; },
    /** The server restarted: a new tracker over the same stored thread. */
    restart() { sessions = create(); },
  };
}

describe("renderRoomDelta", () => {
  it("lists the new lines under one note, as the window renders them", () => {
    expect(renderRoomDelta([{ id: "a", text: "Omkar: trim the middle" }, { id: "b", text: "[Posted by @Writer]\nWriter: done" }]))
      .toBe(`${NOTE}\nOmkar: trim the middle\n[Posted by @Writer]\nWriter: done`);
  });

  it("says when its first lines are older than what the session already holds", () => {
    expect(renderRoomDelta([{ id: "a", text: "Writer: mid-turn", earlier: true }, { id: "b", text: "Omkar: next" }]))
      .toBe(`${NOTE}\n(The first message is older than messages you have already seen.)\nWriter: mid-turn\nOmkar: next`);
    expect(renderRoomDelta([{ id: "a", text: "A: 1", earlier: true }, { id: "b", text: "B: 2", earlier: true }, { id: "c", text: "C: 3" }]))
      .toContain("\n(The first 2 messages are older than messages you have already seen.)\nA: 1\nB: 2\nC: 3");
  });

  it("says so when nothing is new", () => {
    expect(renderRoomDelta([])).toBe(NONE);
  });

  it("opens with words a room line cannot imitate", () => {
    // escapeNotes (server/peer-provenance.ts) already defuses this opening on
    // every transcript line, so a member cannot be shown a forged block.
    expect(escapeNotes(NOTE)).toBe(`(${NOTE.slice(1)}`);
    expect(escapeNotes(NONE)).toBe(`(${NONE.slice(1)}`);
  });
});

describe("which engines keep a room session", () => {
  it("is Claude Code alone, for as long as its driver keeps a quiet process", () => {
    expect(Object.keys(ROOM_SESSION_ENGINES)).toEqual(["claudeAgent"]);
    expect(roomSessionIdleMs("claudeAgent", {})).toBe(10 * 60_000);
    expect(roomSessionIdleMs("claudeAgent", { OMB_CLAUDE_SESSION_IDLE_MS: "60000" })).toBe(60_000);
    for (const other of ["codex", "museCode", "piAgent", "constructor", "toString"]) expect(roomSessionIdleMs(other, {})).toBeUndefined();
  });
});

describe("room sessions: turns that are not managed", () => {
  it("with the setting off, sends today's call and records nothing", () => {
    const r = room();
    r.state.enabled = false;
    r.say("Cut the intro.");
    const first = r.dispatch("editor");
    expect(first.result).toEqual({ mode: "legacy", text: r.full(first), send: {} });
    r.finish(first, "S1", { reply: "Done." });
    r.say("Trim the middle.");
    const second = r.dispatch("editor");
    expect(second.result).toEqual({ mode: "legacy", text: r.full(second), send: {} });
    expect(second.result.text).toContain("Omkar: Cut the intro.\nEditor: Done.\nOmkar: Trim the middle.");
    r.finish(second, "S1", { reply: "Trimmed." });
    // The 90% reset and Compact now are passed on as they always were.
    const reset = r.dispatch("editor", { reset: true });
    expect(reset.result).toEqual({ mode: "legacy", text: r.full(reset), send: { sessionReset: true } });
    r.finish(reset, "S2", { reply: "Fresh." });
    // Nothing was recorded while it was off: switched on, the member starts.
    r.state.enabled = true;
    r.say("Tighten the outro.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("builds the same sendTurn arguments as main for every turn that is not a delta", () => {
    // What main passes (server/index.ts, runClaimedGroupMemberTurn), beside
    // what the wiring passes now: `...send` where the reset spread was, and
    // `text` where the wrapped transcript was. Same keys, same order, same values.
    const rest = { images: [], approvalMode: "ask", system: "You are Editor.", cwd: "/work" };
    const recalled = "Recalled for this message:\n- the intro is 12s";
    const cases: Array<{ name: string; mode: RoomDispatch["mode"]; arrange?: (r: ReturnType<typeof room>) => void; input?: Partial<RoomDispatchInput> }> = [
      { name: "setting off", mode: "legacy", arrange: (r) => { r.state.enabled = false; } },
      { name: "an engine that does not promise strict resume", mode: "legacy", input: { instance: engine("claude", "claudeAgent", false) } },
      { name: "a strict-resume engine that is not covered", mode: "legacy", input: { instance: engine("codex", "codex", true) } },
      { name: "a guest-confined turn", mode: "legacy", input: { guestConfined: true } },
      { name: "a member's first managed turn", mode: "start" },
    ];
    for (const scenario of cases) {
      for (const reset of [false, true]) {
        const r = room();
        scenario.arrange?.(r);
        r.say("Cut the intro.");
        r.botSays("writer", "On it.", { turnTerminal: true, turnId: "t0" });
        const window = r.transcript.window("room", "Omkar", undefined, "editor");
        const tail = tailFor("editor", "\n\nYour last turn in this room ended without a final message to the room.");
        const main = {
          ...(reset ? { sessionReset: true } : {}),
          threadId: "room",
          botId: "editor",
          text: withTurnClock(CLOCK, `${recalled}\n\n${window.text + tail}`),
          recalled,
          ...rest,
        };
        const session = r.dispatch("editor", { reset, window, tail, wrap: wrapWith(recalled), ...scenario.input }).result;
        const ours = { ...session.send, threadId: "room", botId: "editor", text: session.text, recalled, ...rest };
        expect(session.mode, scenario.name).toBe(scenario.mode);
        expect(ours, scenario.name).toStrictEqual(main);
        expect(JSON.stringify(ours), scenario.name).toBe(JSON.stringify(main));
        expect("resumeCursor" in ours || "recoveryText" in ours, scenario.name).toBe(false);
      }
    }
  });

  it("leaves an engine that does not promise strict resume, and any engine but Claude Code, alone", () => {
    // an adapter that does not declare the capability at all (an older Claude CLI reads as false)
    const undeclared: RoomSessionEngine = { instanceId: "claude", driverKind: "claudeAgent", adapter: { capabilities: {} } };
    for (const instance of [engine("claude", "claudeAgent", false), undeclared, engine("codex", "codex"), engine("muse", "museCode")]) {
      const r = room();
      r.say("Cut the intro.");
      const first = r.dispatch("editor", { instance });
      expect(first.result).toEqual({ mode: "legacy", text: r.full(first), send: {} });
      r.finish(first, "S1", { reply: "Done." });
      r.say("Trim the middle.");
      const second = r.dispatch("editor", { instance });
      expect(second.result).toEqual({ mode: "legacy", text: r.full(second), send: {} });
    }
  });

  it("drops a member's record when one of its turns is not managed, and never records a guest-confined turn", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    // Its record is usable here (the other tests resume at this point), and a
    // confined turn must neither use it nor leave it for a later turn.
    const confined = r.dispatch("editor", { guestConfined: true });
    expect(confined.result).toEqual({ mode: "legacy", text: r.full(confined), send: {} });
    r.finish(confined, "S-guest", { reply: "Confined answer." });
    r.say("Tighten the outro.");
    const after = r.dispatch("editor");
    // neither a delta against S1 nor one against the confined turn's session
    expect(after.result).toEqual({ mode: "start", text: r.full(after), send: {} });
  });

  it("starts again after the setting was switched off and on", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.state.enabled = false;
    r.say("Trim the middle.");
    r.run("editor", "S1");
    r.state.enabled = true;
    r.say("Tighten the outro.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

describe("room sessions: a member's own session", () => {
  it("starts with today's call exactly: the whole window, no reset and no cursor", () => {
    const r = room();
    r.say("Cut the intro.");
    const first = r.dispatch("editor");
    expect(first.result).toStrictEqual({ mode: "start", text: r.full(first), send: {} });
    expect(first.result.text).toBe(`${CLOCK}\n\nOmkar: Cut the intro.\n\n(Reply to the conversation above as Editor.)`);
  });

  it("resumes the session that ran its last turn and sends only the lines since", () => {
    const r = room();
    r.say("Cut the intro. ALPHA");
    r.run("editor", "S1", { reply: "Intro cut. BRAVO" });
    r.say("Trim the middle. CHARLIE");
    const second = r.dispatch("editor");
    expect(second.result).toStrictEqual({
      mode: "resume",
      text: `${CLOCK}\n\n${NOTE}\nOmkar: Trim the middle. CHARLIE\n\n(Reply to the conversation above as Editor.)`,
      send: { resumeCursor: "S1", recoveryText: r.full(second) },
    });
    // If the driver has to rebuild, it rebuilds from the whole turn.
    expect(second.result.send.recoveryText).toContain("Omkar: Cut the intro. ALPHA\nEditor: Intro cut. BRAVO\nOmkar: Trim the middle. CHARLIE");
    r.finish(second, "S1", { reply: "Middle trimmed. DELTA" });
    r.say("Tighten the outro. ECHO");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: Tighten the outro. ECHO`);
  });

  it("keeps the tail, a card continuation included, on a delta", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Go on.");
    const tail = tailFor("editor", "\n\nThe person answered your question: yes.");
    const turn = r.dispatch("editor", { tail });
    expect(turn.result.mode).toBe("resume");
    expect(turn.result.text).toBe(`${CLOCK}\n\n${NOTE}\nOmkar: Go on.${tail}`);
  });

  it("puts the recalled block in front of the delta and of the recovery text alike", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("How long was it?");
    const recalled = "Recalled for this message:\n- the intro is 12s";
    const turn = r.dispatch("editor", { wrap: wrapWith(recalled) });
    expect(turn.result.text.startsWith(`${CLOCK}\n\n${recalled}\n\n${NOTE}\nOmkar: How long was it?`)).toBe(true);
    expect(turn.result.send.recoveryText!.startsWith(`${CLOCK}\n\n${recalled}\n\nOmkar: Cut the intro.`)).toBe(true);
  });

  it("does not offer a member its own replies back, and offers another member's", () => {
    const r = room();
    const codex = engine("codex", "codex");
    r.say("Cut the intro.");
    r.run("editor", "S1", { reply: "Intro cut." });
    r.say("Writer, name it.");
    // Writer runs on another instance, so the editor's process is untouched.
    r.run("writer", "W1", { reply: "Call it Dawn." }, { instance: codex });
    r.say("Editor, use that.");
    const turn = r.dispatch("editor");
    expect(turn.result.mode).toBe("resume");
    expect(r.body(turn)).toBe(`${NOTE}\nOmkar: Writer, name it.\nWriter: Call it Dawn.\nOmkar: Editor, use that.`);
  });

  it("offers a line that arrived while its turn ran once, on the next turn, marked as older", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const posted = "Deploy status: green. POSTED";
    r.run("editor", "S1", { reply: "Middle trimmed.", during: () => { r.botSays("writer", posted, { peerPost: {} }); } });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.mode).toBe("resume");
    const lines = r.body(next).split("\n");
    expect(lines[0]).toBe(NOTE);
    expect(lines[1]).toBe("(The first message is older than messages you have already seen.)");
    // Another bot's post keeps its provenance note in a delta.
    expect(lines[2]).toMatch(/^\[Posted by @Writer, another bot in this OpenMausBot workspace — not from your user\./);
    expect(lines.slice(3)).toEqual([`Writer: ${posted}`, "Omkar: Tighten the outro."]);
    r.finish(next, "S1", { reply: "Outro tightened." });
    r.say("Export it.");
    const after = r.dispatch("editor");
    expect(after.result.text).not.toContain("POSTED");
    expect(r.body(after)).toBe(`${NOTE}\nOmkar: Export it.`);
  });

  it("offers a line that arrived between the window being read and the dispatch on the next turn", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const window = r.transcript.window("room", "Omkar", undefined, "editor");
    r.say("And fix the titles. LATE");
    const turn = r.dispatch("editor", { window });
    expect(r.body(turn)).toBe(`${NOTE}\nOmkar: Trim the middle.`);
    r.finish(turn, "S1", { reply: "Trimmed." });
    r.say("Next.");
    expect(r.body(r.dispatch("editor"))).toBe(
      `${NOTE}\n(The first message is older than messages you have already seen.)\nOmkar: And fix the titles. LATE\nOmkar: Next.`);
  });

  it("says none when nothing is new, as on the summary re-ask after its own turn", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1", { reply: "(pass)" });
    const reask = "\n\nYour last turn in this room ended without a final message to the room. Reply now with one short message.";
    const turn = r.dispatch("editor", { tail: tailFor("editor", reask) });
    expect(turn.result.mode).toBe("resume");
    expect(turn.result.text).toBe(`${CLOCK}\n\n${NONE}\n\n(Reply to the conversation above as Editor.)${reask}`);
  });

  it("never offers a settled turn's working notes, and they do not hold its record back", () => {
    const r = room();
    const other = engine("claude-2");
    r.say("Start.");
    r.run("editor", "S1", { notes: ["Let me look. NOTE", "Found it. NOTE"], reply: "Done 0." });
    // Far more rounds than a record keeps loose ids for. The writer's notes
    // sit between the lines the editor is shown and are hidden once the
    // writer's turn settles: left unfolded, they would hold the editor's
    // record at round one and it would be given up long before the end.
    for (let round = 1; round <= 120; round++) {
      r.say(`Writer, step ${round}.`);
      r.run("writer", "W1", { notes: ["Looking. NOTE", "Still looking. NOTE"], reply: `Writer did ${round}.` }, { instance: other });
      r.say(`Editor, step ${round}.`);
      const next = r.dispatch("editor");
      expect(next.result.mode, `round ${round}`).toBe("resume");
      expect(r.body(next), `round ${round}`).toBe(`${NOTE}\nOmkar: Writer, step ${round}.\nWriter: Writer did ${round}.\nOmkar: Editor, step ${round}.`);
      r.finish(next, "S1", { notes: ["Checking. NOTE"], reply: `Editor did ${round}.` });
    }
  });

  it("sends a whole window's worth as a delta, and starts again when the member missed more than that", () => {
    const r = room();
    r.say("Start.");
    r.run("editor", "S1");
    for (let n = 0; n < GROUP_CONTEXT_MESSAGES; n++) r.say(`Line ${n}.`);
    const thirty = r.dispatch("editor");
    expect(thirty.result.mode).toBe("resume");
    expect(r.body(thirty).split("\n")).toEqual([NOTE, ...Array.from({ length: GROUP_CONTEXT_MESSAGES }, (_, n) => `Omkar: Line ${n}.`)]);
    r.finish(thirty, "S1", { reply: "Caught up." });
    for (let n = 0; n < GROUP_CONTEXT_MESSAGES + 10; n++) r.say(`Later ${n}.`);
    const forty = r.dispatch("editor");
    // A delta with a hole in it is never sent: the window on today's call instead.
    expect(forty.result).toStrictEqual({ mode: "start", text: r.full(forty), send: {} });
    expect(forty.result.text).not.toContain("Later 9.");
    expect(forty.result.text).toContain("Omkar: Later 10.\n");
    // The warm session went on (no reset): it is recorded with this window.
    r.finish(forty, "S1", { reply: "Caught up again." });
    r.say("And now?");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: And now?`);
  });

  it("starts again when a line that scrolled out of the window was never shown", () => {
    const r = room();
    r.say("Start.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    // Posted while the turn ran, then pushed out of the window by later lines.
    r.run("editor", "S1", { during: () => { r.botSays("writer", "MISSED mid-turn post", { peerPost: {} }); } });
    for (let n = 0; n < GROUP_CONTEXT_MESSAGES; n++) r.say(`Line ${n}.`);
    const turn = r.dispatch("editor");
    expect(turn.result.mode).toBe("start");
    expect(turn.result.text).not.toContain("MISSED");
  });

  it("starts again when the window reaches behind the line its session's start left out", () => {
    const r = room();
    for (let n = 0; n < 35; n++) r.say(`Old ${n}.`);
    // A turn that has not settled yet: its ten lines are all readable.
    for (let n = 0; n < 10; n++) r.botSays("writer", `Working ${n}.`, { turnId: "writer-turn" });
    r.say("Editor?");
    const first = r.run("editor", "S1");
    expect(first.result.text).toContain("Omkar: Old 16.\n");
    expect(first.result.text).not.toContain("Old 15.");
    // The writer's turn settles: its ten notes are hidden from now on, so the
    // window slides back over lines the editor's session was never shown.
    const final = r.botSays("writer", "Writer's result.", { turnId: "writer-turn", turnTerminal: true });
    expect(r.messages.some((m) => m.id === final)).toBe(true);
    r.say("Editor again?");
    const second = r.dispatch("editor");
    expect(second.result.mode).toBe("start");
    expect(second.result.text).toContain("Omkar: Old 9.\n");
    expect(second.result.text).not.toContain("Old 8.");
  });

  it("starts again when the lines its record is anchored to are gone", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.messages.splice(0, r.messages.length);
    r.say("A new conversation.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

describe("room sessions: when a record is not trusted", () => {
  const ready = () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    return r;
  };

  it("starts fresh at the 90% reset or Compact now, and the next turn is a delta against the new session", () => {
    const r = ready();
    const reset = r.dispatch("editor", { reset: true });
    expect(reset.result).toStrictEqual({ mode: "start", text: r.full(reset), send: { sessionReset: true } });
    r.finish(reset, "S2", { reply: "Fresh." });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.send).toStrictEqual({ resumeCursor: "S2", recoveryText: r.full(next) });
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
  });

  it("starts again after a turn that did not complete ok", () => {
    const r = ready();
    const failed = r.dispatch("editor");
    expect(failed.result.mode).toBe("resume");
    r.finish(failed, "S1", { ok: false });
    r.say("Try again.");
    const next = r.dispatch("editor");
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
  });

  it("starts again after a turn whose completion was never seen, whoever dispatches next", () => {
    for (const nextSpeaker of ["editor", "writer"]) {
      const r = ready();
      const lost = r.dispatch("editor");
      expect(lost.result.mode).toBe("resume");
      r.bind(lost);
      r.emit(lost, { type: "session.started", sessionId: "S1" });
      r.emit(lost, r.output);
      // timed out, stalled, cancelled in the handshake or rejected at dispatch:
      // no turn.completed reaches the fold
      r.say("Anyone?");
      if (nextSpeaker === "writer") r.run("writer", "W1", {}, { instance: engine("claude-2") });
      const next = r.dispatch("editor");
      expect(next.result.mode, nextSpeaker).toBe("start");
    }
  });

  it("does not take a late event of an abandoned turn for the turn that replaced it", () => {
    const r = ready();
    const lost = r.dispatch("editor");
    r.bind(lost);
    r.say("Anyone?");
    const next = r.dispatch("editor");
    expect(next.result.mode).toBe("start");
    r.bind(next);
    // The abandoned turn's events arrive late, under its own turn id. Taken
    // for the new turn, its completion would end that turn's bookkeeping early.
    r.emit(lost, { type: "session.started", sessionId: "S1" });
    r.emit(lost, r.output);
    r.emit(lost, { type: "turn.completed", ok: false });
    r.finish(next, "S2", { reply: "Here." });
    r.say("Still there?");
    const after = r.dispatch("editor");
    expect(after.result.send.resumeCursor).toBe("S2");
    expect(r.body(after)).toBe(`${NOTE}\nOmkar: Still there?`);
  });

  it("ignores events of another instance, and of another turn once its own is known", () => {
    const r = ready();
    const turn = r.dispatch("editor");
    r.bind(turn);
    r.sessions.onEvent({ eventId: "x1", provider: "codex", providerInstanceId: "codex", threadId: "room", createdAt: "", turnId: turn.turnId, type: "turn.completed", ok: false } as RuntimeEvent);
    r.sessions.onEvent({ eventId: "x2", provider: "claudeAgent", providerInstanceId: "claude", threadId: "room", createdAt: "", turnId: "another-turn", type: "turn.completed", ok: false } as RuntimeEvent);
    r.sessions.onEvent({ eventId: "x3", provider: "claudeAgent", providerInstanceId: "claude", threadId: "elsewhere", createdAt: "", turnId: turn.turnId, type: "turn.completed", ok: false } as RuntimeEvent);
    r.emit(turn, { type: "session.started", sessionId: "S1" });
    r.emit(turn, r.output);
    r.botSays("editor", "Trimmed.", { turnId: turn.turnId, turnTerminal: true });
    r.emit(turn, { type: "turn.completed", ok: true });
    r.say("Next.");
    expect(r.body(r.dispatch("editor"))).toBe(`${NOTE}\nOmkar: Next.`);
  });

  it("starts again when anything in its standing configuration changed", () => {
    const base = ["You are Editor, a bot in the room \"Edit bay\".", "/work", { instanceId: "claude", model: "opus", effort: "high" }, "ask", { agents: { env: { OMB_TURN_DEPTH: "0" } } }];
    const changes: unknown[][] = [
      ["You are Editor, a bot in the room \"Cutting room\".", ...base.slice(1)],
      [base[0], "/elsewhere", ...base.slice(2)],
      [...base.slice(0, 2), { instanceId: "claude", model: "sonnet", effort: "high" }, ...base.slice(3)],
      [...base.slice(0, 2), { instanceId: "claude", model: "opus", effort: "low" }, ...base.slice(3)],
      [...base.slice(0, 2), { instanceId: "claude", model: "opus", effort: "high", variant: "1m" }, ...base.slice(3)],
      [...base.slice(0, 3), "full", base[4]],
      [...base.slice(0, 4), { agents: { env: { OMB_TURN_DEPTH: "1" } } }],
      [...base, "one more"],
    ];
    for (const changed of changes) {
      const r = room();
      r.say("Cut the intro.");
      r.run("editor", "S1", {}, { config: base });
      r.say("Trim the middle.");
      expect(r.dispatch("editor", { config: changed }).result.mode, JSON.stringify(changed)).toBe("start");
    }
    const same = room();
    same.say("Cut the intro.");
    same.run("editor", "S1", {}, { config: base });
    same.say("Trim the middle.");
    expect(same.dispatch("editor", { config: structuredClone(base) }).result.mode).toBe("resume");
  });

  it("is not managed when its configuration cannot be fingerprinted", () => {
    const r = ready();
    const cyclic: unknown[] = ["persona"];
    cyclic.push(cyclic);
    const turn = r.dispatch("editor", { config: cyclic });
    expect(turn.result).toStrictEqual({ mode: "legacy", text: r.full(turn), send: {} });
  });

  it("starts again on another instance, and on a reloaded instance of the same name", () => {
    const moved = ready();
    expect(moved.dispatch("editor", { instance: engine("claude-2") }).result.mode).toBe("start");
    const reloaded = ready();
    // same id, a new adapter: the old one's processes are gone with it
    expect(reloaded.dispatch("editor", { instance: engine("claude") }).result.mode).toBe("start");
    expect(ready().dispatch("editor").result.mode).toBe("resume");
  });

  it("lives as long as the driver keeps a quiet process, and no longer", () => {
    const within = ready();
    within.state.now += IDLE_MS;
    expect(within.dispatch("editor").result.mode).toBe("resume");
    const past = ready();
    past.state.now += IDLE_MS + 1;
    const turn = past.dispatch("editor");
    expect(turn.result).toStrictEqual({ mode: "start", text: past.full(turn), send: {} });
  });

  it("is gone after a restart", () => {
    const r = ready();
    r.restart();
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("is gone once its thread is forgotten", () => {
    const r = ready();
    r.sessions.forget("room");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

describe("room sessions: several members", () => {
  it("never resumes a member after another member's turn on the same instance", () => {
    const r = room();
    r.say("Editor, cut the intro.");
    r.run("editor", "E1");
    r.say("Writer, name it.");
    const writer = r.run("writer", "W1");
    expect(writer.result.mode).toBe("start");
    r.say("Editor, use that.");
    // Claude keeps one process per thread, and the writer's turn replaced the
    // editor's: main starts a new session here, and so does this.
    const back = r.dispatch("editor");
    expect(back.result).toStrictEqual({ mode: "start", text: r.full(back), send: {} });
    r.finish(back, "E2", { reply: "Used it." });
    r.say("Editor, one more.");
    const again = r.dispatch("editor");
    expect(again.result.send.resumeCursor).toBe("E2");
    expect(r.body(again)).toBe(`${NOTE}\nOmkar: Editor, one more.`);
  });

  it("counts another member's unmanaged turn on the same instance too", () => {
    const r = room();
    r.say("Editor, cut the intro.");
    r.run("editor", "E1");
    r.say("Writer, name it.");
    r.run("writer", "W1", {}, { guestConfined: true });
    r.say("Editor, use that.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("resumes a member after another member's turn on a different instance", () => {
    const r = room();
    const other = engine("claude-2");
    r.say("Editor, cut the intro.");
    r.run("editor", "E1");
    r.say("Writer, name it.");
    expect(r.run("writer", "W1", { reply: "Dawn." }, { instance: other }).result.mode).toBe("start");
    r.say("Editor, use that.");
    const back = r.dispatch("editor");
    expect(back.result.send.resumeCursor).toBe("E1");
    expect(r.body(back)).toBe(`${NOTE}\nOmkar: Writer, name it.\nWriter: Dawn.\nOmkar: Editor, use that.`);
    r.finish(back, "E1", { reply: "Used it." });
    // and the writer, alone on its instance, resumes its own session
    r.say("Writer, thanks.");
    const writer = r.dispatch("writer", { instance: other });
    expect(writer.result.send.resumeCursor).toBe("W1");
    expect(r.body(writer)).toBe(`${NOTE}\nOmkar: Editor, use that.\nEditor: Used it.\nOmkar: Writer, thanks.`);
  });

  it("leaves another member's record alone when one member's turn ends cleanly or badly", () => {
    const r = room();
    const other = engine("claude-2");
    r.say("Editor?");
    r.run("editor", "E1");
    r.say("Writer?");
    r.run("writer", "W1", {}, { instance: other });
    r.say("Writer again?");
    const failed = r.dispatch("writer", { instance: other });
    r.finish(failed, "W1", { ok: false });
    r.say("Editor again?");
    expect(r.dispatch("editor").result.mode).toBe("resume");
  });

  it("trusts neither member when two are recorded with one native session", () => {
    const r = room();
    const other = engine("claude-2");
    r.say("Editor?");
    r.run("editor", "SHARED");
    r.say("Writer?");
    r.run("writer", "SHARED", {}, { instance: other });
    r.say("Editor again?");
    expect(r.dispatch("editor").result.mode).toBe("start");
    r.say("Writer again?");
    expect(r.dispatch("writer", { instance: other }).result.mode).toBe("start");
  });

  it("keeps the threads of one room apart", () => {
    const first = room({ threadId: "thread-1" });
    const second = room({ threadId: "thread-2", shared: { messages: first.threads, sessions: first.sessions } });
    first.say("Thread one. ONE");
    first.run("editor", "T1");
    second.say("Thread two. TWO");
    const opening = second.dispatch("editor");
    expect(opening.result.mode).toBe("start");
    expect(opening.result.text).not.toContain("ONE");
    second.finish(opening, "T2", { reply: "Two it is." });
    first.say("More for one.");
    const one = first.dispatch("editor");
    expect(one.result.send.resumeCursor).toBe("T1");
    expect(first.body(one)).toBe(`${NOTE}\nOmkar: More for one.`);
    second.say("More for two.");
    const two = second.dispatch("editor");
    expect(two.result.send.resumeCursor).toBe("T2");
    expect(two.result.text).not.toContain("ONE");
  });
});

describe("room sessions: the session a turn really ran in", () => {
  it("records the warm session a start went on in, since a start does not reset", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const failed = r.dispatch("editor");
    r.finish(failed, "S1", { ok: false });
    r.say("Try again.");
    const start = r.dispatch("editor");
    expect(start.result.send).toStrictEqual({});
    // the driver's process survived, so the turn ran in S1 again
    r.finish(start, "S1", { reply: "Trimmed." });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.send.resumeCursor).toBe("S1");
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
  });

  it("records nothing for a start whose session was never announced", () => {
    const r = room();
    r.say("Cut the intro.");
    const turn = r.dispatch("editor");
    r.bind(turn);
    r.emit(turn, r.output);
    r.emit(turn, { type: "turn.completed", ok: true });
    r.say("Trim the middle.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });

  it("credits the session a driver rebuilt from the recovery text with the window", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const refused = r.dispatch("editor");
    expect(refused.result.send.resumeCursor).toBe("S1");
    // the driver could not reopen S1 and went on in S2, from recoveryText
    r.finish(refused, "S2", { rebuilt: true, reply: "Trimmed." });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result.send.resumeCursor).toBe("S2");
    expect(r.body(next)).toBe(`${NOTE}\nOmkar: Tighten the outro.`);
  });

  it("credits nothing to a session that replaced the cursor without saying it was rebuilt", () => {
    const r = room();
    r.say("Cut the intro.");
    r.run("editor", "S1");
    r.say("Trim the middle.");
    const breached = r.dispatch("editor");
    r.finish(breached, "S-surprise", { reply: "Trimmed." });
    r.say("Tighten the outro.");
    const next = r.dispatch("editor");
    expect(next.result).toStrictEqual({ mode: "start", text: r.full(next), send: {} });
  });

  it("does not record a turn the provider never acted on", () => {
    const r = room();
    r.say("Cut the intro.");
    const turn = r.dispatch("editor");
    r.bind(turn);
    r.emit(turn, { type: "session.started", sessionId: "S1" });
    r.emit(turn, { type: "item.completed", itemType: "assistant_text", text: "API Error: 529", synthetic: true });
    r.emit(turn, { type: "turn.completed", ok: false });
    r.say("Again.");
    expect(r.dispatch("editor").result.mode).toBe("start");
  });
});

// A seeded model of a room on one Claude instance and one other: members
// speak in any order, lines arrive between and during turns, turns end well,
// badly or not at all, and the driver refuses a resume now and then. The
// model keeps, per native session, every line that session was shown. Whatever
// the interleaving: every line of the window a turn was built from is in the
// text sent or already in the session that runs the turn (the invariant in
// the module header), and no accepted turn shows a session a line twice.
describe("room sessions: randomized rooms", () => {
  function prng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const sentinels = (text: string) => [...text.matchAll(/<(L\d+)>/g)].map((match) => match[1]!);

  for (const seed of [1, 7, 42, 1337, 2024, 9001, 31337, 65537]) {
    it(`seed ${seed}: the window is always in the text or in the session, and a delta repeats nothing`, () => {
      const random = prng(seed);
      const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
      const r = room();
      const second = engine("claude-2");
      const instanceOf: Record<string, RoomSessionEngine> = { editor: r.claude, writer: r.claude, scout: second };
      const members = Object.keys(instanceOf);
      let line = 0;
      const append = () => {
        const tag = `<L${line++}>`;
        const kind = random();
        if (kind < 0.6) r.say(`says ${tag}`);
        else if (kind < 0.8) r.botSays(pick(members), `posts ${tag}`, { peerPost: {} });
        else r.add({ role: "bot", kind: "activity", roomRequest: { id: tag, phase: "result" } });
      };
      /** what each native session has been shown */
      const held = new Map<string, Set<string>>();
      /** the driver's one warm process per thread and instance: whose, and which session */
      const warm = new Map<string, { botId: string; session: string }>();
      let sessionSerial = 0;
      let deltas = 0;
      let starts = 0;

      for (let step = 0; step < 400; step++) {
        for (let n = Math.floor(random() * 4); n > 0; n--) append();
        // Ten quiet minutes: the drivers close their warm processes.
        if (random() < 0.03) { r.state.now += IDLE_MS + 1; warm.clear(); }
        const botId = pick(members);
        const instance = instanceOf[botId]!;
        const reset = random() < 0.05;
        const turn = r.dispatch(botId, { instance, reset });
        expect(turn.result.mode).not.toBe("legacy");
        const windowTags = sentinels(turn.input.window.text);
        const sentTags = sentinels(turn.result.text);
        const slot = warm.get(instance.instanceId);

        // The driver, as server/drivers/claude.ts decides it.
        let session: string;
        let rebuilt = false;
        let shown = sentTags;
        const cursor = turn.result.send.resumeCursor;
        if (turn.result.send.sessionReset) {
          expect(cursor).toBeUndefined();
          session = `N${sessionSerial++}`;
        } else if (cursor !== undefined) {
          deltas += 1;
          // Resume only where main would have gone on in this very process.
          expect(slot, `step ${step}: a resume needs the member's own warm process`).toEqual({ botId, session: cursor });
          if (random() < 0.1) {
            // refused before the prompt: a new session from recoveryText
            session = `N${sessionSerial++}`;
            rebuilt = true;
            shown = sentinels(turn.result.send.recoveryText!);
            expect(shown).toEqual(windowTags);
          } else {
            session = cursor;
            const before = held.get(session) ?? new Set<string>();
            for (const tag of windowTags) {
              expect(sentTags.includes(tag) || before.has(tag), `step ${step}: ${tag} is neither sent nor held by ${session}`).toBe(true);
            }
            for (const tag of sentTags) expect(before.has(tag), `step ${step}: ${tag} sent twice to ${session}`).toBe(false);
          }
        } else {
          starts += 1;
          expect(sentTags).toEqual(windowTags);
          session = slot?.botId === botId ? slot.session : `N${sessionSerial++}`;
        }
        expect(new Set(sentTags).size).toBe(sentTags.length);

        const outcome = random();
        if (outcome < 0.08) {
          // never completes: timed out, stalled or rejected at dispatch. The
          // process may be anybody's or nobody's afterwards.
          warm.delete(instance.instanceId);
          continue;
        }
        const ok = outcome >= 0.2;
        r.finish(turn, session, {
          ok, rebuilt, reply: `answers <L${line++}>`,
          notes: random() < 0.4 ? [`note <L${line++}>`] : [],
          during: () => { for (let n = Math.floor(random() * 3); n > 0; n--) append(); },
        });
        // The provider acted on the prompt either way: the session holds it,
        // and what the member said itself.
        const now = held.get(session) ?? new Set<string>();
        for (const tag of shown) now.add(tag);
        for (const m of r.messages) if (m.turnId === turn.turnId) for (const tag of sentinels(m.text ?? "")) now.add(tag);
        held.set(session, now);
        if (ok) warm.set(instance.instanceId, { botId, session });
        else warm.delete(instance.instanceId);
      }
      // the model exercised both shapes
      expect(deltas).toBeGreaterThan(20);
      expect(starts).toBeGreaterThan(20);
    });
  }
});
