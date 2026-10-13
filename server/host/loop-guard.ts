// A bot going in circles: the same call, with the same arguments, again and
// again in one turn. Nothing else watches for that, and it is the person's
// money. The harness always says so in the chat, a chip at 5, 10 and 20
// repeats across the turn (repeat-detector.ts), exactly as before and
// whatever the setting.
//
// With the loop guard switched on (config `loopGuard`, off by default) it
// also acts, and on something much narrower than that count. A healthy turn
// runs its tests ten times, and polls a build with one command for an hour;
// what it does not do is fail the same way over and over. So the guard is a
// breaker for one case, a verbatim failing loop (repeat-streak.ts): the same
// shell command failing the same way as the time before, back to back.
//
//   steerAt  in a row (5): one short note steered into the running turn,
//            where the engine takes a message mid-turn. The model reads it
//            before its next call and can change approach on its own. Once
//            per command. This is all the guard does unless a stop is asked
//            for as well.
//   stopAt   in a row (unset): the turn is stopped the way the person's
//            Stop stops it, and a failed-turn line says what kept failing
//            and how often, so Retry is there. A separate opt-in, because a
//            wait that fails until the thing it waits for is ready (`curl -f
//            localhost:3000/health`, `test -f out/done`) is the same
//            command failing the same way, and must never be stopped by
//            default. Once per turn.
//
// A streak is made only of failures: shell commands the harness can see all
// of, failing with an output it can see all of (shellCall below,
// failureDigest). A command that succeeds ends it, so a turn that keeps
// getting the same successful output is never told or stopped; the chip is
// all that notices it. An engine that reports no output for a command gives
// the guard nothing to act on. Only a thread with a turn running is acted
// on, and not one that is waiting on a person or on a computer: it is
// spending nothing, and the person is already looking at it.
//
// The counting and the streak are pure and live in their own files. This is
// a host module (server/host/README.md): everything it touches is handed
// in, and server/index.ts registers its fold where the old one sat.
import { z } from "zod";

import { failedTurnTool } from "../../shared/failed-turn.ts";
import { nameIsCommand } from "../../shared/tool-name.ts";
import type { RuntimeEvent, SteerOutcome } from "../contracts.ts";
import { quoteInNote } from "../peer-provenance.ts";
import { RepeatDetector, callKey } from "../repeat-detector.ts";
import { RepeatStreak, failureDigest } from "../repeat-streak.ts";
import { COMMAND_SUMMARY_MAX, previewIsPartial } from "../tool-summary.ts";

const COUNT_MIN = 2;
const COUNT_MAX = 1000;
const count = z.number().int().min(COUNT_MIN).max(COUNT_MAX);

/** The `loopGuard` section of config.json and of PATCH /api/config. The
 * whole setting lives here: config.ts, which may only shrink, names it. */
export const loopGuardConfigSchema = z.object({
  /** Tell a turn whose command keeps failing the same way. Off unless true;
   * OMB_LOOP_GUARD=1 switches it on too. */
  enabled: z.boolean().optional(),
  /** Identical failures in a row before the note. 5 when unset. */
  steerAt: count.optional(),
  /** Identical failures in a row before the turn is stopped. Unset, the
   * guard never stops a turn. OMB_LOOP_GUARD_STOP_AT sets it too. Null in a
   * patch takes it back out (saveConfig removes the key). */
  stopAt: count.nullable().optional(),
}).strict();
export type LoopGuardConfig = z.output<typeof loopGuardConfigSchema>;

export interface LoopGuardSettings {
  enabled: boolean;
  /** Times in a row a command fails the same way before the model is told. */
  steerAt: number;
  /** Times in a row before the turn is stopped. Absent: never. At or below
   * `steerAt`, the turn is stopped without a note first. */
  stopAt?: number;
}

export const DEFAULT_STEER_AT = 5;

/** The setting with its defaults filled in. Off unless the file switches it
 * on or OMB_LOOP_GUARD=1 does: it speaks into a running turn, which nobody
 * should get without asking. Switched on and nothing else, it only tells.
 * It ends a turn only when a stop count is set as well, in the file or by
 * OMB_LOOP_GUARD_STOP_AT (which wins when it is a count in range, and does
 * not switch the guard on by itself). */
export function loopGuardSettings(cfg: { loopGuard?: LoopGuardConfig }, env: NodeJS.ProcessEnv = process.env): LoopGuardSettings {
  const fromEnv = env.OMB_LOOP_GUARD_STOP_AT?.trim();
  const parsed = fromEnv ? Number(fromEnv) : NaN;
  const stopAt = Number.isInteger(parsed) && parsed >= COUNT_MIN && parsed <= COUNT_MAX ? parsed : cfg.loopGuard?.stopAt ?? undefined;
  return {
    enabled: env.OMB_LOOP_GUARD === "1" || cfg.loopGuard?.enabled === true,
    steerAt: cfg.loopGuard?.steerAt ?? DEFAULT_STEER_AT,
    ...(stopAt === undefined ? {} : { stopAt }),
  };
}

