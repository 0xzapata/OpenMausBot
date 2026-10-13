// run and wait: give a bot or room one job and wait until it, and every
// teammate it asked, is done. The waiting is MCP's wait_for_conversation
// (one loop, held by the server between changes); a wait longer than one
// call carries the job's since and version into the next, so it keeps
// watching the same job. Exit codes: 0 done, 1 failed or stopped, 3 needs
// you, 4 timed out, 130 Ctrl-C (the work keeps running).
import { messageFileTargets } from "../message-file.ts";
import { EXIT, flag, HeadlessError, oneOf, parseCount, usageError } from "./args.ts";
import { readJob, type HeadlessClient } from "./client.ts";
import { newSendId, readMessage, resolveTarget, waitPolicy, type Target, type VerbContext, type VerbOutcome } from "./context.ts";
import { exportJob } from "./export.ts";
import { oneLine } from "./output.ts";

type Rec = Record<string, any>;
const ENDED = new Set(["completed", "failed", "cancelled"]);
const MCP_WAIT_MAX_S = 120;
const enc = encodeURIComponent;

/** Stop every teammate still working on a job, after its own conversation was stopped. */
export async function stopTeammates(client: HeadlessClient, threadId: string, nodes: readonly Rec[]): Promise<Rec[]> {
  const stopped: Rec[] = [];
  for (const node of nodes) {
    if (ENDED.has(node.status) || node.threadId === threadId) continue;
    const route = node.groupId ? `/api/groups/${enc(node.groupId)}/interrupt` : `/api/bots/${enc(node.botId)}/interrupt`;
    try {
      await client.json(route, { method: "POST", body: JSON.stringify({ threadId: node.threadId }) });
      stopped.push({ id: node.id, botId: node.botId, botName: node.botName, threadId: node.threadId });
    } catch {
      // it ended on its own in the meantime
    }
  }
  return stopped;
}

/** Stop a conversation, and with `tree` every teammate still working on
 * its open job: the job is read first, since the stop ends it. */
export async function stopConversation(client: HeadlessClient, target: Target, tree: boolean): Promise<{ result: Rec; stopped: Rec[] }> {
  let threadId = target.taskId;
  if (tree && !threadId) {
    const fleet = await client.json<Rec>("/api/bots?messages=0");
    threadId = (target.type === "bot" ? fleet.bots : fleet.groups)?.find((record: Rec) => record.id === target.id)?.threadId;
  }
  const open = tree && threadId ? (await readJob(client, threadId)).nodes ?? [] : [];
  const result = await client.tool("interrupt_conversation", { target_type: target.type, target_id: target.id, ...(threadId ? { task_id: threadId } : {}) });
  return { result, stopped: tree ? await stopTeammates(client, result.taskId, open) : [] };
}

const exitFor = (result: Rec, strict: boolean): number => {
  if (result.status === "settled") {
    const failed = (result.job?.nodes ?? []).some((node: Rec) => node.status === "failed" || node.status === "cancelled");
    return strict && failed ? EXIT.failed : EXIT.done;
  }
  return result.status === "needs-user" ? EXIT.needsInput : result.status === "timed-out" ? EXIT.timeout : EXIT.failed;
};

interface Waited { result: Rec; exitCode: number; stopped?: Rec[] }

/** Wait on one conversation's job until it ends, needs the person (unless
 * --on-input wait), or the timeout passes; then apply --on-input stop and
 * --on-timeout stop. Progress goes to stderr as each new state arrives. */
