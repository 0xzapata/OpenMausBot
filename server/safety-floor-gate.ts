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
//     asks safetyFloorBlock first and, for a never-list command, does not
//     answer: the request is raised like any other and lands in the fold.
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
import { DATA_DIR, safetyFloorEnabled, type AppConfig } from "./config.ts";
import type { ProviderAdapter } from "./contracts.ts";
import { appendDecision } from "./decision-log.ts";
import { floorVerdict, type FloorVerdict } from "./safety-floor.ts";

/** Read per request, so a settings save applies to the next one. Until the
 * server binds its config, only OMB_SAFETY_FLOOR can switch the floor on. */
let config: () => AppConfig = () => ({});

/** The server binds its live config once (server/index.ts). */
export function bindSafetyFloor(provider: () => AppConfig): void {
  config = provider;
}

/** Whether the floor is on right now, after the environment: what
 * GET /api/config reports, so an operator can see that a switch took. */
export function safetyFloorOn(): boolean {
  return safetyFloorEnabled(config());
}

export interface FloorBlock extends FloorVerdict {
  /** `Blocked by the safety floor: <label>`: the line a person sees. */
  line: string;
  /** What the engine is told in place of an approval. */
  reason: string;
}

/** The block a shell command meets, or null: the floor is off, there is no
 * command, or the command is not on the never-list. */
export function safetyFloorBlock(command: string | undefined): FloorBlock | null {
  if (!command || !safetyFloorOn()) return null;
  const verdict = floorVerdict(command, process.platform, homedir());
  if (!verdict) return null;
  const line = `Blocked by the safety floor: ${verdict.label}`;
  return {
    ...verdict,
    line,
    // The model reads this as the tool's result. It is told what happened and
    // what to do next, so it reports the block instead of trying a spelling
    // the floor does not know.
    reason: `${line}. This command is never approved automatically, at any approval level. Do not retry it or look for another way to do the same thing; tell the person what you were trying to do.`,
  };
}

type PermissionRequest = Pick<Extract<RuntimeEvent, { type: "request.opened" }>, "threadId" | "tool" | "summary" | "command"> & { turnId?: string };

/** For the request.opened fold, called once a grant has decided to allow the
 * request and before that allow is delivered. Returns true when the command
 * is on the never-list: the request has then been denied in the grant's
 * place, one line says so, and the decision log has the row. The caller must
 * neither allow the request nor show a card for it.
 *
 * Only the exact shell input a driver attached is read (`event.command`).
 * A display summary is cut at 200 characters, and a path cut short there can
 * read as the directory above it, so it is never classified.
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
  const block = safetyFloorBlock(event.command?.command);
  if (!block) return false;
  // `notice:` makes this a status row, which every client shows even with
  // tool calls hidden (src/lib/activity-runs.ts).
  input.say({ role: "bot", kind: "activity", tool: { name: `notice: ${block.line}`, ok: false } });
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
  })();
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
 * `block.reason` and raises `block.line` as a notice. */
export function floorBlockForToolCall(call: {
  threadId: string;
  botId?: string;
  tool: string;
  /** The bounded, redacted preview of the call's arguments. */
  summary?: string;
  input: Record<string, unknown>;
}): FloorBlock | null {
  const block = safetyFloorBlock(shellCommandOfToolCall(call.input));
  if (!block) return null;
  appendDecision(DATA_DIR, {
    threadId: call.threadId,
    botId: call.botId,
    tool: call.tool,
    summary: call.summary,
    decision: "auto-denied",
    source: "safety-floor",
    rule: block.rule,
  });
  return block;
}