/** A row of the transcript that is the harness speaking, not a tool. */
type ActivityTool = { name: string; ok: false };

export interface LoopGuardDeps {
  /** The setting as it stands now. Read on every tool start and completion,
   * so a change reaches a turn that is already running. */
  settings(): LoopGuardSettings;
  /** One activity row in the thread's transcript. */
  append(threadId: string, tool: ActivityTool): void;
  /** The thread has a turn running, of a kind the guard acts on. Necessary
   * for anything it does: what it holds about a thread is only as good as
   * the events that reached it, and it must never speak into or stop a
   * conversation that is not working. */
  live(threadId: string): boolean;
  /** That turn is waiting on a person or on a computer (what the stall
   * watchdog spares), and must be left alone. */
  waiting(threadId: string): boolean;
  /** Whether a note can go into the running turn: the decision a person's
   * own message gets there (steer, or wait for the next turn). */
  canSteer(threadId: string): boolean;
  /** Deliver a note into the running turn (ProviderAdapter.steer). */
  steer(threadId: string, note: string): Promise<SteerOutcome>;
  /** Stop the running turn the way the person's Stop does, for this cause.
   * Whatever that path writes into the transcript is written before it
   * returns, so the guard's own line lands after it. */
  interrupt(threadId: string, cause: string): Promise<unknown>;
  /** One server log line per thing the guard does. Never the command. */
  log?(line: string): void;
}

