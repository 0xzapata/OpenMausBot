// A bot going in circles: the same call, with the same arguments, again and
// again in one turn. Nothing else watches for that, and it is the person's
// money. The harness always says so in the chat, a chip at 5, 10 and 20
// repeats. With the loop guard switched on (config `loopGuard`, off by
// default) it also acts:
//
//   steerAt  one short note steered into the running turn, where the engine
//            takes a message mid-turn: the model reads it before its next
//            call and can change approach on its own. Once per repeated call.
//   stopAt   the turn is stopped the way the person's Stop stops it, and a
//            failed-turn line says what was repeated and how often, so Retry
//            is there. On an engine that cannot be steered this is the only
//            action. Once per turn.
//
// A turn that is waiting on a person or on a computer is left alone: it is
// spending nothing, and the person is already looking at it. The counting
// is repeat-detector.ts and stays pure; everything this touches is handed
// in, so server/index.ts only wires it.
import { failedTurnTool } from "../shared/failed-turn.ts";
import type { RuntimeEvent, SteerOutcome } from "./contracts.ts";
import { quoteInNote } from "./peer-provenance.ts";
import { RepeatDetector, callKey } from "./repeat-detector.ts";

export interface LoopGuardSettings {
  enabled: boolean;
  /** Identical calls in one turn before the model is told. */
  steerAt: number;
  /** Identical calls in one turn before the turn is stopped. At or below
   * `steerAt`, the turn is stopped without a note first. */
  stopAt: number;
}

export const DEFAULT_STEER_AT = 5;
export const DEFAULT_STOP_AT = 10;

/** The setting with its defaults filled in, from the config's `loopGuard`
 * section (its schema is in config.ts, which may only shrink, so everything
 * else about it lives here). Off unless the file switches it on or
 * OMB_LOOP_GUARD=1 does: it speaks into a running turn and then ends it,
 * which nobody should get without asking. The environment only switches it
 * on; the counts come from the file. */
export function loopGuardSettings(cfg: { loopGuard?: Partial<LoopGuardSettings> }, env: NodeJS.ProcessEnv = process.env): LoopGuardSettings {
  return {
    enabled: env.OMB_LOOP_GUARD === "1" || cfg.loopGuard?.enabled === true,
    steerAt: cfg.loopGuard?.steerAt ?? DEFAULT_STEER_AT,
    stopAt: cfg.loopGuard?.stopAt ?? DEFAULT_STOP_AT,
  };
}

/** A row of the transcript that is the harness speaking, not a tool. */
type ActivityTool = { name: string; ok: false };

export interface LoopGuardDeps {
  /** Every runtime event the harness acts on. Subscribed where the old
   * subscriber sat, after the fold that writes the call's own row, so the
   * chip still follows the call it is about. */
  subscribe(listener: (event: RuntimeEvent) => void): void;
  /** The setting as it stands now. Read on every counted call, so a change
   * reaches a turn that is already running. */
  settings(): LoopGuardSettings;
  /** One activity row in the thread's transcript. */
  append(threadId: string, tool: ActivityTool): void;
  /** The turn on this thread must be left alone: it is waiting on a person
   * or on a computer (what the stall watchdog spares), or it is not a turn
   * the guard acts on at all. */
  exempt(threadId: string): boolean;
  /** Whether a note can go into the running turn: the decision a person's
   * own message gets there (steer, or wait for the next turn). */
  canSteer(threadId: string): boolean;
  /** Deliver a note into the running turn (ProviderAdapter.steer). */
  steer(threadId: string, note: string): Promise<SteerOutcome>;
  /** Stop the running turn the way the person's Stop does, for this cause.
   * Whatever that path writes into the transcript is written before it
   * returns, so the guard's own line lands after it. */
  interrupt(threadId: string, cause: string): Promise<unknown>;
}

export interface LoopGuard {
  /** The turn ended without a turn.completed the guard could see (the stall
   * watchdog stopped it): the next turn starts its own count. */
  settle(threadId: string): void;
}

/** Repeats that earn the chip, whatever the setting. */
const NOTICE_AT = [5, 10, 20] as const;
// Bounded per active turn. OpenHands uses a bounded recent-event scan for
// the same class of stuck-loop detection; retaining an unlimited set of
// unique arguments would let one pathological turn grow the server forever.
const MAX_CALLS_PER_TURN = 256;
/** The longest call a note or a stop line quotes. */
const CALL_QUOTE_MAX = 160;

interface CountedCall {
  /** What makes two calls the same call. */
  key: string;
  tool: string;
  /** The arguments whole: the chip cuts them, a note masks them first. */
  args: string;
}

/** The call an event starts, when it is one worth counting. Keyed on tool
 * plus arguments, so a bare tool name is never counted: five "Bash" may be
 * five different commands. Arguments come from a tool start whose title
 * carries them (ACP: "echo hi", "Read src/x.ts"; Codex titles a command with
 * the command) and from every permission ask's summary (the command being
 * approved). */