async function waitOnJob(ctx: VerbContext, client: HeadlessClient, target: Target,
  options: { scope: "job" | "turn"; since?: number; taskId?: string }): Promise<Waited> {
  const policy = waitPolicy(ctx);
  const deadline = Date.now() + policy.timeoutMs;
  let since = options.since;
  let after: string | undefined;
  let taskId = options.taskId ?? target.taskId;
  let result: Rec;
  for (;;) {
    const seconds = Math.min(MCP_WAIT_MAX_S, Math.max(1, Math.ceil((deadline - Date.now()) / 1_000)));
    result = await client.tool("wait_for_conversation", {
      target_type: target.type, target_id: target.id, ...(taskId ? { task_id: taskId } : {}), timeout_seconds: seconds, scope: options.scope,
      ...(since !== undefined ? { since_ms: since } : {}), ...(after !== undefined ? { after_version: after } : {}),
    }, {
      onProgress: (job) => ctx.output.progress({ event: "job", threadId: job.threadId, state: job.state, reason: job.reason, counts: job.counts,
        ...(job.needsInput?.length ? { needsInput: job.needsInput } : {}) }),
    }, ctx.signal);
    taskId ??= result.taskId;
    if (typeof result.job?.since === "number") since = result.job.since;
    const more = Date.now() < deadline && (result.status === "timed-out" || (result.status === "needs-user" && policy.onInput === "wait"));
    if (!more) break;
    after = result.job?.version;
  }
  let exitCode = exitFor(result, policy.strict);
  // waiting through a question until the time ran out is a timeout
  if (exitCode === EXIT.needsInput && policy.onInput === "wait") exitCode = EXIT.timeout;
  const stop = (exitCode === EXIT.needsInput && policy.onInput === "stop") || (exitCode === EXIT.timeout && policy.onTimeout === "stop");
  if (!stop) return { result, exitCode };
  const { stopped } = await stopConversation(client, { ...target, taskId: result.taskId }, true);
  return { result, exitCode, stopped };
}

const HEADLINE: Record<number, string> = {
  [EXIT.done]: "Done", [EXIT.failed]: "Did not finish", [EXIT.needsInput]: "Needs you", [EXIT.timeout]: "Still running",
};

/** The last thing the bot (or a room member) said, and the files it links. */
function finalReply(messages: readonly Rec[] | undefined): { text: string; from?: string; files: string[] } | undefined {
  const reply = [...(messages ?? [])].reverse().find((message) => message.role === "bot" && message.kind === "text" && message.text?.trim());
  return reply ? { text: reply.text, ...(reply.from?.name ? { from: reply.from.name } : {}), files: messageFileTargets(reply.text) } : undefined;
}

function report(waited: Waited, threadId: string, extra: Rec = {}): { result: Rec; human: string[] } {
  const { result, exitCode } = waited;
  const reply = finalReply(result.messages);
  const job = result.job ?? {};
  const human = [
    `${HEADLINE[exitCode] ?? "Ended"}: ${job.reason ?? result.status}${exitCode === EXIT.timeout ? " (it keeps running)" : ""}`,
    ...(reply ? ["", reply.text, ""] : []),
    ...(reply?.files.length ? [`Files: ${reply.files.join(", ")}`] : []),
    ...(job.needsInput?.length ? job.needsInput.map((item: Rec) => `${item.botName} asks: ${oneLine(item.question, 300)}`) : []),
    ...(waited.stopped ? [`Stopped the conversation${waited.stopped.length ? ` and ${waited.stopped.length} teammate task${waited.stopped.length === 1 ? "" : "s"}` : ""}.`] : []),
    `Thread: ${threadId}${exitCode === EXIT.done ? "" : ` (wait again: openmausbot wait --thread ${threadId})`}`,
  ];
  return {
    result: { ...result, ok: exitCode === EXIT.done, exitCode, threadId, ...(reply ? { reply } : {}), ...(waited.stopped ? { stopped: waited.stopped } : {}), ...extra },
    human,
  };
}

/** Ctrl-C while waiting: the work goes on; say how to pick it up again. */
const interrupted = (threadId: string | undefined): HeadlessError =>
  new HeadlessError("stopped waiting; the work keeps running", EXIT.interrupted,
    threadId ? `wait again: openmausbot wait --thread ${threadId}` : "openmausbot wait TARGET picks it up again");