export interface LoopGuard {
  /** The fold: every runtime event the harness acts on, in the order
   * index.ts registers it, after the fold that writes the call's own row,
   * so the chip still follows the call it is about. */
  onEvent(event: RuntimeEvent): void;
  /** The turn ended without an end the guard could see (the stall watchdog
   * stopped it), or the thread is gone: nothing is held about it. */
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
 * to be loose; a note in the turn and a stop cannot.
 *
 * Undefined when the start runs no command, and the event's own contract
 * says which that is (shared/runtime-events.ts): `summary` is the shell
 * command a call runs, and is absent for a call that runs none. A title is
 * never taken for one. ACP titles every tool in words ("Read src/x.ts",
 * "Wait for selector"), and a read or a wait that fails ten times is not
 * what this is for. Such a call is left out of the streak altogether.
 *
 * Null for a command the harness cannot see all of. Two starts are the same
 * command when the title, the command and the arguments the driver reported
 * are the same, and one whose arguments were shortened, masked or left out,
 * or that has only a command cut at its limit, cannot be told from another
 * that starts the same way. It still ran, so it ends the streak.
 *
 * This is also what lets a Claude Code, pi or Muse turn be acted on at all:
 * they title a shell call "Bash", which the chip has never counted. */
function shellCall(event: ToolStart): CountedCall | null | undefined {
  const { summary, input } = event;
  const command = summary === undefined ? "" : oneLine(summary);
  if (summary === undefined || !command) return undefined;
  const cut = input !== undefined ? previewIsPartial(input) : summary.length >= COMMAND_SUMMARY_MAX || previewIsPartial(summary);
  if (cut) return null;
  const title = oneLine(event.title ?? "");
  const key = callKey("tool", [title, command, input ?? ""].filter(Boolean).join(" "));
  // Codex and ACP title a shell call with the command itself: say it once.
  return key ? { key, tool: !title || nameIsCommand(title) ? "tool" : title, args: command } : null;
}

/** The call as the harness quotes it in its own sentences: one line,
 * secrets masked before it is cut (a command line is where credentials get
 * pasted, and a key sliced in half would slip past the shapes redaction
 * knows), no bracket that could close a note early (quoteInNote), and
 * inside the one pair of quotes the harness's notes put around what a model
 * wrote (waiting-on-person.ts), so prose in a command reads as the command
 * and never as the sentence around it. */
function quoted(call: CountedCall): string {
  return `“${quoteInNote(`${call.tool}: ${call.args}`, CALL_QUOTE_MAX).replace(/[“”]/g, '"')}”`;
}

/** The note steered into a looping turn. The harness's own words, opened
 * the way its other notes are (`[OpenMausBot …]`, which model-written text
 * cannot open: peer-provenance.ts escapes every imitation), so the model
 * never reads it as the person speaking. What the command printed is never
 * in it: the harness holds only a digest of that. */
function loopNote(call: string, streak: number): string {
  return `[OpenMausBot: this exact call has failed the same way ${streak} times in a row: ${call}. Change approach, or stop and report what is blocking.]`;
}

/** Why the guard stopped a turn: the failed-turn line, and what the turn's
 * requester and a routine's run are told. Shaped like the stall's cause. */
function loopCause(call: string, streak: number): string {
  return `the same call failed the same way ${streak} times in a row: ${call} — the turn was stopped`;
}

export function createLoopGuard(deps: LoopGuardDeps): LoopGuard {
  const repeats = new RepeatDetector({ thresholds: NOTICE_AT, maxKeysPerThread: MAX_CALLS_PER_TURN });
  const streaks = new RepeatStreak<CountedCall>({ maxPending: MAX_CALLS_PER_TURN });
  /** What the guard has done to the turn in flight on each thread. */
  const acted = new Map<string, { stopped: boolean; steered: Set<string> }>();
  /** The turn each thread's streak belongs to, where the engine names it. */
  const turnOf = new Map<string, string>();
  const log = (what: string, threadId: string, streak: number) =>
    (deps.log ?? console.info)(`[loop-guard] ${what}: thread=${threadId} failures-in-a-row=${streak}`);

  /** A new turn: nothing the guard holds for acting carries into it. The
   * chip's count is the detector's and is not touched here. */
  const startOver = (threadId: string) => {
    streaks.settle(threadId);
    acted.delete(threadId);
  };

  const settle = (threadId: string) => {
    repeats.settle(threadId);
    startOver(threadId);
    turnOf.delete(threadId);
  };

  const steer = (threadId: string, note: string, streak: number) => {
    // One attempt, whatever comes back. "steered" is the note delivered.
    // "refused" is the note provably not delivered, and a note about this
    // turn has no later turn to wait for. "indeterminate", a transport that
    // failed, or an adapter that threw may each have delivered it: sending
    // it again could put it in the turn twice. Nothing is owed after any of
    // them, and nothing may throw from here.
    try {
      void Promise.resolve(deps.steer(threadId, note)).then(
        (outcome) => log(outcome === "steered" ? "steer sent" : `steer ${outcome}`, threadId, streak),
        () => log("steer rejected", threadId, streak),
      );
    } catch {
      // read like a lost transport
      log("steer rejected", threadId, streak);
    }
  };

  const stop = (threadId: string, cause: string, streak: number) => {
    let stopping: Promise<unknown>;
    try {
      stopping = Promise.resolve(deps.interrupt(threadId, cause));
    } catch {
      // The Stop path never began: a line that says the turn was stopped
      // would be false.
      return log("stop not sent", threadId, streak);
    }
    log("stop sent", threadId, streak);
    // After the Stop path's own rows (a teammate left running gets a pill),
    // so this is the last row and Retry belongs to it. Before the engine
    // answers: the turn's end must find the line already there.
    deps.append(threadId, failedTurnTool(cause));
    // An engine that would not stop has still been told to, exactly as when
    // the person presses Stop, and as then nothing here follows it up: the
    // turn goes on until it ends or the person stops it. The guard has
    // spent its one stop for this turn. (The stall watchdog is no backstop
    // for this: it ends a turn that has gone silent, not one still working.)
    void stopping.catch(() => log("stop rejected", threadId, streak));
  };

  /** A shell command failed the same way as the time before, `streak` times
   * in a row now. */
  const act = (threadId: string, call: CountedCall, streak: number, settings: LoopGuardSettings) => {
    const { stopAt } = settings;
    if (streak < Math.min(settings.steerAt, stopAt ?? settings.steerAt)) return;
    let turn = acted.get(threadId);
    if (turn?.stopped || !deps.live(threadId) || deps.waiting(threadId)) return;
    if (!turn) acted.set(threadId, (turn = { stopped: false, steered: new Set() }));
    // At or past, not exactly at: a streak that passed the mark while the
    // turn was waiting is acted on at the first run after the wait.
    if (stopAt !== undefined && streak >= stopAt) {
      turn.stopped = true;
      stop(threadId, loopCause(quoted(call), streak), streak);
      return;
    }
    // Bounded like the counts: a turn stuck on more distinct commands than
    // the detector remembers gets no further notes, never a second one for
    // a command it was already told about.
    if (turn.steered.has(call.key) || turn.steered.size >= MAX_CALLS_PER_TURN || !deps.canSteer(threadId)) return;
    turn.steered.add(call.key);
    steer(threadId, loopNote(quoted(call), streak), streak);
  };

  const onEvent = (event: RuntimeEvent) => {
    const { threadId } = event;
    if (event.type === "turn.completed" || event.type === "session.exited") return settle(threadId);
    // A turn's end does not always reach this fold (index.ts filters the
    // events of a turn it has quarantined, and a session's exit while the
    // thread is busy), so a turn's start is a fence too.
    if (event.type === "turn.started") {
      startOver(threadId);
      if (event.turnId === undefined) turnOf.delete(threadId);
      else turnOf.set(threadId, event.turnId);
      return;
    }

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
    // And the last fence: events that name a turn other than the one the
    // streak belongs to are a new turn, whatever else was or was not seen.
    if (event.turnId !== undefined && turnOf.get(threadId) !== event.turnId) {
      startOver(threadId);
      turnOf.set(threadId, event.turnId);
    }
    if (event.type === "item.started") {
      const call = shellCall(event);
      if (call !== undefined) streaks.started(threadId, event.itemId, call);
      return;
    }
    const run = streaks.completed(threadId, event.itemId, failureDigest(event.ok, event.output));
    if (run) act(threadId, run.call, run.streak, settings);
  };

  return { onEvent, settle };
}
