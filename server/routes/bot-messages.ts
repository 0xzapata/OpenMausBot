// A bot's conversation routes, moved out of server/index.ts's inline routes
// into the route table (server/routes/README.md): a person's message to a
// bot (plain and guarded), the steer queue, compaction, editing a message
// into a new branch, switching the visible branch, answering a card by bot
// or by thread, and Stop. The table runs after the auth gate; scope rules
// stay keyed by path in server/request-auth.ts.
import type { ServerResponse } from "node:http";
import { z } from "zod";

import { approvalModeFor } from "../../shared/approval-mode.ts";
import { isPersistentQuestionCard, QUESTION_DISMISS_MESSAGE } from "../../shared/ask-question.ts";
import type { ResolvedSender, SteerQueueReason } from "../../shared/wire.ts";
import { admit } from "../admission.ts";
import type { ModelSelection, RequestOutcome, SteerOutcome } from "../contracts.ts";
import { parseDataContext, type DataContext } from "../data-context.ts";
import type { Handoffs } from "../delta-context.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { spokenLineFields } from "../live-call-record.ts";
import { resolvePeerComms, type ApprovalBus } from "../peer-approval.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import { acceptedSendMatch, parseSendId } from "../send-idempotency.ts";
import { cancelSteeredMessage, holdSteeredQueue, restoreHeldSteeredQueue, settleHeldSteeredQueue } from "../steer-queue.ts";
import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";
import { extractSteerImages } from "../turn-images.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { pinnedClientThreadGuard } from "./pinned-client-thread.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** A running engine, as the registry hands it out. */
type RunningInstance = ReturnType<ProviderRegistry["get"]>;

/** What acceptDirectSend (server/index.ts) answers with: the message that
 * started or was steered into a turn, or the queue slot the words wait in.
 * Written out here so the module needs nothing from index.ts. */
type DirectSendReceipt =
  | { ok: true; threadId: string; message: Message; steered?: true }
  | { ok: true; queued: true; queueId: string; threadId: string; reason?: SteerQueueReason };

/** A skill card's answer as resolveSkillRequest (server/index.ts) returns it. */
type SkillResolution =
  | { claimed: false }
  | { claimed: true; status: number; error: string }
  | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true };

/** A card answered on a bot's behalf: who it was for, where, and how. */
type CardAnswer = { botId: string; botName?: string; threadId: string; requestId: string; behavior: string };

type Behavior = "allow" | "deny" | "answer";

