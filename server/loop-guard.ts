// A bot going in circles: the same call, with the same arguments, again and
// again in one turn. Nothing else watches for that, and it is the person's
// money. The harness always says so in the chat, a chip at 5, 10 and 20
// repeats across the turn (repeat-detector.ts), exactly as before and
// whatever the setting.
//
// With the loop guard switched on (config `loopGuard`, off by default) it
// also acts, and on something narrower than that count. A healthy turn runs
// its tests ten times; what it does not do is get the same result ten times
// running. So the guard acts on a streak (repeat-streak.ts): the same shell
// command completing with the same outcome as the time before, back to back.
//
//   steerAt  in a row: one short note steered into the running turn, where
//            the engine takes a message mid-turn. The model reads it before
//            its next call and can change approach on its own. Once per
//            command.
//   stopAt   in a row: the turn is stopped the way the person's Stop stops
//            it, and a failed-turn line says what kept coming back the same
//            and how often, so Retry is there. On an engine that cannot be
//            steered this is the only action. Once per turn.
//
// A streak is made only of shell commands the harness can see all of, with
// a result it can see all of (shellCall below, outcomeDigest). An engine
// that reports no output for a command gives the guard nothing to act on.
// A turn that is waiting on a person or on a computer is left alone: it is
// spending nothing, and the person is already looking at it.
//
// The counting and the streak are pure and live in their own files;
// everything this touches is handed in, so server/index.ts only wires it.
import { failedTurnTool } from "../shared/failed-turn.ts";
import { nameIsCommand } from "../shared/tool-name.ts";
import type { RuntimeEvent, SteerOutcome } from "./contracts.ts";
import { quoteInNote } from "./peer-provenance.ts";
import { RepeatDetector, callKey } from "./repeat-detector.ts";
import { RepeatStreak, outcomeDigest } from "./repeat-streak.ts";
import { COMMAND_SUMMARY_MAX, previewIsPartial } from "./tool-summary.ts";

export interface LoopGuardSettings {
  enabled: boolean;
  /** Times in a row a command comes back the same before the model is told. */
  steerAt: number;
  /** Times in a row before the turn is stopped. At or below `steerAt`, the
   * turn is stopped without a note first. */
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
  /** The setting as it stands now. Read on every tool start and completion,
   * so a change reaches a turn that is already running. */
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
   * watchdog stopped it): the next turn starts its own count and streak. */
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

/** Where the drivers that cut a title cut it (drivers/acp/core.ts,
 * drivers/pi.ts): a title this long may be a prefix. */
const TITLE_MAX = 80;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A detector key as the chip has always shown it: the tool, then the rest. */
function shown(key: string | null): CountedCall | null {
  if (!key) return null;
  const [tool, ...rest] = key.split(":");
  return { key, tool: tool!, args: rest.join(":") };
}

type ToolStart = Extract<RuntimeEvent, { type: "item.started" }>;

/** The call an event starts, when it is one the chip counts. Keyed on tool
 * plus arguments, so a bare tool name is never counted: five "Bash" may be
 * five different commands. Arguments come from a tool start whose title
 * carries them (ACP: "echo hi", "Read src/x.ts"; Codex titles a command with
 * the command) and from every permission ask's summary (the command being
 * approved). The same with the guard on as with it off. */
function countedCall(event: RuntimeEvent): CountedCall | null {
  if (event.type === "request.opened" && event.requestType === "permission") return shown(callKey(event.tool, event.summary));
  if (event.type !== "item.started" || event.itemType !== "tool") return null;
  // a title with more than a bare identifier is a call with arguments;
  // a bare "Bash" is not countable
  const title = event.title ?? "";
  return /\s|\//.test(title.trim()) ? shown(callKey("tool", title)) : null;
}

/** The shell command a tool start runs, for the streak. The chip can afford
 * to be loose; a stop cannot. Undefined when the start runs no command:
 * every driver reports a shell command (`summary`), and Codex and ACP also
 * title the call with it, so a call with neither (a read, a click, a
 * scroll, a wait) is not one, repeats for good reasons, and is left out of
 * the streak altogether. Null for a command the harness cannot see all of.
 * Two starts are the same command when the title, the command and the
 * arguments the driver reported are the same, and one whose arguments were
 * shortened, masked or left out, or that has only a title or a command cut
 * at its limit, cannot be told from another that starts the same way: ACP
 * cuts a title at 80 characters, and a long `cd` puts every command's
 * difference after that. It still ran, so it ends the streak.
 *
 * This is also what lets a Claude Code, pi or Muse turn be acted on at all:
 * they title a shell call "Bash", which the chip has never counted. */
