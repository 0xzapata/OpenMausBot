// GET /api/threads/:threadId/job: the job of one conversation as a person
// reads it (server/job-view.ts), for the openmausbot CLI, MCP's
// wait_for_conversation and anyone scripting OpenMausBot. With `wait` and the
// `version` a previous read returned, the request is held until the job
// changes or the wait runs out: one cheap request instead of a poll loop.
// It wakes on the store's change feed (a turn starting or ending, a report
// landing, a bot's activity), and looks again every few seconds for a change
// the feed does not carry.
//
// Built by routes/threads.ts with the conversation reads it belongs to.
import type { RequestAuth } from "../request-auth.ts";
import type { Viewer, VisibleSet } from "../bot-visibility.ts";
import { queuedChannelSends } from "../channel-queue.ts";
import type { Coordinator } from "../coordinator.ts";
import { jobView, type ConversationState, type JobScope, type JobView } from "../job-view.ts";
import { hasQueuedSteeredMessages } from "../steer-queue.ts";
import type { Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** The longest a read is held. Clients ask again with the version they got. */
export const JOB_WAIT_MAX_MS = 25_000;
const RECHECK_MS = 2_000;
const SETTLE_MS = 150;

export interface JobRouteDeps {
  store: Pick<Store, "bot" | "botByThread" | "groupByThread" | "taskByThread" | "groupTaskByThread" | "onChange">;
  coordinator: Pick<Coordinator, "job">;
  /** A room thread has a turn running or is between speakers (index.ts). */
  groupThreadIsWorking(groupId: string, threadId: string): boolean;
  viewerFor(auth: RequestAuth): Viewer;
  visibleTo(viewer: Viewer): VisibleSet;
  now?: () => number;
  /** How often a held read looks again without a change (tests shorten it). */
  recheckMs?: number;
}

export function createJobRoutes(deps: JobRouteDeps): RouteHandler {
  const { store, coordinator } = deps;
  const now = deps.now ?? Date.now;

  const conversationOf = (threadId: string): ConversationState | null => {
    const bot = store.botByThread(threadId);
    if (bot) {
      const task = store.taskByThread(bot.id, threadId);
      return {
        kind: "bot", busy: task?.busy === true || task?.activity === "working" || task?.activity === "parked.computer",
        ...(task?.activity ? { activity: task.activity } : {}), queued: hasQueuedSteeredMessages(bot.id, threadId) ? 1 : 0,
      };
    }
    const group = store.groupByThread(threadId);
    return group ? { kind: "room", busy: deps.groupThreadIsWorking(group.id, threadId), queued: queuedChannelSends(threadId) } : null;
  };

  const read = (threadId: string, scope: JobScope, since: number, full: boolean, visible: VisibleSet): JobView | null => {
    const conversation = conversationOf(threadId);
    if (!conversation) return null;
    const owner = store.botByThread(threadId);
    const { scopes, rows } = coordinator.job(threadId, since, owner?.id);
    return jobView({
      threadId, scope, since, now: now(), scopes, rows, conversation, full,
      // A teammate's thread: its own activity; in a room, the speaking bot's.
      activityOf: (row) => row.assignee.destination.groupId
        ? store.bot(row.assignee.botId)?.activity
        : store.taskByThread(row.assignee.botId, row.assignee.destination.threadId)?.activity,
      nameOf: (botId) => store.bot(botId)?.name,
      titleOf: (row) => row.assignee.destination.groupId
        ? store.groupTaskByThread(row.assignee.destination.groupId, row.assignee.destination.threadId)?.title
        : store.taskByThread(row.assignee.botId, row.assignee.destination.threadId)?.title,
      visible: (thread) => visible.thread(thread),
    });
  };

  return async ({ res, url, path, method, auth, json }) => {
    const m = /^\/api\/threads\/([\w-]+)\/job$/.exec(path);
    if (!m || method !== "GET") return PASS;
    const threadId = m[1]!;
    const params = url.searchParams;
    const scope = params.get("scope") ?? "job";
    if (scope !== "job" && scope !== "turn") return json(res, 400, { error: "scope must be job or turn" });
    const number = (name: string, max: number) => {
      const raw = params.get(name);
      if (raw === null || raw === "") return 0;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
    };
    const sinceParam = number("since", Number.MAX_SAFE_INTEGER);
    const wait = number("wait", JOB_WAIT_MAX_MS);
    if (sinceParam === null) return json(res, 400, { error: "since must be a server time in milliseconds" });
    if (wait === null) return json(res, 400, { error: `wait must be 0 to ${JOB_WAIT_MAX_MS} milliseconds` });
    // No `since`: the work open now. A waiter passes back the since it got,
    // so the job it watches does not move under it.
    const since = params.has("since") ? sinceParam : now();
    const full = params.get("full") === "1";
    const known = params.get("version") ?? "";
    const visible = deps.visibleTo(deps.viewerFor(auth));
    if (!visible.thread(threadId)) return json(res, 404, { error: "no such conversation" });
    let view = read(threadId, scope, since, full, visible);
    if (!view) return json(res, 404, { error: "no such conversation" });
    if (!wait || view.version !== known) return json(res, 200, view);

    // Held: answer at the first change, or with the same view when the wait runs out.
    view = await new Promise<JobView | null>((answer) => {
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (next: JobView | null) => {
        if (done) return;
        done = true;
        clearTimeout(settleTimer);
        clearTimeout(deadline);
        clearInterval(recheck);
        unsubscribe();
        res.off("close", abandoned);
        answer(next);
      };
      const look = () => {
        if (done) return;
        let next: JobView | null;
        try { next = read(threadId, scope, since, full, visible); } catch { next = null; }
        if (!next || next.version !== known) finish(next);
      };
      const abandoned = () => finish(null);
      // A burst of changes (a streaming reply) is read once it pauses.
      const unsubscribe = store.onChange(() => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(look, SETTLE_MS);
      });
      const recheck = setInterval(look, deps.recheckMs ?? RECHECK_MS);
      const deadline = setTimeout(() => finish(read(threadId, scope, since, full, visible)), wait);
      // The response closes before it is written only when the client went away.
      res.on("close", abandoned);
    });
    if (res.writableEnded || res.destroyed) return;
    if (!view) return json(res, 404, { error: "no such conversation" });
    return json(res, 200, view);
  };
}
