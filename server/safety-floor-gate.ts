// Where the safety floor is enforced.
//
// server/safety-floor.ts says whether a command line is on the never-list.
// This file applies that answer in the places where the server itself would
// allow a command with nobody looking, and only there:
//
//   - the request.opened fold (server/index.ts), when Full access, a saved
//     command or any other grant is about to answer a provider's permission
//     request (denyAtSafetyFloor);
//   - a runtime that answers its own tool gate, as the chat runtime does at
//     Full access and under "Always allow this session" (floorBlockForToolCall);
//   - a driver that answers a request inside the driver: Codex and Muse Code
//     at Full access, an ACP agent's kept "Always allow this session". Each
//     asks first (answersAlone in server/drivers/permission-command.ts) and,
//     unless the command is cleared, does not answer: the request is raised
//     like any other and lands in the fold.
//
// The driver and the fold must judge the same text. Every driver that knows
// the command line an engine asked to run puts it on the request as
// `commandLine` (shellRequest in permission-command.ts), whether or not it
// also knows the working directory that the `command` descriptor needs, and
// both sides read that one string.
//
// A command the reader could not read (a quote that never closes, a line
// over the size cap) is neither on the list nor cleared.
// Nothing answers for it automatically: the fold turns the grant's verdict
// into a card for the person (heldAtSafetyFloor), and a runtime with no card
// to show refuses the call.
//
// A card a PERSON answers is never overridden here: at Ask the request still
// reaches them, and their Allow stands. The floor is one more necessary
// condition before an AUTOMATIC allow, and nothing else.
//
// It cannot reach an engine that never asks. Claude Code under
// bypassPermissions, Codex with approvals off and an ACP agent in its own
// yolo mode run a command without sending a request, so the floor does not
// see it; that needs a hook inside the engine, which is a later piece.
import { homedir } from "node:os";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { AutoVerdict } from "./auto-approve.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import type { ProviderAdapter } from "./contracts.ts";
import { appendDecision } from "./decision-log.ts";
import { floorReading, type FloorRule } from "./safety-floor.ts";

/** Whether the safety floor is switched on. Off unless somebody chose it: it
 * denies commands that Full access, or a command the person saved, would
 * otherwise have run. `safetyFloor.enabled` in config.json (or PUT
 * /api/config) turns it on, and so does OMB_SAFETY_FLOOR=1 whatever the file
 * says. The variable can only add the floor: no value of it switches off one
 * the file enabled. */
export function safetyFloorEnabled(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_SAFETY_FLOOR?.trim() === "1" || cfg.safetyFloor?.enabled === true;
}

/** Read per request, so a settings save applies to the next one. Until the
 * server binds its config, only OMB_SAFETY_FLOOR can switch the floor on. */
let config: () => AppConfig = () => ({});
let read: typeof floorReading = floorReading;

/** The server binds its live config once (server/index.ts). `reader` is the
 * classifier; tests pass one that fails, to stand for a command it cannot
 * read. */
export function bindSafetyFloor(provider: () => AppConfig, reader: typeof floorReading = floorReading): void {
  config = provider;
  read = reader;
}

/** Whether the floor is on right now, after the environment: what
 * GET /api/config reports, so an operator can see that a switch took. */
export function safetyFloorOn(): boolean {
  return safetyFloorEnabled(config());
}

export interface FloorBlock {
  /** Which rule: a never-list rule, or `unreadable` for a command the reader
   * could not read where nobody can be asked instead. */
  rule: FloorRule | "unreadable";
  label: string;
  /** `Blocked by the safety floor: <label>`: the line a person sees. */
  line: string;
  /** What the engine is told in place of an approval. */
  reason: string;
}

function blockOf(rule: FloorBlock["rule"], label: string, advice: string): FloorBlock {
  const line = `Blocked by the safety floor: ${label}`;
  // The model reads `reason` as the tool's result. It is told what happened
  // and what to do next, so it reports the block instead of trying a
  // spelling the floor does not know.
  return { rule, label, line, reason: `${line}. ${advice}` };
}

let unreadableLogged = false;

/** What the floor makes of one command line: nothing against it (`clear`),
 * on the never-list (`blocked`), or not readable. Off, or with no command,
 * everything is clear. */
function finding(command: string | undefined): { state: "clear" } | { state: "blocked" | "unreadable"; block: FloorBlock } {
  if (!command || !safetyFloorOn()) return { state: "clear" };
  let reading: ReturnType<typeof floorReading>;
  try {
    reading = read(command, process.platform, homedir());
  } catch {
    reading = { read: false };
  }
  if (reading.read) {
    return reading.verdict
      ? { state: "blocked", block: blockOf(reading.verdict.rule, reading.verdict.label, "This command is never approved automatically, at any approval level. Do not retry it or look for another way to do the same thing; tell the person what you were trying to do.") }
      : { state: "clear" };
  }
  if (!unreadableLogged) {
    unreadableLogged = true;
    // Once, and without the command: its text may hold a credential.
    console.error("[safety-floor] A command could not be read, so nothing approved it automatically. Later ones are not logged.");
  }
  return { state: "unreadable", block: blockOf("unreadable", "a command it could not read", "Nothing approves a command automatically when the safety floor could not read it. Tell the person what you were trying to run so they can run it themselves.") };
}