function countedCall(event: RuntimeEvent): CountedCall | null {
  let key: string | null = null;
  if (event.type === "item.started" && event.itemType === "tool") {
    // a title with more than a bare identifier is a call with arguments;
    // a bare "Bash" is not countable
    const title = event.title ?? "";
    if (/\s|\//.test(title.trim())) key = callKey("tool", title);
  } else if (event.type === "request.opened" && event.requestType === "permission") key = callKey(event.tool, event.summary);
  if (!key) return null;
  const [tool, ...rest] = key.split(":");
  return { key, tool: tool!, args: rest.join(":") };
}

/** The note steered into a looping turn. The harness's own words, opened
 * the way its other notes are (`[OpenMausBot …]`, which model-written text
 * cannot open: peer-provenance.ts escapes every imitation), so the model
 * never reads it as the person speaking. `call` is quoted as a note quotes
 * anything a model wrote (quoteInNote): one line, secrets masked, no
 * bracket that could close the note early. */
function loopNote(call: string, count: number): string {
  return `[OpenMausBot: this exact call has now run ${count} times in this turn with the same arguments: ${call}. Change approach, or stop and report what is blocking.]`;
}

/** Why the guard stopped a turn: the failed-turn line, and what the turn's
 * requester and a routine's run are told. Shaped like the stall's cause. */
function loopCause(call: string, count: number): string {
  return `the same call ran ${count} times in this turn (${call}) — the turn was stopped`;
}

export function startLoopGuard(deps: LoopGuardDeps): LoopGuard {
  const repeats = new RepeatDetector({ thresholds: NOTICE_AT, maxKeysPerThread: MAX_CALLS_PER_TURN });
  /** What the guard has done to the turn in flight on each thread. */
  const acted = new Map<string, { stopped: boolean; steered: Set<string> }>();

  const settle = (threadId: string) => {
    repeats.settle(threadId);
    acted.delete(threadId);
  };

  const steer = (threadId: string, note: string) => {
    // One attempt, whatever comes back. "steered" is the note delivered.
    // "refused" is the note provably not delivered, and a note about this
    // turn has no later turn to wait for. "indeterminate", a transport that
    // failed, or an adapter that threw may each have delivered it: sending
    // it again could put it in the turn twice. In every case the stop still
    // bounds the loop, so nothing is owed and nothing may throw from here.
    try {
      void Promise.resolve(deps.steer(threadId, note)).catch(() => {});
    } catch {
      // read like a lost transport
    }
  };

  const stop = (threadId: string, cause: string) => {
    let stopping: Promise<unknown>;
    try {
      stopping = Promise.resolve(deps.interrupt(threadId, cause));
    } catch {
      // The Stop path never began: a line that says the turn was stopped
      // would be false.
      return;
    }
    // After the Stop path's own rows (a teammate left running gets a pill),
    // so this is the last row and Retry belongs to it. Before the engine
    // answers: the turn's end must find the line already there.
    deps.append(threadId, failedTurnTool(cause));
    // An engine that would not stop has still been told to, exactly as when
    // the person presses Stop; the stall watchdog is what ends a turn that
    // ignores it.
    void stopping.catch(() => {});
  };

  deps.subscribe((event) => {
    if (event.type === "turn.completed" || event.type === "session.exited") return settle(event.threadId);
    const call = countedCall(event);
    if (!call) return;
    const { threadId } = event;
    const { count, threshold } = repeats.record(threadId, call.key);
    if (threshold) {
      const { tool, args } = call;
      deps.append(threadId, { name: `Same call repeated ${threshold}× — ${tool}: ${args.slice(0, 80)}${args.length > 80 ? "…" : ""} — it may be stuck`, ok: false });
    }

    const settings = deps.settings();
    if (!settings.enabled || count < Math.min(settings.steerAt, settings.stopAt)) return;
    // An ask is the turn stopping for a person (or for the approval the app
    // gives on their behalf): counted and said, never acted on.
    if (event.type === "request.opened") return;
    let turn = acted.get(threadId);
    if (turn?.stopped || deps.exempt(threadId)) return;
    if (!turn) acted.set(threadId, (turn = { stopped: false, steered: new Set() }));
    // Masked before it is cut: a command line is where credentials get
    // pasted, and a key sliced in half would slip past the shapes redaction
    // knows. The chip above stays as it always was, beside the call's own row.
    const quoted = quoteInNote(`${call.tool}: ${call.args}`, CALL_QUOTE_MAX);
    // At or past, not exactly at: a count that passed while the turn was
    // waiting is acted on at the first repeat after the wait.
    if (count >= settings.stopAt) {
      turn.stopped = true;
      stop(threadId, loopCause(quoted, count));
      return;
    }
    // Bounded like the counts: a turn looping on more distinct calls than
    // the detector remembers gets no further notes, never a second one for
    // a call it was already told about.
    if (turn.steered.has(call.key) || turn.steered.size >= MAX_CALLS_PER_TURN || !deps.canSteer(threadId)) return;
    turn.steered.add(call.key);
    steer(threadId, loopNote(quoted, count));
  });

  return { settle };
}
