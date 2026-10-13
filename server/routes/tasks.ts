// A bot's conversations: its folders (projects), and its tasks — open one,
// switch to one, change its settings (title, folder, model, approval level,
// pin, archive, snooze, surface, link), delete one, and name one again
// from its conversation. Moved from server/index.ts's inline routes into
// the route table (server/routes/README.md); the table runs after the auth
// gate, scope rules stay keyed by path in server/request-auth.ts.
import { approvalModeFor, isApprovalMode, type ApprovalMode } from "../../shared/approval-mode.ts";
import { threadLinkUrl } from "../../shared/thread-link.ts";
import type { WireBot, WireTask } from "../../shared/wire.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import type { ModelSelection, ProviderInstance } from "../contracts.ts";
import type { Coordinator } from "../coordinator.ts";
import type { Handoffs } from "../delta-context.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import type { SkillReview } from "../skill-review.ts";
import { isProjectEmoji, type BotRecord, type Store, type TaskRecord } from "../store.ts";
import { parseSurface } from "../surface.ts";
import type { ThreadStarters } from "../thread-starters.ts";
import { titleConversationExcerpt, type ThreadTitleSource } from "../thread-title.ts";
import type { MessagePage } from "./channels.ts";
import { PASS, type RouteHandler } from "./table.ts";

type HostedModels = NonNullable<ReturnType<typeof hostedModelPolicy>>;

export interface TaskRouteDeps {
  store: Pick<Store,
    | "bot" | "bots" | "taskByThread" | "project" | "projectBotForTask" | "patchTask" | "patchProject" | "tasks"
    | "switchTaskModel" | "switchTask" | "retitleTask" | "reorderProjects" | "refreshTaskPermissions" | "messagesTail"
    | "messagesFor" | "deleteTask" | "deleteProject" | "createTask" | "createProject">;
  /** On a Cloud home only the owner changes how a bot asks for approval. */
  cloudHome: boolean;
  /** The desktop app owns this server, so a loopback caller is its owner. */
  desktopManaged: boolean;
  /** A shared company workspace: Full access comes only from its operator. */
  hostedWorkspace: boolean;
  hostedFullAccessRefusal: string;
  /** Company model policy on a hosted workspace, absent elsewhere. */
  hostedModels: Pick<HostedModels, "resetTask"> | null;
  /** Assigned at boot, after the routes are built, so it is read per request. */
  routines(): Pick<RoutineManager, "isActiveThread"> | null;
  coordinator: Pick<Coordinator, "cancelDirect">;
  handoffs: Pick<Handoffs, "forget">;
  skillReview: Pick<SkillReview, "dropThread">;
  threadStarters: Pick<ThreadStarters, "set">;
  phoneSecretSubmissions: Pick<PhoneSecretSubmissionRegistry, "hasBot" | "hasThread">;
  /** Threads whose title is being generated right now. */
  titleRegenerations: Pick<Set<string>, "has" | "add" | "delete">;
  /** The direct-turn generation per thread, read here only. */
  directTurnGenerationByThread: ReadonlyMap<string, string>;
  actorKey(auth: RequestAuth & { kind: "session" }): string;
  cloudOwnerSession(auth: RequestAuth): boolean;
  cloudThreadRefusal(auth: RequestAuth, threadId: string): string | null;
  sharedWorkspaceFullAccessEnabled(): boolean;
  supportsApprovalMode(selection: ModelSelection, mode: ApprovalMode): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  publicBot(bot: BotRecord): WireBot;
  wireBot(bot: BotRecord): WireBot;
  wireTask(task: TaskRecord, botModel: ModelSelection): WireTask;
  pageSize(raw: string | null): number | null | undefined;
  messagePage(threadId: string, limit: number | undefined): MessagePage;
  checkedModelSelection(raw: unknown, current?: { selection: ModelSelection; busy: boolean }, requireAvailableModel?: boolean):
    | { ok: true; selection: ModelSelection }
    | { ok: false; status: number; error: string };
  checkedTaskModelSwitch(current: BotRecord, raw: unknown, updateBotDefault: boolean, resetApprovalToAsk: boolean, requireAvailableModel?: boolean):
    | { ok: true }
    | { ok: false; status: number; error: string };
  threadTitleGate(bot: Pick<BotRecord, "modelSelection">): { ok: true; instance: ProviderInstance } | { ok: false; refusal: string };
  generateThreadTitle(provider: ProviderInstance, text: string, source: ThreadTitleSource): Promise<string | null>;
  settleDirectFollowup(generation: string | undefined): void;
  clearTurnDigestState(threadId: string): void;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  stagedSkillCleanupsForThread(threadId: string): Array<{ botId: string; stagedId: string }>;
  rejectDeletedThreadSkillStages(cleanups: Array<{ botId: string; stagedId: string }>): void;
}

