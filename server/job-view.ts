// What a person reads as "the job" of one conversation (GET
// /api/threads/:id/job): the conversation's own state and the work it holds
// on the job runtime (docs/runtime-contract.md), folded into one state with a
// plain reason. Pure: the route (routes/jobs.ts) gathers the rows and the
// conversation's state; MCP's wait_for_conversation and the openmausbot CLI
// read the result, so all three agree on when a job is done.
import { createHash } from "node:crypto";

import type { Assignment } from "./runtime/types.ts";

/** `job`: the conversation and every teammate it is still waiting on.
 * `turn`: the conversation's own turn only. */
export type JobScope = "job" | "turn";
export type JobState = "running" | "needs-input" | "completed" | "failed" | "stalled" | "idle";
/** Every state but running: a waiter stops (or, on needs-input, may wait on). */
export const FINAL_JOB_STATES: ReadonlySet<JobState> = new Set(["needs-input", "completed", "failed", "stalled", "idle"]);

export interface ConversationState {
  kind: "bot" | "room";
  /** A turn runs in this conversation now (a room: a member's, or the room between speakers). */
  busy: boolean;
  /** The bot's own activity in this thread (a bot's thread only). */
  activity?: string;
  /** Sends waiting behind the running turn. */
  queued: number;
}

export interface JobNode {
  id: string;
  rootId: string;
  parentId?: string;
  depth: number;
  botId: string;
  botName: string;
  threadId: string;
  threadTitle?: string;
  groupId?: string;
  status: Assignment["status"];
  outcome?: Assignment["outcome"];
  outcomeDetail?: string;
  question?: string;
  mode: Assignment["mode"];
  reply: Assignment["reply"];
  /** The conversation still waits on it (a one-way notice, or work whose requester stopped, is nobody's). */
  awaited: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  executions: number;
  /** What it last said or how it ended; clipped unless the read asked for full results. */
  result?: string;
}

export interface JobView {
  threadId: string;
  scope: JobScope;
  /** Work open at or begun after this server time is the job; pass it back to keep the same job. */
  since: number;
  now: number;
  state: JobState;
  /** One plain sentence on why the state is what it is. */
  reason: string;
  /** Changes whenever anything a waiter would report changes; pass it back to wait for the next change. */
  version: string;
  conversation: ConversationState;
  /** The rows the job starts from: this conversation's own turns, or the assignment it runs. */
  roots: string[];
  /** The rows the reader may see, starting rows first in the order they began. */
  nodes: JobNode[];
  /** Rows the reader may not see (they still count toward the state). */
  hidden: number;
  counts: Record<"queued" | "running" | "waiting" | "needsInput" | "completed" | "failed" | "cancelled", number>;
  needsInput: Array<{ id: string; botId: string; botName: string; threadId: string; question: string }>;
}

export interface JobInput {
  threadId: string;
  scope: JobScope;
  since: number;
  now: number;
  scopes: readonly string[];
  /** Oldest first. */
  rows: readonly Assignment[];
  conversation: ConversationState;
  /** The activity of the thread a running row works in (its bot's own, in a room). */
  activityOf(row: Assignment): string | undefined;
  nameOf(botId: string): string | undefined;
  titleOf(row: Assignment): string | undefined;
  visible(threadId: string): boolean;
  /** Results whole (at most the runtime's 12,000 characters) instead of clipped. */
  full?: boolean;
}

const RESULT_CLIP = 280;
const NODES_SHOWN = 500;
const ended = (a: Assignment) => a.status === "completed" || a.status === "failed" || a.status === "cancelled";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const names = (rows: readonly Assignment[], label: (row: Assignment) => string) => {
  const unique = [...new Set(rows.map(label))];
  return unique.length > 3 ? `${unique.slice(0, 3).join(", ")} and ${unique.length - 3} more` : unique.join(", ");
};