/** The never-list block a shell command meets, or null: the floor is off,
 * there is no command, or the command is not on the list. */
export function safetyFloorBlock(command: string | undefined): FloorBlock | null {
  const found = finding(command);
  return found.state === "blocked" ? found.block : null;
}

/** Whether the floor has nothing against answering for this command
 * automatically. A driver that answers a request inside the driver asks this
 * first; on false it answers nothing and raises the request, so the fold
 * decides with the same text. False for a never-list command and for one
 * that could not be read. */
export function safetyFloorClears(command: string | undefined): boolean {
  return finding(command).state === "clear";
}

type PermissionRequest = Pick<Extract<RuntimeEvent, { type: "request.opened" }>, "threadId" | "tool" | "summary" | "command" | "commandLine"> & { turnId?: string };

/** The command line a request would run: the engine's own text when the
 * driver sent it, else the exact-command descriptor's. A display summary is
 * cut at 200 characters, and a path cut short there can read as the
 * directory above it, so a summary is never read as a command. */
const commandLineOf = (event: PermissionRequest): string | undefined => event.commandLine ?? event.command?.command;

/** For the request.opened fold, around the grant's verdict. A verdict that
 * would answer automatically for a command the floor could not read becomes
 * one that answers nothing, so the request goes on to a card and a person
 * decides. Every other verdict is returned as it came. */
export function heldAtSafetyFloor(event: PermissionRequest, verdict: AutoVerdict): AutoVerdict {
  return verdict.approve && finding(commandLineOf(event)).state === "unreadable" ? { approve: null, source: "safety-floor" } : verdict;
}

/** For the request.opened fold, called once a grant has decided to allow the
 * request and before that allow is delivered. Returns true when the command
 * is on the never-list: the request has then been denied in the grant's
 * place, one line says so, and the decision log has the row. The caller must
 * neither allow the request nor show a card for it.
 *
 * The line and the row are written at once: the server's refusal is true the
 * moment it is made, whether or not the engine is still there to hear it. */
export function denyAtSafetyFloor(input: {
  event: PermissionRequest;
  requestId: string;
  bot: { id: string; name: string };
  adapter: Pick<ProviderAdapter, "respondToRequest" | "interruptTurn"> | undefined;
  /** Whether the turn that asked is still the one running on its thread. */
  isCurrent: () => boolean;
  say: (message: { role: "bot"; kind: "activity"; tool: { name: string; ok: boolean } }) => unknown;
  /** The request no longer waits on anyone: called once it has been answered,
   * or could not be. */
  release: () => void;
}): boolean {
  const { event, requestId, bot, adapter } = input;
  const block = safetyFloorBlock(commandLineOf(event));
  if (!block) return false;
  // `notice:` makes this a status row, which every client shows even with
  // tool calls hidden (src/lib/activity-runs.ts). `ok` is what the fold gives
  // every notice, so this row and the chat runtime's read the same.
  input.say({ role: "bot", kind: "activity", tool: { name: `notice: ${block.line}`, ok: true } });
  appendDecision(DATA_DIR, {
    threadId: event.threadId,
    requestId,
    botId: bot.id,
    botName: bot.name,
    tool: event.tool,
    summary: event.summary,
    decision: "auto-denied",
    source: "safety-floor",
    rule: block.rule,
  });
  void (async () => {
    try {
      await adapter?.respondToRequest(event.threadId, requestId, { behavior: "deny", message: block.reason });
    } catch {
      // The engine is still waiting on an answer nobody can give it, and no
      // card was shown. Stop the turn instead, as a failed allow does
      // (deliverFullAccessApproval), unless a newer turn owns the thread.
      if (event.turnId && input.isCurrent()) await adapter?.interruptTurn(event.threadId, event.turnId).catch(() => {});
    }
    if (input.isCurrent()) input.release();
  })().catch(() => {
    // Nothing above may take the server down, or become a new request: the
    // denial is already on the transcript and in the decision log.
    console.error("[safety-floor] Could not finish delivering a denial.");
  });
  return true;
}

/** The shell command a tool call carries: the string under `command` or
 * `cmd`, which is how a shell tool takes it on every MCP server we mount
 * (the cloud computer's `exec`, a terminal server's `run_command`). No other
 * argument is read, so words in a message or a file body are never a command. */
export function shellCommandOfToolCall(input: Record<string, unknown>): string | undefined {
  for (const key of ["command", "cmd"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** For a runtime that answers its own tool gate. Called when it is about to
 * run a tool call without asking anyone; returns the block, already written
 * to the decision log, or null. The runtime refuses the call with
 * `block.reason` and raises `block.line` as a notice. A command that could
 * not be read is refused too: such a runtime has no card to fall back on. */
export function floorBlockForToolCall(call: {
  threadId: string;
  botId?: string;
  tool: string;
  /** The bounded, redacted preview of the call's arguments. */
  summary?: string;
  input: Record<string, unknown>;
}): FloorBlock | null {
  const found = finding(shellCommandOfToolCall(call.input));
  if (found.state === "clear") return null;
  appendDecision(DATA_DIR, {
    threadId: call.threadId,
    botId: call.botId,
    tool: call.tool,
    summary: call.summary,
    decision: "auto-denied",
    source: "safety-floor",
    rule: found.block.rule,
  });
  return found.block;
}