export interface BotMessageRouteDeps {
  store: Pick<Store,
    | "activeLeaf" | "appendMessage" | "bot" | "botByThread" | "bots" | "groupByThread" | "messagesFor"
    | "patchMessage" | "patchTask" | "projectBotForTask" | "setActiveLeaf" | "setTaskAskedAt" | "taskByThread" | "tasks">;
  registry: Pick<ProviderRegistry, "get">;
  /** Assigned at boot, after the routes are built (server/host/README.md, rule 5). */
  routines(): RoutineManager | null;
  handoffs: Pick<Handoffs, "current" | "steered" | "stoppedByPerson">;
  approvalBus: ApprovalBus;
  phoneSecretSubmissions: Pick<PhoneSecretSubmissionRegistry, "hasThread">;
  /** index.ts's Maps, read here only. */
  directTurnDispatchClaims: { get(threadId: string): { threadId: string } | undefined };
  groupSpeakers: ReadonlyMap<string, { botId: string }>;
  desktopManaged: boolean;
  cloudHome: boolean;
  /** The refusal acceptDirectSend throws; the route turns it into its answer. */
  DirectSendRefused: abstract new (...args: never[]) => { readonly status: number; readonly body: Record<string, unknown> };
  acceptDirectSend(
    input: {
      botId: string; threadId: string; text: string; sendId?: string; replyTo?: Message; sender?: ResolvedSender;
      trigger: UsageTrigger; dataContext?: DataContext; personPresent: boolean;
    },
    guardedStart?: (currentAtStart: BotRecord) => Promise<DirectSendReceipt>,
  ): Promise<DirectSendReceipt>;
  directSendRefusal(botId: string, threadId: string): { status: number; body: Record<string, unknown> } | null;
  startTurn(botId: string, text: string, opts?: {
    threadId?: string; replyTo?: Message; sendId?: string; sender?: ResolvedSender; trigger?: UsageTrigger; relayed?: boolean;
    dataContext?: DataContext; compactOnly?: boolean; cardContinuation?: boolean; editedMessageId?: string;
  }): Promise<Message>;
  usageTriggerFor(auth: RequestAuth): UsageTrigger;
  messageSender(auth: RequestAuth): ResolvedSender | undefined;
  cloudGuestSendRefusal(auth: RequestAuth, threadId: string): string | null;
  cloudThreadRefusal(auth: RequestAuth, threadId: string): string | null;
  cloudOwnerSession(auth: RequestAuth): boolean;
  cardAnswerRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null;
  commandRememberRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null;
  requestBehavior(value: unknown): Behavior | null;
  requestedTaskBot(botId: string, rawThreadId: unknown): BotRecord;
  botForThread(botId: string, threadId: string): BotRecord | null;
  threadBusy(botId: string, threadId: string): boolean;
  botAtThreadCapacity(botId: string): boolean;
  parksBehindCoordination(botId: string, threadId: string): boolean;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  runningTurnInstance(bot: BotRecord | null | undefined, threadId: string): RunningInstance;
  engineSteersImages(instance: RunningInstance | undefined): boolean;
  resolveReplyTarget(threadId: string, value: unknown): Message | undefined;
  turnSelection(botId: string, threadId: string): ModelSelection | undefined;
  policyModelRefusal(instance: { instanceId: string; driverKind: string }): string | undefined;
  clearUnattended(threadId: string): void;
  drainQueuedSends(): void;
  answeringCardAs(auth: RequestAuth, threadId: string, requestId: string, work: () => Promise<unknown>): Promise<void>;
  resolveAndSendTrust(res: ServerResponse, threadId: string, requestId: string, behavior: Behavior): boolean;
  resolveAndSendTeamSetup(res: ServerResponse, args: { botId: string; threadId: string; requestId: string; behavior: string }, ownerReview: boolean): Promise<boolean>;
  resolveAndSendRoutine(res: ServerResponse, args: CardAnswer, ownersAnswer?: boolean): boolean;
  resolveAndSendProfile(res: ServerResponse, args: CardAnswer): boolean;
  resolveAndSendModel(res: ServerResponse, args: CardAnswer): boolean;
  resolveSkillRequest(args: CardAnswer & { behavior: Behavior; reviewedSha256?: string }): SkillResolution;
  sendSkillResolution(res: ServerResponse, result: SkillResolution): boolean;
  answerRequest(
    threadId: string, instanceId: string, requestId: string, behavior: Behavior, message?: string,
    decidedFor?: { id: string; name: string }, always?: boolean, rememberCommand?: boolean,
  ): Promise<RequestOutcome>;
  deliverLateQuestionAnswer(auth: RequestAuth, threadId: string, requestId: string, answer: string, cardMessage: Message, owner: BotRecord): Promise<{ queued: boolean }>;
  interruptDirectThread(botId: string, threadId: string): Promise<void>;
  cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): unknown;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  cancelGroupTurnOperations(groupId: string, threadId: string): void;
  closeOpenApprovals(threadId: string): void;
}

/** The guarded send contract external interfaces (the Slack worker) opt into.
 * `onBehalfOf` is additive and advertised by /api/health
 * (capabilities.guardedOnBehalfOf): it names the person a relay acts for, so
 * the turn is booked to them rather than to this machine. Only this
 * admin-scoped route reads it; every other send is booked to its own
 * session. */
const guardedSendSchema = z.object({
  threadId: z.string().regex(/^[\w-]+$/),
  sendId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  text: z.string().min(1),
  expectedActiveLeafId: z.string().regex(/^[\w-]+$/).nullable(),
  expectedApprovalMode: z.enum(["ask", "full"]).optional(),
  replyToId: z.string().optional(),
  onBehalfOf: z.object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  }).strict().refine((who) => Boolean(who.email || who.name)).optional(),
}).strict();