export function createTaskRoutes(deps: TaskRouteDeps): RouteHandler {
  const {
    store, hostedModels, coordinator, handoffs, skillReview, threadStarters, phoneSecretSubmissions, titleRegenerations,
    directTurnGenerationByThread, actorKey, cloudOwnerSession, cloudThreadRefusal, sharedWorkspaceFullAccessEnabled,
    supportsApprovalMode, threadBusy, publicBot, wireBot, wireTask, pageSize, messagePage, checkedModelSelection,
    checkedTaskModelSwitch, threadTitleGate, generateThreadTitle, settleDirectFollowup, clearTurnDigestState,
    revokeInternalCapabilitiesForThread, stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages,
  } = deps;
  const CLOUD_HOME = deps.cloudHome;
  const DESKTOP_MANAGED = deps.desktopManaged;
  const HOSTED_WORKSPACE = deps.hostedWorkspace;
  const HOSTED_FULL_ACCESS_REFUSAL = deps.hostedFullAccessRefusal;
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();
    // ── tasks: a bot's separate contexts ────────────────────────────────
    // Replies carry the open thread's newest page: a create or delete can
    // change which transcript is live. The frames come from store.onChange.

    // Folders organize one bot's threads; they never own settings,
    // transcripts or working directories. The project wire names stay stable.
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects\/order$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "projectIds") ||
        !Array.isArray(body.projectIds) || body.projectIds.some((id: unknown) => typeof id !== "string")) {
        return json(res, 400, { error: "projectIds must be an array of folder IDs" });
      }
      const projects = store.reorderProjects(bot.id, body.projectIds);
      if (!projects) return json(res, 400, { error: "projectIds must include each of this bot's folders exactly once" });
      return json(res, 200, { projects, bot: publicBot(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects(?:\/([\w-]+))?$/);
    if (m && ((method === "POST" && !m[2]) || (method === "PATCH" && m[2]) || (method === "DELETE" && m[2]))) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (m[2] && !store.project(bot.id, m[2])) return json(res, 404, { error: "no such folder" });
      if (method === "DELETE") {
        const updated = store.deleteProject(bot.id, m[2]!);
        return json(res, 200, { bot: publicBot(updated!) });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      if (Object.keys(body).some((key) => key !== "name" && key !== "emoji")) {
        return json(res, 400, { error: "unsupported folder setting" });
      }
      if ((method === "POST" || body.name !== undefined) &&
        (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)) {
        return json(res, 400, { error: "folder name must be between 1 and 80 characters" });
      }
      if (body.emoji !== undefined && body.emoji !== null && !isProjectEmoji(body.emoji)) {
        return json(res, 400, { error: "folder emoji must be one emoji, or null to reset it" });
      }
      const patch: Parameters<typeof store.patchProject>[2] = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.emoji !== undefined) patch.emoji = body.emoji;
      const project = method === "POST"
        ? store.createProject(bot.id, patch.name!, patch.emoji)
        : store.patchProject(bot.id, m[2]!, patch);
      return json(res, method === "POST" ? 201 : 200, { project, bot: publicBot(bot) });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      let cwd: string | undefined;
      if (body.cwd !== undefined) {
        // Opening a conversation is client-scoped, choosing where its file
        // tools run has the same authority as editing the bot's folder.
        if (!auth.scopes.includes("admin")) {
          return json(res, 403, { error: "Choosing a working folder requires the admin scope" });
        }
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        if (!checked.cwd) return json(res, 400, { error: "Choose an existing working folder, or omit cwd to use the bot's default" });
        cwd = checked.cwd;
      }
      if (body.approvalMode !== undefined && body.approvalMode !== "ask" && body.approvalMode !== "full") {
        return json(res, 400, { error: "new task approvalMode must be ask or full" });
      }
      if (body.approvalMode === "full") {
        if (auth.kind !== "loopback" || !sharedWorkspaceFullAccessEnabled()) {
          return json(res, 403, { error: "New Full tasks require the operator's dedicated shared-workspace policy" });
        }
        if (bot.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        if (!supportsApprovalMode(bot.modelSelection, "full")) {
          return json(res, 400, { error: "This provider does not support Full access" });
        }
      }
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        return json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
      }
      if (body.projectId !== undefined && (typeof body.projectId !== "string" || !store.project(bot.id, body.projectId))) {
        return json(res, 400, { error: "projectId must belong to this bot" });
      }
      const task = store.createTask(bot.id, typeof body.title === "string" ? body.title : undefined, true, body.projectId, undefined, body.approvalMode, undefined, cwd);
      if (!task) return json(res, 500, { error: "couldn't create that task" });
      // Who opened it decides who may answer its cards on a shared workspace.
      if (auth.kind === "session") threadStarters.set(task.threadId, actorKey(auth));
      return json(res, 201, { bot: publicBot(store.bot(bot.id)!), task: wireTask(task, store.bot(bot.id)!.modelSelection) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        return json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
      }
      // Navigation only: execution owns its thread, never this selected id.
      const requestedMessages = url.searchParams.get("messages");
      const switchLimit = pageSize(requestedMessages);
      if (switchLimit === null) return json(res, 400, { error: "messages must be a non-negative whole number" });
      const switched = store.switchTask(bot.id, m[2]);
      if (!switched) return json(res, 404, { error: "no such task" });
      const switchedSettings = { ...wireBot(switched), tasks: store.tasks(switched.id).map((task) => wireTask(task, switched.modelSelection)) };
      // "0" is settings only, a positive page is a bounded transcript, and no
      // parameter is the whole thread — the one branch that materialises it.
      // Search results land through that branch (src/lib/focus-message.ts):
      // the hit can be older than one page.
      const responseBot = requestedMessages === "0"
        ? switchedSettings
        : { ...switchedSettings, ...messagePage(switched.threadId, switchLimit) };
      return json(res, 200, { bot: responseBot });
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      const current = store.projectBotForTask(m[1], m[2]);
      if (!current) return json(res, 404, { error: "no such task" });
      const allowed = new Set(["title", "projectId", "modelSelection", "updateBotDefault", "resetApprovalToAsk", "approvalMode", "autoApprove", "requireAvailableModel", "pinnedMessageId", "acknowledgeLocalAuto", "archivedAt", "pinned", "snoozedUntil", "surface", "refreshPermissions", "link"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) return json(res, 400, { error: "unsupported thread setting" });
      const notYours = cloudThreadRefusal(auth, m[2]);
      if (notYours) return json(res, 403, { error: notYours });
      // On a Cloud home only the owner decides whether a bot may act without
      // asking them, even in a conversation someone else started, and what
      // the bot itself defaults to.
      if (CLOUD_HOME && !cloudOwnerSession(auth) &&
        (body.approvalMode !== undefined || body.autoApprove !== undefined || body.acknowledgeLocalAuto !== undefined || body.updateBotDefault === true || body.refreshPermissions === true)) {
        return json(res, 403, { error: "On this Cloud only its owner can change how a bot asks for approval, or its default model." });
      }
      for (const key of ["requireAvailableModel", "acknowledgeLocalAuto", "updateBotDefault", "resetApprovalToAsk"] as const) {
        if (body[key] !== undefined && typeof body[key] !== "boolean") return json(res, 400, { error: `${key} must be a boolean` });
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      if (body.updateBotDefault === true && body.modelSelection === undefined) return json(res, 400, { error: "updateBotDefault requires modelSelection" });
      if (body.resetApprovalToAsk === true && (body.modelSelection === undefined ||
        (body.approvalMode !== undefined && body.approvalMode !== "ask") || body.autoApprove === true)) {
        return json(res, 400, { error: "resetApprovalToAsk requires a model selection and cannot be combined with another approval mode" });
      }
      if (body.refreshPermissions !== undefined && body.refreshPermissions !== true) {
        return json(res, 400, { error: "refreshPermissions must be true" });
      }
      if (body.refreshPermissions === true) {
        const extra = Object.keys(body).filter((key) => key !== "refreshPermissions" && key !== "acknowledgeLocalAuto");
        if (extra.length) return json(res, 400, { error: "refreshPermissions cannot be combined with other thread settings" });
        const profile = store.bot(m[1]);
        if (!profile) return json(res, 404, { error: "no such bot" });
        if (profile.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        if (threadBusy(profile.id, m[2])) return json(res, 409, { error: "stop this thread before changing its approval mode" });
        const nextMode = approvalModeFor({ ...profile, approvalGrant: undefined });
        // Custom never travels over the bot-reachable HTTP surface: the
        // desktop's private channel copies it, and it is also the only way
        // to leave Custom. Full is copied here like any other level.
        if (nextMode === "custom") {
          return json(res, 403, { error: "Refresh Custom access from the packaged desktop app" });
        }
        if (nextMode === "full" && HOSTED_WORKSPACE && approvalModeFor(current) !== "full") {
          return json(res, 403, { error: HOSTED_FULL_ACCESS_REFUSAL });
        }
        if (approvalModeFor(current) === "custom") {
          return json(res, 403, { error: "Leaving Custom approval requires the packaged desktop app" });
        }
        if (!supportsApprovalMode(current.modelSelection, nextMode)) {
          return json(res, 400, { error: "This provider does not support the selected approval level" });
        }
        if (nextMode === "auto" && current.computer === "local" && approvalModeFor(current) !== "auto" && body.acknowledgeLocalAuto !== true) {
          return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
        }
        const approvalRank = { ask: 0, edits: 1, auto: 2, full: 3, custom: 4 } as const;
        const widensMode = approvalRank[nextMode] > approvalRank[approvalModeFor(current)];
        const nextAllow = profile.alwaysAllow ?? [];
        const widensAllow = nextAllow.some((key) => !(current.alwaysAllow ?? []).includes(key));
        // Full has no OMB-side guard (owner decision, Oct 12), here as on
        // the bot and thread routes; the narrower levels keep this one.
        if (nextMode !== "full" && (widensMode || widensAllow) && auth.kind === "loopback" && !DESKTOP_MANAGED && !req.headers.origin && store.bots.some((bot) => bot.busy)) {
          return json(res, 409, { error: "Change approval mode from the app or a paired device while bots are working." });
        }
        const task = store.refreshTaskPermissions(profile.id, m[2]);
        if (!task) return json(res, 404, { error: "no such task" });
        return json(res, 200, { task: wireTask(task, store.bot(profile.id)!.modelSelection), bot: publicBot(store.bot(profile.id)!) });
      }
      const patch: Parameters<typeof store.patchTask>[2] = {};
      if (body.projectId !== undefined) {
        if (body.projectId === null) patch.projectId = undefined;
        else if (typeof body.projectId === "string" && store.project(current.id, body.projectId)) patch.projectId = body.projectId;
        else return json(res, 400, { error: "projectId must belong to this bot, or null to ungroup the thread" });
      }
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return json(res, 400, { error: "title must be a string" });
        patch.title = body.title;
      }
      if (body.archivedAt !== undefined) {
        if (body.archivedAt === null) patch.archivedAt = undefined;
        else if (typeof body.archivedAt === "number" && Number.isFinite(body.archivedAt) && body.archivedAt >= 0) patch.archivedAt = body.archivedAt;
        else return json(res, 400, { error: "archivedAt must be a timestamp, or null to unarchive" });
      }
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean") return json(res, 400, { error: "pinned must be a boolean" });
        patch.pinned = body.pinned ? true : undefined;
      }
      if (body.snoozedUntil !== undefined) {
        if (body.snoozedUntil === null) patch.snoozedUntil = undefined;
        else if (typeof body.snoozedUntil === "number" && Number.isFinite(body.snoozedUntil) && body.snoozedUntil >= 0) patch.snoozedUntil = body.snoozedUntil;
        else return json(res, 400, { error: "snoozedUntil must be a timestamp, 0 to snooze until activity, or null to wake now" });
      }
      if (body.link !== undefined) {
        const link = body.link === null ? undefined : threadLinkUrl(body.link);
        if (link === null) return json(res, 400, { error: "link must be an http(s) address of at most 2048 characters, or null to remove it" });
        patch.link = link;
        patch.linkAuto = link ? undefined : false;
      }
      if (body.surface !== undefined) {
        if (threadBusy(current.id, current.threadId)) return json(res, 409, { error: "Stop this thread before changing its computer destination." });
        // Where this conversation works, chosen by the person and recorded as
        // theirs, so a later Works on change never sweeps it. Null follows the
        // bot's Works on again. Reachability is the turn's to judge.
        if (body.surface === null) {
          patch.surface = undefined;
          patch.surfaceSource = undefined;
        } else if (parseSurface(body.surface)) {
          patch.surface = parseSurface(body.surface);
          patch.surfaceSource = "user";
        } else return json(res, 400, { error: "surface must be cloud, vm, local, browser, or null to follow the bot" });
      }
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && store.messagesFor(current.threadId).some((message) => message.id === body.pinnedMessageId)) patch.pinnedMessageId = body.pinnedMessageId;
        else return json(res, 400, { error: "pinnedMessageId must belong to this thread" });
      }
      if (body.modelSelection !== undefined) {
        if (current.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        const checked = checkedModelSelection(body.modelSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) }, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        patch.modelSelection = checked.selection;
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        if (body.autoApprove !== undefined && typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be a boolean" });
        const mode: unknown = body.approvalMode ?? (body.autoApprove ? "auto" : "ask");
        if (!isApprovalMode(mode)) return json(res, 400, { error: "approvalMode must be ask, edits, auto, full, or custom" });
        // Full applies here like any other level. Custom still needs the
        // trusted desktop transition: a thread PATCH cannot manufacture it.
        if (mode === "custom") return json(res, 403, { error: "Custom access requires trusted desktop confirmation" });
        if (mode === "full" && HOSTED_WORKSPACE && approvalModeFor(current) !== "full") return json(res, 403, { error: HOSTED_FULL_ACCESS_REFUSAL });
        if (approvalModeFor(current) === "custom") return json(res, 403, { error: "Leaving Custom approval requires confirmation in the packaged desktop app" });
        if (!supportsApprovalMode(patch.modelSelection ?? current.modelSelection, mode)) {
          return json(res, 400, { error: "This provider does not support the selected approval level" });
        }
        if (threadBusy(current.id, current.threadId)) return json(res, 409, { error: "stop this thread before changing its approval mode" });
        if (current.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        if (mode === "auto" && approvalModeFor(current) !== "auto" && auth.kind === "loopback" && !DESKTOP_MANAGED && !req.headers.origin && store.bots.some((bot) => bot.busy)) {
          return json(res, 409, { error: "Change approval mode from the app or a paired device while bots are working." });
        }
        if (mode === "auto" && current.computer === "local" && approvalModeFor(current) !== "auto" && body.acknowledgeLocalAuto !== true) {
          return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
        }
        patch.approvalMode = mode;
        patch.autoApprove = mode === "auto";
      }
      if (patch.modelSelection) {
        const checked = checkedTaskModelSwitch({ ...current,
          ...(patch.approvalMode ? { approvalMode: patch.approvalMode, autoApprove: patch.autoApprove } : {}),
        }, patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
      }
      const task = patch.modelSelection
        ? store.switchTaskModel(m[1], m[2], patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true,
          { ...patch, ...hostedModels?.resetTask(current.modelSelection, patch.modelSelection) })!
        : store.patchTask(m[1], m[2], patch)!;
      return json(res, 200, { task: wireTask(task, store.bot(m[1])!.modelSelection), bot: publicBot(store.bot(m[1])!) });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot || !store.taskByThread(bot.id, m[2])) {
        return json(res, 404, { error: "no such task" });
      }
      const notYours = cloudThreadRefusal(auth, m[2]);
      if (notYours) return json(res, 403, { error: notYours });
      if (phoneSecretSubmissions.hasThread(m[2])) {
        return json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
      }
      if (threadBusy(bot.id, m[2]) || routines!.isActiveThread(m[2])) {
        return json(res, 409, { error: "this task is running — stop it first" });
      }
      const stagedSkillCleanups = stagedSkillCleanupsForThread(m[2]);
      coordinator.cancelDirect(m[2], "The source conversation was deleted");
      const updated = store.deleteTask(m[1], m[2]);
      if (!updated) return json(res, 404, { error: "no such task" });
      clearTurnDigestState(m[2]);
      skillReview.dropThread(m[2]);
      revokeInternalCapabilitiesForThread(m[2]);
      handoffs.forget(m[2]);
      settleDirectFollowup(directTurnGenerationByThread.get(m[2]));
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      return json(res, 200, { bot: publicBot(updated) });
    }
    // Regenerate title (#1858): name the thread again from its conversation
    // as it is now. The person asked, so the result replaces any title, but
    // only the one this started from: a rename that lands while the one-shot
    // runs wins, and the late result is dropped.
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)\/title$/);
    if (m && method === "POST") {
      const current = store.projectBotForTask(m[1], m[2]);
      if (!current) return json(res, 404, { error: "no such task" });
      const notYours = cloudThreadRefusal(auth, m[2]);
      if (notYours) return json(res, 403, { error: notYours });
      const gate = threadTitleGate(current);
      if (!gate.ok) return json(res, 409, { error: gate.refusal });
      if (titleRegenerations.has(m[2])) return json(res, 409, { error: "a new title is already being generated for this thread" });
      const excerpt = titleConversationExcerpt(store.messagesTail(m[2], 200).messages);
      if (!excerpt) return json(res, 409, { error: "this thread has no messages to take a title from yet" });
      const startedFrom = store.taskByThread(m[1], m[2])!.title;
      titleRegenerations.add(m[2]);
      try {
        const title = await generateThreadTitle(gate.instance, excerpt, "conversation");
        if (!title) return json(res, 502, { error: "couldn't generate a title — try again, or rename the thread" });
        const task = store.retitleTask(m[1], m[2], startedFrom, title) ?? store.taskByThread(m[1], m[2]);
        if (!task) return json(res, 404, { error: "no such task" });
        return json(res, 200, { task: wireTask(task, store.bot(m[1])!.modelSelection) });
      } finally {
        titleRegenerations.delete(m[2]);
      }
    }
    return PASS;
  };
}