export async function runVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const named = Boolean(flag(ctx.flags, "bot") ?? flag(ctx.flags, "channel") ?? flag(ctx.flags, "thread"));
  const [first, second] = ctx.positionals;
  const text = await readMessage(ctx, named ? first : second);
  const mode = oneOf(flag(ctx.flags, "wait"), "--wait", ["job", "turn", "none"] as const, "job");
  waitPolicy(ctx); // usage errors before anything is sent
  const task = flag(ctx.flags, "task")?.trim() || (flag(ctx.flags, "thread") ? undefined : "new");
  const target = await resolveTarget({ ...ctx, flags: { ...ctx.flags, task: undefined } }, named ? undefined : first);
  const client = await ctx.client();
  let threadId: string;
  if (target.taskId) threadId = target.taskId;
  else if (task === "new") {
    const title = (flag(ctx.flags, "title") ?? text.split("\n")[0]!).trim().slice(0, 80) || "Headless run";
    threadId = (await client.tool("create_task", { target_type: target.type, target_id: target.id, title })).task.taskId;
  } else if (task === "current") {
    const fleet = await client.json<Rec>("/api/bots?messages=0");
    const owner = (target.type === "bot" ? fleet.bots : fleet.groups)?.find((record: Rec) => record.id === target.id);
    if (!owner) throw usageError(`no ${target.type === "bot" ? "bot" : "room"} with id ${target.id}`);
    threadId = owner.threadId;
  } else threadId = task!;
  // The job is everything open at, or begun after, this moment by the server's clock.
  const since = Number((await readJob(client, threadId)).now);
  const sendId = flag(ctx.flags, "send-id") ?? newSendId();
  const tool = target.type === "bot" ? "send_bot_message" : "send_channel_message";
  const args = { [`${target.type}_id`]: target.id, task_id: threadId, text, send_id: sendId };
  let sent: Rec | undefined;
  for (let attempt = 1; !sent; attempt++) {
    try {
      sent = await client.tool(tool, args);
    } catch (error) {
      // The same send id makes a retry land on the first send, never beside it.
      const unreachable = error instanceof TypeError || (error as Error)?.name === "TimeoutError";
      if (!unreachable || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  ctx.output.progress({ event: "started", threadId, target: { type: target.type, id: target.id, ...(target.name ? { name: target.name } : {}) },
    sendId, ...(sent.messageId ? { messageId: sent.messageId } : {}), ...(sent.queued ? { queued: true } : {}), since });
  if (mode === "none") {
    return {
      result: { ok: true, exitCode: EXIT.done, threadId, sendId, since, ...sent },
      exitCode: EXIT.done,
      human: [`Sent. Thread: ${threadId}`, `Wait for it with: openmausbot wait --thread ${threadId} --since ${since}`],
    };
  }
  let waited: Waited;
  try {
    waited = await waitOnJob(ctx, client, target, { scope: mode, since, taskId: threadId });
  } catch (error) {
    if (ctx.signal.aborted) throw interrupted(threadId);
    throw error;
  }
  let exported: Rec | undefined;
  const out = flag(ctx.flags, "export");
  if (out) {
    try {
      exported = await exportJob(client, { threadId, out, since, force: true }, ctx.output);
    } catch (error) {
      exported = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const { result, human } = report(waited, threadId, { sendId, since, ...(exported ? { export: exported } : {}) });
  if (exported) human.push(exported.ok === false ? `Export failed: ${exported.error}` : `Exported to ${exported.out} (${exported.files?.length ?? 0} files, ${exported.transcripts?.length ?? 0} transcripts).`);
  return { result, exitCode: exported?.ok === false && waited.exitCode === EXIT.done ? EXIT.failed : waited.exitCode, human };
}

export async function waitVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const scope = oneOf(flag(ctx.flags, "for"), "--for", ["job", "turn"] as const, "job");
  const rawSince = flag(ctx.flags, "since");
  const since = rawSince === undefined ? undefined : parseCount(rawSince, "--since", 0, Number.MAX_SAFE_INTEGER, 0);
  waitPolicy(ctx);
  const target = await resolveTarget(ctx, ctx.positionals[0]);
  const client = await ctx.client();
  let waited: Waited;
  try {
    waited = await waitOnJob(ctx, client, target, { scope, ...(since !== undefined ? { since } : {}) });
  } catch (error) {
    if (ctx.signal.aborted) throw interrupted(target.taskId);
    throw error;
  }
  if (typeof waited.result.status !== "string") return { result: waited.result, exitCode: EXIT.done, human: [] };
  const { human } = report(waited, waited.result.taskId);
  // control-omb and MCP read the tool's own result: keep it as it came.
  return { result: waited.stopped ? { ...waited.result, stopped: waited.stopped } : waited.result, exitCode: waited.exitCode, human };
}