export function createBotMessageRoutes(deps: BotMessageRouteDeps): RouteHandler {
  const {
    store, registry, handoffs, approvalBus, phoneSecretSubmissions, directTurnDispatchClaims, groupSpeakers,
    desktopManaged: DESKTOP_MANAGED, cloudHome: CLOUD_HOME, DirectSendRefused,
    acceptDirectSend, directSendRefusal, startTurn, usageTriggerFor, messageSender, cloudGuestSendRefusal, cloudThreadRefusal,
    cloudOwnerSession, cardAnswerRefusal, commandRememberRefusal, requestBehavior, requestedTaskBot, botForThread, threadBusy,
    botAtThreadCapacity, parksBehindCoordination, activeGroupTurnForBot, runningTurnInstance, engineSteersImages, resolveReplyTarget,
    turnSelection, policyModelRefusal, clearUnattended, drainQueuedSends, answeringCardAs, resolveAndSendTrust, resolveAndSendTeamSetup,
    resolveAndSendRoutine, resolveAndSendProfile, resolveAndSendModel, resolveSkillRequest, sendSkillResolution, answerRequest,
    deliverLateQuestionAnswer, interruptDirectThread, cancelDirectTurnDispatch, revokeInternalCapabilitiesForThread,
    cancelGroupTurnOperations, closeOpenApprovals,
  } = deps;
  const pinnedClientThread = pinnedClientThreadGuard(store);
  return async ({ req, res, path, method, auth, json, readBody }) => {
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const requirePinnedClientThread = pinnedClientThread(auth, req);
    const routines = deps.routines();
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages(?:\/(guarded))?$/);
    if (m && method === "POST") {
      const guarded = m[2] === "guarded";
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      // External interfaces must opt into a distinct route: an older server
      // returns 404 rather than silently ignoring safety preconditions.
      const guardedBody = guarded ? guardedSendSchema.safeParse(body) : null;
      if (guardedBody && !guardedBody.success) {
        const onBehalfOfInvalid = guardedBody.error.issues.some((issue) => issue.path[0] === "onBehalfOf");
        return json(res, 400, { error: onBehalfOfInvalid
          ? "onBehalfOf must name the person with an email address, a name, or both"
          : "guarded sends require threadId, sendId, text and expectedActiveLeafId" });
      }
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      requirePinnedClientThread(bot.id, body.threadId);
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      // A retry carries its original task. That lets us return the canonical
      // receipt after a task switch, while a genuinely new send still has to
      // target the task that is active now.
      const threadId = body.threadId ?? bot.threadId;
      const notYours = cloudGuestSendRefusal(auth, threadId);
      if (notYours) return json(res, 403, { error: notYours });
      // Who this message is from, for the ledger. It is captured here and
      // travels with the message: into the turn it starts, or into the queue
      // until it drains. A message steered into someone else's running turn
      // books nothing — that turn stays with whoever started it. A guarded
      // relay (the Slack worker, which already holds admin scope to reach
      // this route) names the person it acts for.
      const onBehalfOf = guardedBody?.data?.onBehalfOf;
      const trigger: UsageTrigger = onBehalfOf
        ? { kind: "user", ...(onBehalfOf.email ? { email: onBehalfOf.email } : {}), ...(onBehalfOf.name ? { label: onBehalfOf.name } : {}) }
        : usageTriggerFor(auth);
      // The spend cap and a task that is gone answer before a malformed
      // sendId or reply target does. acceptDirectSend checks both again for
      // callers that do not come through this route; nothing awaits between.
      const refused = directSendRefusal(bot.id, threadId);
      if (refused) return json(res, refused.status, refused.body);
      const sendId = parseSendId(body.sendId);
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      const dataContext = parseDataContext(body.dataContext);
      const sender = messageSender(auth);
      const guardedStart = guarded
        ? async (currentAtStart: BotRecord): Promise<DirectSendReceipt> => {
            // There is no await between these checks and startTurn's
            // synchronous transcript append / runtime reservation. In
            // particular, never steer or enqueue under stale permissions.
            const expectedMode = body.expectedApprovalMode ?? "ask";
            if (approvalModeFor(currentAtStart) !== expectedMode ||
                (expectedMode === "ask" && (currentAtStart.autoApprove === true || currentAtStart.alwaysAllow?.length))) {
              throw Object.assign(new Error("guarded sends require the exact expected approval mode; Ask cannot have remembered permissions"), { status: 409, code: "guarded_permissions" });
            }
            if (store.activeLeaf(threadId) !== body.expectedActiveLeafId) {
              throw Object.assign(new Error("the conversation changed before this message could start"), { status: 409, code: "guarded_branch" });
            }
            const guardedAdmission = admit("guarded", {}, {
              botBusy: currentAtStart.busy,
              threadBusy: threadBusy(bot.id, threadId),
              atCapacity: botAtThreadCapacity(bot.id),
              parksBehindCoordination: parksBehindCoordination(bot.id, threadId),
              groupTurn: Boolean(activeGroupTurnForBot(bot.id)),
            });
            if (guardedAdmission.action === "refuse") {
              throw Object.assign(new Error("wait for a free thread slot before retrying this message"), { status: 409, code: "guarded_busy" });
            }
            // Stored as relayed: a worker's line for someone else, which a
            // Live call on this thread must not read back as typed there.
            const message = await startTurn(bot.id, text, { threadId, replyTo, sendId, sender, trigger, relayed: true, dataContext });
            return { ok: true as const, threadId, message };
          }
        : undefined;
      try {
        const receipt = await acceptDirectSend({
          botId: bot.id, threadId, text, sendId, replyTo, sender, trigger, dataContext,
          // A person steering a webhook turn is present, and auto mode may
          // follow them again. But this route is also reachable from the
          // bot's own shell on a headless server (loopback is the owner
          // there), and "continue" typed by the turn itself must not be the
          // thing that lifts the block written against it — so only a
          // request that proves a person (a paired session, or the desktop's
          // owner capability, which every mutation there has already shown)
          // clears the mark.
          personPresent: auth.kind === "session" || DESKTOP_MANAGED,
        }, guardedStart);
        return json(res, 202, receipt);
      } catch (error) {
        if (error instanceof DirectSendRefused) return json(res, error.status, error.body);
        throw error;
      }
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      const queueId = m[2];
      if (!cancelSteeredMessage(bot.id, queueId, bot.threadId)) {
        return json(res, 404, { error: "no such queued message" });
      }
      return json(res, 200, { ok: true });
    }

    // Steer a queued message into the RUNNING turn (no interrupt). Engines
    // without a live steer keep the queue; this never ends the current turn.
    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)\/steer$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      // Pressing Steer folds the queued words into the running turn. It does
      // not re-book that turn to whoever pressed it, and the words keep the
      // sender they were queued with.
      // Lift the whole queue atomically: a settle racing this request can
      // drain it as a follow-up, or this request can steer it into the live
      // turn — never both for the same words.
      const held = holdSteeredQueue(bot.id, bot.threadId, m[2]);
      if (!held) return json(res, 404, { error: "no such queued message" });
      const currentAtStart = store.projectBotForTask(bot.id, bot.threadId);
      const instance = currentAtStart?.busy ? runningTurnInstance(currentAtStart, bot.threadId) : undefined;
      const engineCanSteer = Boolean(currentAtStart?.busy && instance?.adapter.capabilities.queueing && instance.adapter.steer);
      // Attachments steer only into an engine that takes images mid-turn
      // (steerImages), resolved from each prompt exactly as the drained
      // follow-up would. Elsewhere attachment words wait for a real turn
      // where central admission can hand the images to the engine.
      const steerInput = extractSteerImages(held.items.map((item) => item.prompt));
      const steerAdmission = admit("direct-busy", {
        carriesImages: !steerInput || steerInput.images.length > 0,
        engineCanSteerImages: Boolean(steerInput) && engineSteersImages(instance),
        engineCanSteer,
      });
      if (steerAdmission.action === "queue" && steerAdmission.blockedBy) {
        restoreHeldSteeredQueue(held);
        return json(res, 200, { ok: true, queued: true, threadId: bot.threadId, blockedBy: steerAdmission.blockedBy });
      }
      const prompt = (steerInput?.texts ?? held.items.map((item) => item.prompt)).join("\n\n");
      const images = steerInput?.images ?? [];
      const steerTarget = handoffs.current(bot.threadId);
      let steered: SteerOutcome = "refused";
      if (steerAdmission.action === "steer" && instance?.adapter.steer) {
        steered = await (images.length > 0
          ? instance.adapter.steer(bot.threadId, prompt, images)
          : instance.adapter.steer(bot.threadId, prompt))
          .catch((): SteerOutcome => "indeterminate");
      }
      // The steer was awaited adapter work: re-read every ownership
      // invariant before writing anything, exactly like the live-send path.
      const current = store.projectBotForTask(bot.id, bot.threadId);
      // "indeterminate" never restores: the words may already be folded into
      // the turn that was live when they were sent, and replaying them into
      // a fresh follow-up turn would run them twice. Record them whenever
      // the destination still exists, busy or not.
      if (
        (steered === "steered" && current?.busy ||
          steered === "indeterminate" && current) &&
        store.taskByThread(bot.id, bot.threadId)
      ) {
        if (auth.kind === "session" || DESKTOP_MANAGED) clearUnattended(bot.threadId);
        const messages = held.items.map((item) => store.appendMessage(bot.threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          ...(item.dataContext ? { dataContext: item.dataContext } : {}),
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          steered: true,
          sender: item.sender,
          ...spokenLineFields(item.via, item.callId),
        }));
        // Words a person queued are written here once steered in, as once a
        // drained turn starts with them (startTurn); a bot's own never are.
        const asked = messages.filter((_, index) => !held.items[index]?.unattended && !held.items[index]?.peerAsk).at(-1);
        if (asked) store.setTaskAskedAt(bot.id, bot.threadId, asked.at);
        // Offered to the next turn again unless the person stops this one.
        for (const message of messages) handoffs.steered(bot.threadId, steerTarget, instance?.instanceId, message.id);
        const queueIds = held.items.map((item) => item.messageId);
        settleHeldSteeredQueue(held);
        return json(res, 200, { ok: true, steered: true, threadId: bot.threadId, messages, queueIds });
      }
      if (steered === "indeterminate") {
        // No destination is left: settle so a restart cannot replay words a
        // dead turn may already have run.
        settleHeldSteeredQueue(held);
        if (!store.taskByThread(bot.id, bot.threadId)) {
          throw Object.assign(new Error("the target task no longer exists"), { status: 409 });
        }
        throw Object.assign(new Error("no such bot"), { status: 404 });
      }
      restoreHeldSteeredQueue(held);
      // The turn may have settled while the steer was refused; a queue that
      // is now drainable must not strand behind a missed settle.
      if (current && !current.busy) drainQueuedSends();
      return json(res, 200, { ok: true, queued: true, threadId: bot.threadId });
    }

    // Compaction shares normal turn admission and Stop, but never executes
    // an agent turn or provisions a computer. It preserves the full history.
    m = path.match(/^\/api\/bots\/([\w-]+)\/compact$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId);
      const notYours = cloudThreadRefusal(auth, bot.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      await startTurn(bot.id, "Summarize conversation context", {
        threadId: bot.threadId, compactOnly: true, cardContinuation: true, trigger: usageTriggerFor(auth),
      });
      return json(res, 202, { ok: true, threadId: bot.threadId });
    }

    // edit a user message → fork the conversation there and rerun the turn.
    // Rewinding a live thread is refused, exactly like switching versions
    // below: interrupting mid-flight and branching under the dying turn is
    // how a conversation ends up with two tails. Stop, then edit.
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
    if (m && method === "POST") {
      const messageId = m[2];
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId);
      const notYours = cloudThreadRefusal(auth, bot.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const threadMessages = store.messagesFor(bot.threadId);
      const source = threadMessages.find((msg) => msg.id === messageId);
      if (!source || source.role !== "user" || source.kind !== "text") {
        return json(res, 404, { error: "only user messages can be edited" });
      }
      // The client's id for this edit. A retry of an edit the server already
      // forked answers with that fork instead of forking (and rerunning) again.
      // Checked before the busy guard: that fork's own turn is what is busy.
      const sendId = parseSendId(body.sendId);
      if (sendId) {
        const accepted = acceptedSendMatch(threadMessages, sendId, text, source.replyToId);
        if (accepted.kind === "conflict" || (accepted.kind === "match" && (accepted.message.parentId ?? null) !== (source.parentId ?? null))) {
          return json(res, 409, { error: "sendId already belongs to another message" });
        }
        if (accepted.kind === "match") return json(res, 202, { ok: true, message: accepted.message });
      }
      // everything from here down is synchronous, so two racing edits can
      // never both get past this check: startTurn flips busy before the
      // next request is handled
      if (threadBusy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before editing" });
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      // A thread's own model that can't run gives way to the bot's when the
      // rerun starts (healThreadModel), so check the model it will run on.
      const rerunSelection = turnSelection(bot.id, bot.threadId) ?? bot.modelSelection;
      if (!registry.get(rerunSelection.instanceId)) {
        return json(res, 409, {
          error: `provider instance "${rerunSelection.instanceId}" is unavailable — pick another model in settings`,
        });
      }
      const rerunInstance = registry.get(rerunSelection.instanceId)!;
      const rerunRefusal = policyModelRefusal(rerunInstance);
      if (rerunRefusal) return json(res, 409, { error: rerunRefusal });
      // startTurn admits the rerun before branching. A shared-resource or
      // concurrency-limit refusal must leave the original transcript intact.
      const replyTo = source.replyToId ? resolveReplyTarget(bot.threadId, source.replyToId) : undefined;
      // Regenerate resends the same words: the rerun gets the Data context
      // the message was sent with, so the model sees what it saw. Changed
      // words take the context the client sends now, if any.
      const dataContext = parseDataContext(body.dataContext) ?? (text === source.text ? source.dataContext : undefined);
      // On a Cloud home an edit is its author's line, so the owner's own edit
      // keeps their conversation theirs for lending (server/cloud-lending.ts).
      const message = await startTurn(bot.id, text, { threadId: bot.threadId, editedMessageId: messageId, replyTo, sendId, trigger: usageTriggerFor(auth), dataContext,
        ...(CLOUD_HOME ? { sender: messageSender(auth) } : {}) });
      return json(res, 202, { ok: true, message });
    }

    // switch which fork of the conversation is visible (no new turn)
    m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId);
      const notYours = cloudThreadRefusal(auth, bot.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      if (threadBusy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before switching versions" });
      if (phoneSecretSubmissions.hasThread(bot.threadId)) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) return json(res, 404, { error: "no such message" });
      // provider sessions still hold the other branch — next turn replays
      store.patchTask(bot.id, bot.threadId, { rewound: true });
      return json(res, 200, { activeLeafId: leaf });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const selected = requestedTaskBot(m[1], body.threadId);
      const bot = botForThread(selected.id, selected.threadId)!;
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      const refusal = cardAnswerRefusal(auth, bot.threadId, String(body.requestId), behavior);
      if (refusal) return json(res, 403, { error: refusal });
      if (body.rememberCommand === true) {
        const refusal = commandRememberRefusal(auth, bot.threadId, String(body.requestId), behavior);
        if (refusal) return json(res, 403, { error: refusal });
      }
      return await answeringCardAs(auth, bot.threadId, String(body.requestId), async () => {
        if (resolveAndSendTrust(res, bot.threadId, String(body.requestId), behavior)) return;
        if (await resolveAndSendTeamSetup(res, {
          botId: bot.id, threadId: bot.threadId, requestId: String(body.requestId), behavior,
        }, auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy || activeGroupTurnForBot(bot.id)) : auth.scopes.includes("admin"))) return;
        if (resolveAndSendRoutine(res, {
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          requestId: String(body.requestId),
          behavior,
        }, auth.kind === "session" && cloudOwnerSession(auth))) return;
        if (resolveAndSendProfile(res, {
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          requestId: String(body.requestId),
          behavior,
        })) return;
        if (resolveAndSendModel(res, {
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          requestId: String(body.requestId),
          behavior,
        })) return;
        if (sendSkillResolution(res, resolveSkillRequest({
          botId: bot.id,
          botName: bot.name,
          threadId: bot.threadId,
          requestId: String(body.requestId),
          behavior,
          reviewedSha256,
        }))) return;
        // peer-approval intercept: harness-native cards carry a requestId
        // that lives in peer-approval's pending map. Resolve them here so
        // the provider adapter never sees a request it didn't raise.
        if (store.messagesFor(bot.threadId).some((message) => message.card?.requestId === String(body.requestId)) &&
          resolvePeerComms(approvalBus, String(body.requestId), behavior)) {
          return json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
        }
        const requestId = String(body.requestId);
        const pending = store.messagesFor(bot.threadId).find((message) => message.card?.requestId === requestId);
        if (isPersistentQuestionCard(pending?.card) && (body.dismiss === true || body.message === QUESTION_DISMISS_MESSAGE)) {
          if (!pending?.card) return json(res, 404, { error: "this question is no longer available" });
          if (pending.card.answered !== "answer" || pending.card.dismissed) {
            return json(res, 409, { error: "answer this question before dismissing it" });
          }
          store.patchMessage(bot.threadId, pending.id, { card: { ...pending.card, dismissed: true } });
          return json(res, 200, { ok: true, dismissed: true });
        }
        const outcome = await answerRequest(bot.threadId, bot.modelSelection.instanceId, requestId, behavior, body.message, { id: bot.id, name: bot.name }, body.always === true, body.rememberCommand === true);
        if (outcome === "unavailable" && isPersistentQuestionCard(pending?.card) && behavior === "answer") {
          if (!pending) return json(res, 404, { error: "this question is no longer available" });
          const answer = typeof body.message === "string" ? body.message.trim() : "";
          if (!answer) return json(res, 400, { error: "a question answer is required" });
          try {
            const reply = await deliverLateQuestionAnswer(auth, bot.threadId, requestId, answer, pending, bot);
            return json(res, 200, { ok: true, outcome: "answered", late: true, ...(reply.queued ? { queued: true } : {}) });
          } catch (error) {
            return json(res, 409, { error: error instanceof Error ? error.message : "the late answer could not be queued" });
          }
        }
        return json(res, 200, { ok: true, outcome });
      });
    }
    // Answer by THREAD, so a request raised inside a room can be answered
    // too: a member's turn runs on the room's thread, and the bot that
    // owns the pending request is the one currently speaking there.
    m = path.match(/^\/api\/threads\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const threadId = m[1];
      const body = await readBody(req);
      const behavior = requestBehavior(body.behavior);
      const reviewedSha256 = typeof body.reviewedSha256 === "string" ? body.reviewedSha256 : undefined;
      if (!behavior) return json(res, 400, { error: "behavior must be allow, deny, or answer" });
      const requestId = String(body.requestId);
      const refusal = cardAnswerRefusal(auth, threadId, requestId, behavior);
      if (refusal) return json(res, 403, { error: refusal });
      if (body.rememberCommand === true) {
        const refusal = commandRememberRefusal(auth, threadId, requestId, behavior);
        if (refusal) return json(res, 403, { error: refusal });
      }
      return await answeringCardAs(auth, threadId, requestId, async () => {
        if (resolveAndSendTrust(res, threadId, requestId, behavior)) return;
        const skillCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.skillRequest,
        );
        if (skillCard?.card?.skillRequest) {
          const skillBotId = skillCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!skillBotId) return json(res, 400, { error: "this skill request has no valid owner" });
          const skillOwner = store.bot(skillBotId);
          if (sendSkillResolution(res, resolveSkillRequest({
            botId: skillBotId,
            botName: skillOwner?.name,
            threadId,
            requestId,
            behavior,
            reviewedSha256,
          }))) return;
        }
        const routineCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.routineRequest,
        );
        if (routineCard?.card?.routineRequest) {
          // Derive the owner from the conversation, not from the executable
          // payload being authorized. Room cards carry their trusted sender;
          // one-to-one tasks resolve through the store's thread ownership.
          const routineBotId = routineCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!routineBotId) return json(res, 400, { error: "this routine request has no valid owner" });
          const routineOwner = store.bot(routineBotId);
          if (resolveAndSendRoutine(res, {
            botId: routineBotId,
            botName: routineOwner?.name,
            threadId,
            requestId,
            behavior,
          }, auth.kind === "session" && cloudOwnerSession(auth))) return;
        }
        const setupCard = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.teamSetupRequest);
        if (setupCard) {
          const setupBotId = setupCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!setupBotId) return json(res, 400, { error: "This team setup has no valid owner" });
          if (await resolveAndSendTeamSetup(res, { botId: setupBotId, threadId, requestId, behavior },
            auth.kind === "loopback" ? DESKTOP_MANAGED || Boolean(req.headers.origin) && !store.bots.some((bot) => bot.busy || activeGroupTurnForBot(bot.id)) : auth.scopes.includes("admin"))) return;
        }
        const profileCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.profileRequest,
        );
        if (profileCard?.card?.profileRequest) {
          const profileBotId = profileCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!profileBotId) return json(res, 400, { error: "this profile request has no valid owner" });
          const profileOwner = store.bot(profileBotId);
          if (resolveAndSendProfile(res, {
            botId: profileBotId,
            botName: profileOwner?.name,
            threadId,
            requestId,
            behavior,
          })) return;
        }
        const modelCard = store.messagesFor(threadId).find(
          (message) => message.card?.requestId === requestId && message.card.modelRequest,
        );
        if (modelCard?.card?.modelRequest) {
          const modelBotId = modelCard.from?.botId ?? store.botByThread(threadId)?.id;
          if (!modelBotId) return json(res, 400, { error: "this model request has no valid owner" });
          const modelOwner = store.bot(modelBotId);
          if (resolveAndSendModel(res, {
            botId: modelBotId,
            botName: modelOwner?.name,
            threadId,
            requestId,
            behavior,
          })) return;
        }
        // peer-approval intercept (see /api/bots/:id/respond above). A peer card
        // belongs to the bus rather than to a speaker, so resolve it before we go
        // looking for one — a room between turns has no speaker to find.
        if (store.messagesFor(threadId).some((message) => message.card?.requestId === requestId) &&
          resolvePeerComms(approvalBus, requestId, behavior)) {
          return json(res, 200, { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" });
        }
        const group = store.groupByThread(threadId);
        // busyBotId is in-memory only, so an approval that outlives its turn — or
        // the process — leaves a durable card with no speaker behind it. Fall back
        // to the member that raised it, and answer even when that member is gone:
        // answerRequest closes an unreachable card, and a pending approval owns
        // the composer, so a dead end here locks the room for good.
        const pending = store.messagesFor(threadId).find((message) => message.card?.requestId === requestId);
        if (isPersistentQuestionCard(pending?.card) && (body.dismiss === true || body.message === QUESTION_DISMISS_MESSAGE)) {
          if (!pending?.card) return json(res, 404, { error: "this question is no longer available" });
          if (pending.card.answered !== "answer" || pending.card.dismissed) {
            return json(res, 409, { error: "answer this question before dismissing it" });
          }
          store.patchMessage(threadId, pending.id, { card: { ...pending.card, dismissed: true } });
          return json(res, 200, { ok: true, dismissed: true });
        }
        const persistentQuestion = isPersistentQuestionCard(pending?.card);
        const owner = group
          ? persistentQuestion
            ? (pending?.from ? store.bot(pending.from.botId) : undefined)
            // This thread's speaker: another thread's member may be the
            // room's newest speaker while this card waits.
            : (groupSpeakers.get(threadId) ? store.bot(groupSpeakers.get(threadId)!.botId) : undefined) ??
              (pending?.from ? store.bot(pending.from.botId) : undefined)
          : store.botByThread(threadId);
        // A surviving question belongs to its original asker, never a later speaker.
        if (group && persistentQuestion && !owner) {
          return json(res, 409, { error: "the bot that asked this question is no longer available" });
        }
        if (!owner && !pending) return json(res, 404, { error: "nothing is waiting on an answer in this conversation" });
        const requestOwner = owner ? botForThread(owner.id, threadId) : null;
        const outcome = await answerRequest(threadId, requestOwner?.modelSelection.instanceId ?? "", requestId, behavior, body.message, owner ? { id: owner.id, name: owner.name } : undefined, body.always === true, body.rememberCommand === true);
        if (outcome === "unavailable" && isPersistentQuestionCard(pending?.card) && behavior === "answer") {
          if (!pending?.card) return json(res, 404, { error: "this question is no longer available" });
          const answer = typeof body.message === "string" ? body.message.trim() : "";
          if (!answer) return json(res, 400, { error: "a question answer is required" });
          if (!owner) return json(res, 409, { error: "the bot that asked this question is no longer available" });
          try {
            const reply = await deliverLateQuestionAnswer(auth, threadId, requestId, answer, pending, owner);
            return json(res, 200, { ok: true, outcome: "answered", late: true, ...(reply.queued ? { queued: true } : {}) });
          } catch (error) {
            return json(res, 409, { error: error instanceof Error ? error.message : "the late answer could not be queued" });
          }
        }
        return json(res, 200, { ok: true, outcome });
      });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const body = rawBody ?? {};
      requirePinnedClientThread(bot.id, body.threadId);
      const expectedThreadId = body.threadId;
      if (expectedThreadId !== undefined && (typeof expectedThreadId !== "string" || !/^[\w-]+$/.test(expectedThreadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      // Explicit thread targets never fall through to another routine or
      // channel just because it belongs to the same bot.
      if (typeof expectedThreadId === "string" && store.taskByThread(bot.id, expectedThreadId)) {
        const routine = routines!.activeBotRunForBot(bot.id);
        if (routine?.threadId === expectedThreadId) await routines!.cancelRun(routine.id);
        else {
          handoffs.stoppedByPerson(expectedThreadId);
          await interruptDirectThread(bot.id, expectedThreadId);
        }
        return json(res, 200, { ok: true });
      }
      const directClaim = directTurnDispatchClaims.get(bot.threadId);
      const routineRun = routines!.activeBotRunForBot(bot.id);
      if (routineRun) {
        if (expectedThreadId !== undefined && routineRun.threadId !== expectedThreadId) {
          return json(res, 409, { error: "this bot is running a routine in another conversation" });
        }
        cancelDirectTurnDispatch(bot.id, routineRun.threadId ?? expectedThreadId);
        if (routineRun.threadId) {
          revokeInternalCapabilitiesForThread(routineRun.threadId);
        }
        await routines!.cancelRun(routineRun.id);
        return json(res, 200, { ok: true });
      }
      const instance = registry.get((botForThread(bot.id, expectedThreadId ?? bot.threadId) ?? bot).modelSelection.instanceId);
      // a bot busy in a ROOM is running on the room's thread — stopping it
      // from its own chat must reach that turn, not just the 1:1 thread
      const busyGroup = activeGroupTurnForBot(bot.id);
      if (busyGroup) {
        if (expectedThreadId !== undefined && busyGroup.threadId !== expectedThreadId) {
          return json(res, 409, { error: `this bot is working in channel ${busyGroup.group.name}` });
        }
        cancelGroupTurnOperations(busyGroup.group.id, busyGroup.threadId);
        revokeInternalCapabilitiesForThread(busyGroup.threadId);
        await instance?.adapter.interruptTurn(busyGroup.threadId).catch(() => {});
        closeOpenApprovals(busyGroup.threadId);
        return json(res, 200, { ok: true });
      }
      if (
        expectedThreadId !== undefined &&
        !busyGroup &&
        bot.threadId !== expectedThreadId &&
        directClaim?.threadId !== expectedThreadId
      ) {
        return json(res, 409, { error: "the bot switched tasks before it could be interrupted" });
      }
      handoffs.stoppedByPerson(expectedThreadId ?? bot.threadId);
      await interruptDirectThread(bot.id, expectedThreadId ?? bot.threadId);
      return json(res, 200, { ok: true });
    }
    return PASS;
  };
}