function shellCall(event: ToolStart): CountedCall | null | undefined {
  const title = oneLine(event.title ?? "");
  const titled = nameIsCommand(title);
  const { summary, input } = event;
  const command = summary !== undefined ? oneLine(summary) : titled ? title : "";
  if (!command) return undefined;
  const cut = input !== undefined ? previewIsPartial(input)
    : summary !== undefined ? summary.length >= COMMAND_SUMMARY_MAX || previewIsPartial(summary)
      : title.length >= TITLE_MAX;
  if (cut) return null;
  const key = callKey("tool", [title, summary !== undefined ? command : "", input ?? ""].filter(Boolean).join(" "));
  return key ? { key, tool: titled || !title ? "tool" : title, args: command } : null;
}

/** The note steered into a looping turn. The harness's own words, opened
 * the way its other notes are (`[OpenMausBot …]`, which model-written text
 * cannot open: peer-provenance.ts escapes every imitation), so the model
 * never reads it as the person speaking. `call` is quoted as a note quotes
 * anything a model wrote (quoteInNote): one line, secrets masked, no
 * bracket that could close the note early. What the command printed is
 * never in it: the harness holds only a digest of that. */
function loopNote(call: string, streak: number): string {
  return `[OpenMausBot: this exact call has returned the same result ${streak} times in a row: ${call}. Change approach, or stop and report what is blocking.]`;
}

/** Why the guard stopped a turn: the failed-turn line, and what the turn's
 * requester and a routine's run are told. Shaped like the stall's cause. */
function loopCause(call: string, streak: number): string {
  return `the same call returned the same result ${streak} times in a row (${call}) — the turn was stopped`;
}

export function startLoopGuard(deps: LoopGuardDeps): LoopGuard {
  const repeats = new RepeatDetector({ thresholds: NOTICE_AT, maxKeysPerThread: MAX_CALLS_PER_TURN });
  const streaks = new RepeatStreak<CountedCall>({ maxPending: MAX_CALLS_PER_TURN });
  /** What the guard has done to the turn in flight on each thread. */
  const acted = new Map<string, { stopped: boolean; steered: Set<string> }>();

  const settle = (threadId: string) => {
    repeats.settle(threadId);
    streaks.settle(threadId);
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

  /** A shell command came back the same as the time before, `streak` times
   * in a row now. */
  const act = (threadId: string, call: CountedCall, streak: number, settings: LoopGuardSettings) => {
    if (streak < Math.min(settings.steerAt, settings.stopAt)) return;
    let turn = acted.get(threadId);
    if (turn?.stopped || deps.exempt(threadId)) return;
    if (!turn) acted.set(threadId, (turn = { stopped: false, steered: new Set() }));
    // Masked before it is cut: a command line is where credentials get
    // pasted, and a key sliced in half would slip past the shapes redaction
    // knows.
    const quoted = quoteInNote(`${call.tool}: ${call.args}`, CALL_QUOTE_MAX);
    // At or past, not exactly at: a streak that passed the mark while the
    // turn was waiting is acted on at the first run after the wait.
    if (streak >= settings.stopAt) {
      turn.stopped = true;
      stop(threadId, loopCause(quoted, streak));
      return;
    }
    // Bounded like the counts: a turn stuck on more distinct commands than
    // the detector remembers gets no further notes, never a second one for
    // a command it was already told about.
    if (turn.steered.has(call.key) || turn.steered.size >= MAX_CALLS_PER_TURN || !deps.canSteer(threadId)) return;
    turn.steered.add(call.key);
    steer(threadId, loopNote(quoted, streak));
  };

  deps.subscribe((event) => {
    if (event.type === "turn.completed" || event.type === "session.exited") return settle(event.threadId);
    const { threadId } = event;

    // The chip: the count across the turn, as it always was.
    const counted = countedCall(event);
    if (counted) {
      const { threshold } = repeats.record(threadId, counted.key);
      if (threshold) {
        const { tool, args } = counted;
        deps.append(threadId, { name: `Same call repeated ${threshold}× — ${tool}: ${args.slice(0, 80)}${args.length > 80 ? "…" : ""} — it may be stuck`, ok: false });
      }
    }

    // The guard: a tool's start and its end, and nothing else. An ask is the
    // turn stopping for a person; a turn streams thousands of other events.
    if ((event.type !== "item.started" && event.type !== "item.completed") || event.itemType !== "tool") return;
    const settings = deps.settings();
    // Nothing is tracked while it is off, so a streak never spans commands
    // the guard did not see.
    if (!settings.enabled) return streaks.settle(threadId);
    if (event.type === "item.started") {
      const call = shellCall(event);
      if (call !== undefined) streaks.started(threadId, event.itemId, call);
      return;
    }
    const run = streaks.completed(threadId, event.itemId, outcomeDigest(event.ok, event.output));
    if (run) act(threadId, run.call, run.streak, settings);
  });

  return { settle };
}