export function jobView(input: JobInput): JobView {
  const nameOf = (botId: string) => input.nameOf(botId) ?? botId;
  // The reason never names, or quotes, work in a conversation the reader may
  // not open: it still counts, as "a teammate".
  const shows = (row: Assignment) => input.visible(row.assignee.destination.threadId);
  const label = (row: Assignment) => shows(row) ? nameOf(row.assignee.botId) : "a teammate";
  const byId = new Map(input.rows.map((row) => [row.id, row]));
  const starts = new Set(input.scopes);
  // A row counts while the conversation still waits on it: a starting row
  // always; a row under it while it is awaited and every row above it is
  // still open. A one-way notice, or work under a requester that stopped,
  // is nobody's: it never holds the job open.
  const awaited = new Map<string, boolean>();
  const counts = (row: Assignment): boolean => {
    const known = awaited.get(row.id);
    if (known !== undefined) return known;
    awaited.set(row.id, false);
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    const result = starts.has(row.id) || (row.reply !== "none" && parent !== undefined && !ended(parent) && counts(parent));
    awaited.set(row.id, result);
    return result;
  };
  const scoped = input.rows.filter((row) => starts.has(row.id));
  const live = input.scope === "turn"
    ? scoped.filter((row) => !ended(row) && row.status !== "waiting")
    : input.rows.filter((row) => !ended(row) && counts(row));
  const parked = live.filter((row) => row.status === "needs_input");
  const asking = live.filter((row) => row.status === "running" && input.activityOf(row) === "waiting-on-you");
  const { conversation } = input;
  const lead = scoped.at(-1);
  const leadName = lead ? nameOf(lead.assignee.botId) : conversation.kind === "room" ? "The room" : "The bot";

  let state: JobState;
  let reason: string;
  if (conversation.activity === "waiting-on-you" || parked.length || asking.length) {
    state = "needs-input";
    const first = parked[0] ?? asking[0];
    reason = !first ? `${leadName} is waiting for your answer in this conversation`
      : shows(first) ? `${nameOf(first.assignee.botId)} needs you: ${first.question ?? "an approval is waiting in its conversation"}`
      : "A teammate needs an answer in a conversation you cannot open";
  } else if (conversation.activity === "dead") {
    state = "failed";
    reason = `${leadName}'s engine stopped unexpectedly`;
  } else if (conversation.activity === "no-signal") {
    state = "stalled";
    reason = `No sign of progress from ${leadName}'s engine`;
  } else if (conversation.busy || conversation.queued > 0 || live.length) {
    state = "running";
    const teammates = live.filter((row) => !starts.has(row.id));
    reason = conversation.busy ? `${leadName} is working`
      : teammates.length ? `Waiting on ${plural(teammates.length, "teammate task", "teammate tasks")}: ${names(teammates, label)}`
      : conversation.queued > 0 ? "A message is waiting its turn"
      : `${leadName} is about to continue`;
  } else if (!lead) {
    state = "idle";
    reason = "Nothing is running in this conversation";
  } else if (lead.status === "completed" || lead.status === "waiting") {
    state = "completed";
    const failed = input.rows.filter((row) => row.id !== lead.id && (row.status === "failed" || row.status === "cancelled"));
    reason = `${leadName} finished${failed.length ? `; ${plural(failed.length, "teammate task", "teammate tasks")} did not complete (${names(failed, label)})` : ""}`;
  } else {
    state = lead.outcome === "stalled" ? "stalled" : "failed";
    reason = `${leadName}'s work ended ${lead.status === "cancelled" || lead.outcome === "stopped" ? "because it was stopped" : `as ${lead.outcome ?? lead.status}`}${lead.outcomeDetail ? `: ${lead.outcomeDetail}` : ""}`;
  }

  const shown = input.rows.filter(shows);
  // Past the cap the newest rows are listed (rows come oldest first): a long
  // conversation read from its start shows its latest job whole, teammates
  // included, rather than its first requests alone.
  const listed = shown.slice(-NODES_SHOWN);
  const ordered = [...listed.filter((row) => starts.has(row.id)), ...listed.filter((row) => !starts.has(row.id))];
  const tally = { queued: 0, running: 0, waiting: 0, needsInput: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const row of input.rows) {
    if (row.status === "needs_input") tally.needsInput += 1;
    else if (row.status === "resume") tally.queued += 1;
    else tally[row.status] += 1;
  }
  const version = createHash("sha256").update(JSON.stringify([
    state, conversation.busy, conversation.activity ?? "", conversation.queued, asking.map((row) => row.id),
    input.rows.map((row) => [row.id, row.status, row.outcome ?? "", row.executions, row.question ?? ""]),
  ])).digest("base64url").slice(0, 16);
  const node = (row: Assignment): JobNode => {
    const { destination } = row.assignee;
    const title = input.titleOf(row);
    const result = ended(row) || row.status === "waiting" || row.status === "needs_input" ? row.result : "";
    return {
      id: row.id, rootId: row.rootId, ...(row.parentId ? { parentId: row.parentId } : {}), depth: row.depth,
      botId: row.assignee.botId, botName: nameOf(row.assignee.botId), threadId: destination.threadId,
      ...(title ? { threadTitle: title } : {}), ...(destination.groupId ? { groupId: destination.groupId } : {}),
      status: row.status, ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.outcomeDetail ? { outcomeDetail: row.outcomeDetail } : {}),
      ...(row.question ? { question: row.question } : {}), mode: row.mode, reply: row.reply,
      awaited: input.scope === "job" ? counts(row) : starts.has(row.id),
      createdAt: row.createdAt, ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
      ...(row.finishedAt !== undefined ? { finishedAt: row.finishedAt } : {}), executions: row.executions,
      ...(result ? { result: input.full || result.length <= RESULT_CLIP ? result : `${result.slice(0, RESULT_CLIP)}…` } : {}),
    };
  };
  return {
    threadId: input.threadId, scope: input.scope, since: input.since, now: input.now, state, reason, version, conversation,
    roots: [...input.scopes], nodes: ordered.map(node), hidden: input.rows.length - shown.length, counts: tally,
    needsInput: [...parked, ...asking].filter((row) => input.visible(row.assignee.destination.threadId)).map((row) => ({
      id: row.id, botId: row.assignee.botId, botName: nameOf(row.assignee.botId), threadId: row.assignee.destination.threadId,
      question: row.question ?? "An approval is waiting in its conversation",
    })),
  };
}
