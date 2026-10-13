// PATCH /api/bots/:id, the broad settings endpoint the desktop and the team
// dialog use, moved out of server/index.ts's inline routes into the route
// table (server/routes/README.md). The table runs after the auth gate;
// scope rules stay keyed by path in server/request-auth.ts, and a member
// session is held to how a bot looks by clientBotPatchViolation. The
// narrower bot settings routes are in bot-settings.ts, which also lends
// the pinned-thread guard.
import { z } from "zod";

import { approvalModeFor, isApprovalMode, type ApprovalMode } from "../../shared/approval-mode.ts";
import { normalizeConnectorScopes } from "../../shared/connector-scopes.ts";
import { normalizeOutboundPolicy } from "../../shared/outbound.ts";
import { parseToolScope, toolScopeWidens } from "../../shared/tool-scope.ts";
import type { WireBot, WireGroup } from "../../shared/wire.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import { parseVisibility } from "../bot-visibility.ts";
import type { BrowserLive } from "../browser-live.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import type { CacheKeepWarm } from "../cache-keepwarm.ts";
import { cloudBackendChangeError } from "../cloud-backend.ts";
import * as composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { createApprovalModeSupport } from "../harness-capabilities.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import { MAX_MCP_SERVERS, mcpServerNameError } from "../mcp-registry.ts";
import type { MemoryUpkeep } from "../memory-upkeep.ts";
import { profileSnapshot } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import { clientBotPatchViolation, requestSource } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import type { SessionRegistry } from "../sessions.ts";
import { parseConnectorTools, sectionKey, type BotRecord, type GroupRecord, type Store } from "../store.ts";
import { pinnedClientThreadGuard } from "./pinned-client-thread.ts";
import type { ModelSelectionCheck } from "./bots-create.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotPatchRouteDeps {
  store: Store;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get">;
  sessions: Pick<SessionRegistry, "isLive">;
  browserRuntime: Pick<BrowserRuntime, "heldBy">;
  browserLive: Pick<BrowserLive, "closeForBot">;
  memoryUpkeep: Pick<MemoryUpkeep, "dropBot">;
  cacheKeepWarm: Pick<CacheKeepWarm, "refresh">;
  hostedModels: ReturnType<typeof hostedModelPolicy>;
  supportsApprovalMode: ReturnType<typeof createApprovalModeSupport>;
  /** The routine manager, assigned at boot after the routes are built. */
  routines(): RoutineManager | null;
  /** The bots with a VPS turn in flight, by bot id. */
  activeVpsThreads: { has(botId: string): boolean };
  /** A hosted (company) workspace: Full access comes only from its policy. */
  hostedWorkspace: boolean;
  hostedFullAccessRefusal: string;
  /** The packaged desktop is the parent process. */
  desktopManaged: boolean;
  maxWorkspaceBots: number;
  broadcast(payload: Record<string, unknown>): void;
  /** The bot as HTTP replies carry it. */
  wireBot(bot: BotRecord): WireBot;
  /** The room as its members see it. */
  publicGroupState(group: GroupRecord): WireGroup;
  /** A bot's audience changed: members' live streams start over. */
  audienceChanged(): void;
  storedAvatarExists(avatarUrl: string): boolean;
  /** The bot as its selected thread sees it, or a thrown 404. */
  requestedTaskBot(botId: string, rawThreadId: unknown): BotRecord;
  threadBusy(botId: string, threadId: string): boolean;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  checkedModelSelection(raw: unknown, current?: { selection: ModelSelection; busy: boolean }, requireAvailableModel?: boolean): ModelSelectionCheck;
  engineSwitchNeedsAsk(mode: ApprovalMode, from: ModelSelection, to: ModelSelection): boolean;
  /** The browser session a bot uses for a profile (its temporary one for "guest"). */
  currentBrowserSession(botId: string, profile: string | undefined): string;
  interruptAllDirectThreads(botId: string): Promise<void>;
  cancelGroupTurnOperations(groupId: string, threadId: string): void;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  runningTurnInstance(bot: BotRecord | null | undefined, threadId: string): ReturnType<ProviderRegistry["get"]>;
  closeOpenApprovals(threadId: string): void;
  /** Throws when a team-computer change would land mid-turn. */
  assertTeamComputerChangeIdle(before: BotRecord, after: BotRecord): void;
  forgetTemporaryBrowser(botId: string): Promise<void>;
}

export function createBotPatchRoutes(deps: BotPatchRouteDeps): RouteHandler {
  const {
    store, cfg, registry, sessions, browserRuntime, browserLive, memoryUpkeep, cacheKeepWarm, hostedModels, supportsApprovalMode, activeVpsThreads,
    hostedWorkspace: HOSTED_WORKSPACE, hostedFullAccessRefusal: HOSTED_FULL_ACCESS_REFUSAL, desktopManaged: DESKTOP_MANAGED, maxWorkspaceBots: MAX_WORKSPACE_BOTS,
    broadcast, wireBot, publicGroupState, audienceChanged, storedAvatarExists, requestedTaskBot, threadBusy, activeGroupTurnForBot,
    checkedModelSelection, engineSwitchNeedsAsk, currentBrowserSession, interruptAllDirectThreads, cancelGroupTurnOperations,
    revokeInternalCapabilitiesForThread, runningTurnInstance, closeOpenApprovals, assertTeamComputerChangeIdle, forgetTemporaryBrowser,
  } = deps;
  const pinnedClientThread = pinnedClientThreadGuard(store);
  return async ({ req, res, path, method, auth, json, readBody }) => {
    /** scratch for the route match, as index.ts's shared `m` */
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();
    const requirePinnedClientThread = pinnedClientThread(auth, req);
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        const field = clientBotPatchViolation(body);
        if (field) return json(res, 403, { error: `forbidden: this session may change how a bot looks, not "${field}" (needs the admin scope)` });
      }
      const existingBot = store.bot(m[1]);
      const selectedTask = existingBot ? requestedTaskBot(existingBot.id, undefined) : null;
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      const beforeVisibility = existingBot?.visibility;
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
      const beforeBrowserProfile = existingBot?.browserProfile;
      const beforeBrowserEnabled = existingBot?.browser;
      // Neither Codex (free-form string field) nor Grok (lazy, logs-only)
      // rejects an unknown effort level at their own boundary — this is the
      // only real gate, so it stays. But it fires only when the target
      // instance actually resolves. An instance that isn't there declares no
      // levels, and rejecting against that empty list would 400 the *whole*
      // request: this is the app's general-purpose bot endpoint, and
      // duplicateBot re-sends the source bot's entire modelSelection beside
      // its name, title and description, so a source engine that happens to
      // be offline would cost the copy all of them. Letting it through is
      // safe — startTurn refuses to run a turn on an unavailable instance
      // anyway, so an unverifiable level never reaches a CLI.
      const rawSelection = (body as Record<string, unknown>).modelSelection;
      if (rawSelection !== undefined) requirePinnedClientThread(m[1], undefined);
      if (body.keepThreadModels !== undefined) {
        if (typeof body.keepThreadModels !== "boolean") return json(res, 400, { error: "keepThreadModels must be true or false" });
        if (body.keepThreadModels && rawSelection === undefined) return json(res, 400, { error: "keepThreadModels goes with modelSelection" });
      }
      // The thread a new bot model moves besides those that follow the bot.
      // From the bot's own panel that is the selected thread, whatever model
      // it had: it follows the bot from now on, as if picked there (#2401).
      // A bulk change (keepThreadModels: the team dialog) is about the bots,
      // not the thread each one last had open, so a thread with a model of
      // its own keeps it there, selected or not, and only followers move.
      const movedTask = selectedTask && !(body.keepThreadModels === true &&
        store.taskByThread(selectedTask.id, selectedTask.threadId)?.modelSelection !== undefined) ? selectedTask : null;
      if (
        existingBot?.approvalGrant &&
        (rawSelection !== undefined || body.approvalMode !== undefined || body.autoApprove !== undefined)
      ) {
        return json(res, 409, { error: "wait for the approval-level change to finish before changing this setting" });
      }
      if (body.requireAvailableModel === true && rawSelection === undefined) {
        return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      }
      let normalizedSelection: ModelSelection | undefined;
      if (rawSelection !== undefined) {
        const checked = checkedModelSelection(
          rawSelection,
          movedTask ? { selection: movedTask.modelSelection, busy: threadBusy(movedTask.id, movedTask.threadId) } : undefined,
          body.requireAvailableModel === true,
        );
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        normalizedSelection = checked.selection;
        if (existingBot && activeGroupTurnForBot(existingBot.id)) {
          const groupChecked = checkedModelSelection(normalizedSelection, { selection: existingBot.modelSelection, busy: true });
          if (!groupChecked.ok) return json(res, groupChecked.status, { error: groupChecked.error });
        }
      }
      // Persona/profile fields reach prompts and paired clients. Both this
      // broad desktop endpoint and the paired-safe profile endpoint pass
      // through the same validation and clear-value normalization.
      const profile = parseBotProfilePatch(body);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      if (profile.patch.avatarUrl && !storedAvatarExists(profile.patch.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      const patch: Record<string, unknown> = {};
      Object.assign(patch, profile.patch);
      let section: string | undefined | null;
      if (body.section !== undefined) {
        if (body.section === null) section = null;
        else if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        else {
          const trimmed = body.section.trim();
          if (!trimmed) section = null;
          else if (trimmed.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
          else section = trimmed;
        }
      }
      for (const key of ["unread", "cloudBackend", "color", "mascotExpression", "mascotBody", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const computerSpecified = Object.prototype.hasOwnProperty.call(body, "computer");
      let requestedComputer = existingBot?.computer;
      if (computerSpecified) {
        if (body.computer === null) {
          // Auto is represented by an absent durable field. JSON needs a
          // concrete clear value, so clients send null at the PATCH boundary.
          requestedComputer = undefined;
          patch.computer = undefined;
        } else if (
          typeof body.computer === "string" &&
          ["cloud", "vm", "local", "browser", "off"].includes(body.computer)
        ) {
          requestedComputer = body.computer;
          patch.computer = body.computer;
        } else {
          return json(res, 400, { error: "computer must be null (Auto), cloud, vm, local, browser, or off" });
        }
      }
      if (normalizedSelection) patch.modelSelection = normalizedSelection;
      // one pinned message per thread; null/"" clears. The id is not
      // validated against the transcript here — a pin whose message was
      // edited to another branch or deleted simply resolves to nothing.
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && /^[\w-]+$/.test(body.pinnedMessageId)) {
          patch.pinnedMessageId = body.pinnedMessageId;
        } else return json(res, 400, { error: "pinnedMessageId must be a message id" });
      }
      if (section !== undefined) patch.section = section ?? undefined;
      if (body.chiefOfStaff === false) patch.chiefOfStaff = false;
      // where a task carries on when this engine is unavailable, in order
      if (body.fallback !== undefined) {
        if (!Array.isArray(body.fallback) || body.fallback.length > 5) {
          return json(res, 400, { error: "fallback must be a list of up to five { instanceId, model } entries" });
        }
        const chain: Array<{ instanceId: string; model: string }> = [];
        for (const entry of body.fallback as unknown[]) {
          const row = entry && typeof entry === "object" ? (entry as { instanceId?: unknown; model?: unknown }) : null;
          if (!row || typeof row.instanceId !== "string" || !/^[\w.-]+$/.test(row.instanceId) || typeof row.model !== "string" || !row.model.trim() || row.model.length > 500) {
            return json(res, 400, { error: "fallback must be a list of up to five { instanceId, model } entries" });
          }
          if (!registry.get(row.instanceId)) return json(res, 400, { error: `fallback engine "${row.instanceId}" is not available` });
          if (chain.some((seen) => seen.instanceId === row.instanceId)) continue;
          chain.push({ instanceId: row.instanceId, model: row.model.trim() });
        }
        patch.fallback = chain;
      }
      // which connected apps this bot may use; null clears back to all of them
      if (body.connectorScopes !== undefined) {
        if (body.connectorScopes === null) patch.connectorScopes = undefined;
        else {
          const scopes = normalizeConnectorScopes(body.connectorScopes);
          if (!scopes) return json(res, 400, { error: "connectorScopes must be { apps: { <toolkit>: read | write } } or null" });
          patch.connectorScopes = scopes;
        }
      }
      // sending on the person's behalf: ask every time, or a daily allowance
      if (body.outbound !== undefined) {
        const policy = normalizeOutboundPolicy(body.outbound);
        if (!policy) return json(res, 400, { error: "outbound must be { policy: ask | allow, dailyCap: 1..1000 }" });
        patch.outbound = policy;
      }
      // per-bot gate on the workspace's connected apps (Composio)
      if (body.composio !== undefined) {
        if (typeof body.composio !== "boolean") return json(res, 400, { error: "composio must be true or false" });
        patch.composio = body.composio;
      }
      // per-bot gate on sending voice notes: the toggle is about what this
      // bot may do (an admin decision), not how it looks, so it lives here
      // rather than the client-writable profile surface.
      if (body.voiceNotes !== undefined) {
        if (typeof body.voiceNotes !== "boolean") return json(res, 400, { error: "voiceNotes must be true or false" });
        patch.voiceNotes = body.voiceNotes;
      }
      if (body.memoryEnabled !== undefined) {
        if (typeof body.memoryEnabled !== "boolean") return json(res, 400, { error: "memoryEnabled must be true or false" });
        if (existingBot && (existingBot.busy || activeGroupTurnForBot(existingBot.id)) &&
            body.memoryEnabled !== (existingBot.memoryEnabled !== false)) {
          return json(res, 409, { error: "stop this bot's turn before changing its memory setting" });
        }
        patch.memoryEnabled = body.memoryEnabled;
      }
      // which of those apps' tools this bot may call (connector grants 1/5:
      // data model only — enforcement lands with slice 2). null returns the
      // bot to boolean-only legacy behavior; {} means no tools.
      if (body.connectorTools !== undefined) {
        if (body.connectorTools === null) {
          patch.connectorTools = undefined;
        } else {
          const parsed = parseConnectorTools(body.connectorTools);
          if (!parsed.ok) return json(res, 400, { error: parsed.error });
          // Connector grants 3/5: past the shape checks, slugs must name
          // connected services and tool names must carry their service
          // prefix. Unreachable backends never block the patch — the
          // call-time verdict from slice 2 stays the authority.
          const semantic = await composio.validateConnectorGrants(cfg, parsed.grants);
          if (semantic) return json(res, 400, { error: semantic });
          patch.connectorTools = parsed.grants;
        }
      }
      // Queue this bot's direct messages behind outstanding delegated work
      // instead of steering the conversation immediately (#1194).
      if (body.parkDirectMessages !== undefined) {
        if (typeof body.parkDirectMessages !== "boolean") return json(res, 400, { error: "parkDirectMessages must be true or false" });
        patch.parkDirectMessages = body.parkDirectMessages;
      }
      // Per-bot selection of app-wide MCP servers. Omitted keeps the current
      // selection; null restores all enabled servers; [] explicitly mounts none.
      let requestedMcpServers = existingBot?.mcpServers;
      if (Object.hasOwn(body, "toolScope")) {
        const parsed = parseToolScope(body.toolScope === null ? undefined : body.toolScope);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        patch.toolScope = parsed.scope;
      }
      if (body.mcpServers !== undefined) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (body.mcpServers === null) {
          requestedMcpServers = undefined;
        } else if (!Array.isArray(body.mcpServers) || body.mcpServers.some((t: unknown) => typeof t !== "string" || mcpServerNameError(t) !== null)) {
          return json(res, 400, { error: "mcpServers must be a list of server names, or null" });
        } else {
          requestedMcpServers = [...new Set(body.mcpServers as string[])];
          if (requestedMcpServers.length > MAX_MCP_SERVERS) {
            return json(res, 400, { error: `Select at most ${MAX_MCP_SERVERS} MCP servers.` });
          }
        }
        patch.mcpServers = requestedMcpServers;
      }
      if (body.memoryUpkeep !== undefined) {
        if (typeof body.memoryUpkeep !== "boolean") return json(res, 400, { error: "memoryUpkeep must be true or false" });
        patch.memoryUpkeep = body.memoryUpkeep;
      }
      // Prompt-cache keep-warm: true/false overrides the workspace, null follows it.
      if (body.cacheKeepWarm !== undefined) {
        if (body.cacheKeepWarm !== null && typeof body.cacheKeepWarm !== "boolean") return json(res, 400, { error: "cacheKeepWarm must be true, false or null" });
        patch.cacheKeepWarm = body.cacheKeepWarm ?? undefined;
      }
      // per-bot gate on the app's built-in browser
      if (body.browser !== undefined) {
        if (typeof body.browser !== "boolean") return json(res, 400, { error: "browser must be true or false" });
        if (existingBot?.busy && body.browser !== (existingBot.browser !== false)) {
          return json(res, 409, { error: "stop this bot's turn before changing its browser access" });
        }
        patch.browser = body.browser;
      }
      // which named browser session this bot uses; null/"" = its own
      if (body.browserProfile !== undefined) {
        const requestedProfile = body.browserProfile === null || body.browserProfile === ""
          ? undefined
          : body.browserProfile;
        if (existingBot?.busy && requestedProfile !== existingBot.browserProfile) {
          return json(res, 409, { error: "stop this bot's turn before changing its browser profile" });
        }
        if (existingBot && requestedProfile !== existingBot.browserProfile &&
            browserRuntime.heldBy(currentBrowserSession(existingBot.id, existingBot.browserProfile))) {
          return json(res, 409, { error: "Release browser control before changing its profile." });
        }
        if (requestedProfile === undefined) patch.browserProfile = undefined;
        else if (
          typeof requestedProfile === "string" &&
          (requestedProfile === "guest" || (cfg.browserProfiles ?? []).some((profile) => profile.id === requestedProfile))
        ) {
          patch.browserProfile = requestedProfile;
        } else return json(res, 400, { error: "browserProfile must name an existing browser profile" });
      }
      if (body.cloudBackend !== undefined && !["box", "vps"].includes(String(body.cloudBackend))) {
        return json(res, 400, { error: "cloudBackend must be box or vps" });
      }
      if (body.autoStartVps !== undefined) {
        if (typeof body.autoStartVps !== "boolean") return json(res, 400, { error: "autoStartVps must be true or false" });
        patch.autoStartVps = body.autoStartVps;
      }
      if (body.chiefOfStaff !== undefined && typeof body.chiefOfStaff !== "boolean") {
        return json(res, 400, { error: "chiefOfStaff must be true or false" });
      }
      if (body.cloudBackend !== undefined) {
        const backendError = cloudBackendChangeError(Boolean(existingBot?.busy), activeVpsThreads.has(m[1]));
        if (backendError) return json(res, 409, { error: backendError });
      }
      if (body.cwd !== undefined) {
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        patch.cwd = checked.cwd ?? undefined;
      }
      if (body.hidden === true && existingBot?.chiefOfStaff && body.chiefOfStaff !== false) {
        return json(res, 400, { error: "choose another Chief of Staff before hiding this bot" });
      }
      // the permission fields decide what runs unattended, so they are
      // type-checked rather than copied through: a string alwaysAllow would
      // still answer .includes() — with substring matches, not tool names
      if (body.autoApprove !== undefined) {
        if (typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be true or false" });
      }
      let requestedApprovalMode: ApprovalMode;
      if (body.approvalMode !== undefined) {
        if (!isApprovalMode(body.approvalMode)) {
          return json(res, 400, {
            error: "approvalMode must be ask, auto, full, or custom",
          });
        }
        requestedApprovalMode = body.approvalMode;
      } else if (body.autoApprove !== undefined) {
        // Compatibility for desktop/mobile builds that predate the four-level
        // selector. Their boolean can choose only safe Auto or Ask; it can
        // never silently create Full access.
        requestedApprovalMode = body.autoApprove ? "auto" : "ask";
      } else {
        requestedApprovalMode = approvalModeFor(existingBot ?? {});
      }
      const currentApprovalMode = approvalModeFor(existingBot ?? {});
      const approvalChangeRequested = body.approvalMode !== undefined || body.autoApprove !== undefined;
      if (existingBot?.busy && approvalChangeRequested && requestedApprovalMode !== currentApprovalMode) {
        return json(res, 409, {
          error: "stop this bot's turn before changing its approval level",
        });
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        patch.approvalMode = requestedApprovalMode;
        // Keep the old wire field truthful for older paired apps. It means
        // specifically safe Auto, not "some mode that approves things".
        patch.autoApprove = requestedApprovalMode === "auto";
      }
      const targetSelection = normalizedSelection ?? existingBot?.modelSelection;
      if (normalizedSelection && movedTask) {
        const mode = approvalModeFor(movedTask);
        if ((mode === "full" || mode === "custom") &&
          (!supportsApprovalMode(normalizedSelection, mode) || engineSwitchNeedsAsk(mode, movedTask.modelSelection, normalizedSelection))) {
          return json(res, 400, { error: "Choose Ask for the selected thread before changing providers with elevated permissions" });
        }
      }
      if (
        (requestedApprovalMode === "full" || requestedApprovalMode === "custom") &&
        (body.approvalMode !== undefined || normalizedSelection !== undefined) &&
        (!targetSelection || !supportsApprovalMode(targetSelection, requestedApprovalMode) ||
          (existingBot && normalizedSelection && engineSwitchNeedsAsk(requestedApprovalMode, existingBot.modelSelection, normalizedSelection)))
      ) {
        return json(res, 400, {
          error: "This provider does not support the selected approval level, or changing providers requires choosing Ask first",
        });
      }
      // Full access applies at once from any client that can reach this API
      // (owner decision, Oct 12): no desktop channel, no consent field.
      // Custom keeps the packaged desktop's private channel, into it and out
      // of it, because it holds restrictions the person wrote themselves.
      const requiresPrivateApprovalTransition =
        (requestedApprovalMode === "custom" && currentApprovalMode !== "custom") ||
        (currentApprovalMode === "custom" && requestedApprovalMode !== "custom");
      if (requiresPrivateApprovalTransition) {
        return json(res, 403, {
          error: "This approval-level change can only be made from the packaged desktop app",
        });
      }
      if (HOSTED_WORKSPACE && requestedApprovalMode === "full" &&
        (currentApprovalMode !== "full" || body.applyToAllThreads === true)) {
        return json(res, 403, { error: HOSTED_FULL_ACCESS_REFUSAL });
      }
      // One level for the bot and every one of its conversations, the same
      // way for every level but Custom: bot settings sends it with Full, a
      // team-wide change with each level it sets. Without it only the default
      // (and the threads that follow it) changes. A thread on Custom leaves
      // it only through the desktop's private channel, as the bot does.
      if (body.applyToAllThreads !== undefined) {
        if (typeof body.applyToAllThreads !== "boolean") return json(res, 400, { error: "applyToAllThreads must be true or false" });
        if (body.applyToAllThreads && (body.approvalMode === undefined || requestedApprovalMode === "custom")) {
          return json(res, 400, { error: "applyToAllThreads goes with an approvalMode other than custom" });
        }
      }
      if (body.applyToAllThreads === true && existingBot) {
        const threads = store.tasks(existingBot.id);
        if (threads.some((task) => threadBusy(existingBot.id, task.threadId))) {
          return json(res, 409, { error: "stop this bot's turns before changing its approval level" });
        }
        if (threads.some((task) => approvalModeFor(store.projectBotForTask(existingBot.id, task.threadId) ?? {}) === "custom")) {
          return json(res, 403, { error: "A thread on Custom approval can only leave it from the packaged desktop app" });
        }
        if (threads.some((task) => !supportsApprovalMode(task.modelSelection ?? targetSelection, requestedApprovalMode))) {
          return json(res, 400, { error: "Every thread's provider must support this approval level" });
        }
      }
      // "Auto on this Mac" hands a bot the user's real session, so the grant
      // must prove a human saw the warning. The desktop dialog is the only
      // caller that sends acknowledgeLocalAuto; without it a PATCH that would
      // create the combination — a bot curling the loopback API from a tool
      // call, a script, a stale client — is refused. The renderer dialog
      // alone is not a boundary; this check is.
      const wantsComputer = computerSpecified ? requestedComputer : existingBot?.computer;
      const wantsAuto = requestedApprovalMode === "auto";
      // Every thread counts when the level goes to all of them: one still
      // on another level gets Auto on this computer for the first time.
      const alreadyGranted =
        existingBot?.computer === "local" && approvalModeFor(existingBot) === "auto" &&
        (body.applyToAllThreads !== true || store.tasks(existingBot.id).every((task) =>
          approvalModeFor(store.projectBotForTask(existingBot.id, task.threadId) ?? {}) === "auto"));
      if (wantsComputer === "local" && wantsAuto === true && !alreadyGranted && body.acknowledgeLocalAuto !== true) {
        return json(res, 400, {
          error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)",
        });
      }
      if (body.approvePeerComms !== undefined) {
        if (typeof body.approvePeerComms !== "boolean") {
          return json(res, 400, { error: "approvePeerComms must be true or false" });
        }
        patch.approvePeerComms = body.approvePeerComms;
      }
      // Who this bot may contact. null clears the list back to "everyone
      // visible in my section"; an array — including an empty one — is the
      // explicit wiring, so a bot can be given exactly one correspondent.
      //
      // Narrowing is free, widening is not. The bot this field constrains
      // can reach this endpoint: resolveRequestAuth hands admin+client to
      // any loopback caller, so a bot holding Bash is one curl from
      // deleting its own leash — the same adversary the acknowledgeLocalAuto
      // block above is written against, and the exact bot the allow-list
      // exists to contain. So cutting reach needs nothing (an operator, a
      // script, even the bot itself may only ever make it smaller), while
      // clearing the list or adding an id needs the proof of a human the
      // desktop dialog sends and a tool call cannot forge.
      if (body.peers !== undefined) {
        let nextPeers: string[] | undefined;
        if (body.peers === null) nextPeers = undefined;
        else if (
          !Array.isArray(body.peers) ||
          body.peers.some((peerId: unknown) => typeof peerId !== "string")
        ) {
          return json(res, 400, { error: "peers must be a list of bot ids, or null for every bot in this section" });
        } else {
          nextPeers = [...new Set<string>(body.peers)].slice(0, MAX_WORKSPACE_BOTS);
        }
        // A bot with no list is already at its widest, so the first list it
        // is ever given can only narrow it.
        const currentPeers = existingBot?.peers;
        const widensReach =
          Array.isArray(currentPeers) &&
          (nextPeers === undefined || nextPeers.some((peerId) => !currentPeers.includes(peerId)));
        if (widensReach && body.acknowledgePeerScope !== true) {
          return json(res, 400, {
            error: "Widening a bot's allowed peers requires confirming it first (acknowledgePeerScope)",
          });
        }
        patch.peers = nextPeers;
      }
      if (body.managedSections !== undefined) {
        const parsed = z.array(z.string().trim().max(60)).max(100).safeParse(body.managedSections);
        if (!parsed.success) return json(res, 400, { error: "managedSections must be a list of up to 100 team names (60 characters each)" });
        const sections = [...new Set(parsed.data)];
        const newSections = sections.filter(section => !(existingBot?.managedSections ?? []).includes(section));
        if (newSections.some(section => section !== "" && !store.sections.includes(section))) {
          return json(res, 400, { error: "Create the named team before giving a Chief access to it" });
        }
        if (sections.length && !(body.chiefOfStaff === true || (existingBot?.chiefOfStaff && body.chiefOfStaff !== false))) {
          return json(res, 400, { error: "Only a Chief of Staff can be given access to additional teams" });
        }
        if (newSections.length && body.acknowledgePeerScope !== true) {
          return json(res, 400, { error: "Confirm which additional teams this Chief may work with (acknowledgePeerScope)" });
        }
        patch.managedSections = sections;
      }
      // Removing the role revokes its grants, rather than leaving dormant
      // authority to return if this bot is elected Chief again later.
      if (body.chiefOfStaff === false) patch.managedSections = [];
      // Who may see this bot on a workspace several people share
      // (bot-visibility.ts): "everyone" (the default), "admins", or
      // { people: [...] }. Access control, applied at once; members' PATCHes
      // never get here (clientBotPatchViolation).
      if (Object.hasOwn(body, "visibility")) {
        const parsed = parseVisibility(body.visibility);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        patch.visibility = parsed.visibility;
      }
      if (body.alwaysAllow !== undefined) {
        if (!Array.isArray(body.alwaysAllow) || body.alwaysAllow.some((t: unknown) => typeof t !== "string")) {
          return json(res, 400, { error: "alwaysAllow must be a list of tool keys" });
        }
        patch.alwaysAllow = [...new Set(body.alwaysAllow as string[])].slice(0, 200);
      }
      // What "the proof of a human" above actually rests on. In the packaged
      // desktop it is real: every mutation here already carried the owner
      // capability a tool call cannot forge. Outside it — `pnpm dev`, the
      // CLI, the Docker stack — loopback is the owner by design, so the
      // acknowledgement flag and the settings that loosen a bot's leash
      // (a wider peer list, the peer-approval gate switched off, a section
      // move that changes who is in reach, a standing always-allow grant)
      // are one curl away from the bot they constrain. What such a request
      // does NOT have is a paired session or a browser origin; and the one
      // moment a bot's shell can send it is while a turn is running. So an
      // originless, session-less loopback caller may loosen a bot only
      // while every bot is idle — and is logged when it does — while the
      // served UI (a browser, with its origin) and a paired device keep
      // working mid-turn as before. A bar, not a wall: the wall is the
      // desktop capability or a paired session, which is what the refusal
      // points at.
      const loosened: string[] = [];
      // These three fields were validated above before joining the broad patch.
      const trustPatch = patch as Pick<Partial<BotRecord>, "outbound" | "connectorScopes" | "fallback">;
      if (body.outbound !== undefined && trustPatch.outbound?.policy === "allow" &&
          (existingBot?.outbound?.policy !== "allow" || trustPatch.outbound.dailyCap > existingBot.outbound.dailyCap)) loosened.push("outbound");
      if (body.connectorScopes !== undefined && existingBot?.connectorScopes &&
          (!trustPatch.connectorScopes || Object.entries(trustPatch.connectorScopes.apps).some(([slug, scope]) =>
            !existingBot.connectorScopes!.apps[slug] || (scope === "write" && existingBot.connectorScopes!.apps[slug] === "read")))) loosened.push("connectorScopes");
      if (body.fallback !== undefined && trustPatch.fallback?.some(candidate =>
          !existingBot?.fallback?.some(previous => previous.instanceId === candidate.instanceId && previous.model === candidate.model))) loosened.push("fallback");
      if (Array.isArray(patch.managedSections) && patch.managedSections.some(section => !(existingBot?.managedSections ?? []).includes(section))) {
        loosened.push("managedSections");
      }
      // A shell can forge an Origin header. New cross-team authority may
      // come from local scripts only when all bots are idle; paired owners
      // and the packaged desktop's private capability can grant it mid-turn.
      if (loosened.includes("managedSections") && auth.kind === "loopback" && !DESKTOP_MANAGED && store.bots.some(bot => bot.busy)) {
        return json(res, 409, { error: "Stop running bots before granting access to another team, or use the desktop app or a paired Full-access session." });
      }
      if (body.peers !== undefined && Array.isArray(existingBot?.peers)) {
        const nextPeers = patch.peers;
        if (nextPeers === undefined || (Array.isArray(nextPeers) && nextPeers.some((peerId) => !existingBot.peers!.includes(peerId)))) {
          loosened.push("peers");
        }
      }
      if (body.approvePeerComms === false && existingBot?.approvePeerComms === true) loosened.push("approvePeerComms");
      if (section !== undefined && sectionKey(existingBot?.section) !== sectionKey(section)) loosened.push("section");
      if (Array.isArray(patch.alwaysAllow) && patch.alwaysAllow.some((key) => !(existingBot?.alwaysAllow ?? []).includes(key))) {
        loosened.push("alwaysAllow");
      }
      if (body.mcpServers !== undefined && Array.isArray(existingBot?.mcpServers) &&
          (requestedMcpServers === undefined || requestedMcpServers.some((name) => !existingBot.mcpServers!.includes(name)))) {
        loosened.push("mcpServers");
      }
      if (Object.hasOwn(body, "toolScope") && toolScopeWidens(existingBot?.toolScope, patch.toolScope)) loosened.push("toolScope");
      const browserOrigin = typeof req.headers.origin === "string" && req.headers.origin.trim() !== "";
      if (loosened.length && auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin) {
        if (store.bots.some((candidate) => candidate.busy)) {
          return json(res, 409, {
            error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle.",
          });
        }
        console.warn(`bot ${m[1]}: ${loosened.join(", ")} loosened by ${requestSource(req)} through the local API with no paired session`);
      }
      if (existingBot?.computer === "local" && computerSpecified && requestedComputer !== "local") {
        await interruptAllDirectThreads(existingBot.id);
        const routine = routines!.activeBotRunForBot(existingBot.id);
        if (routine) await routines!.cancelRun(routine.id);
        const groupTurn = activeGroupTurnForBot(existingBot.id);
        if (groupTurn) {
          cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
          revokeInternalCapabilitiesForThread(groupTurn.threadId);
          await runningTurnInstance(existingBot, groupTurn.threadId)?.adapter.interruptTurn(groupTurn.threadId).catch(() => {});
          closeOpenApprovals(groupTurn.threadId);
        }
      }
      const chiefMovedSections =
        Boolean(existingBot?.chiefOfStaff) &&
        body.chiefOfStaff !== false &&
        section !== undefined &&
        sectionKey(existingBot?.section) !== sectionKey(section);
      let bot: BotRecord | null;
      const freshBrowserBot = store.bot(m[1]);
      // Connector validation and runtime revocation can yield after the first
      // memory check. Keep the same idle-only transition at the final commit.
      if (freshBrowserBot && body.memoryEnabled !== undefined &&
          body.memoryEnabled !== (freshBrowserBot.memoryEnabled !== false) &&
          (freshBrowserBot.busy || activeGroupTurnForBot(freshBrowserBot.id))) {
        return json(res, 409, { error: "stop this bot's turn before changing its memory setting" });
      }
      if (Object.hasOwn(body, "toolScope")) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (toolScopeWidens(freshBrowserBot?.toolScope, patch.toolScope) && auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin && store.bots.some((candidate) => candidate.busy)) {
          return json(res, 409, { error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle." });
        }
        if (freshBrowserBot && JSON.stringify(freshBrowserBot.toolScope) !== JSON.stringify(patch.toolScope)
          && (freshBrowserBot.busy || activeGroupTurnForBot(freshBrowserBot.id))) {
          return json(res, 409, { error: "Stop this bot's turns before changing its tool selection." });
        }
      }
      // Custom servers are process configuration: a running turn cannot
      // unmount them. Recheck after any awaited runtime revocation above.
      if (body.mcpServers !== undefined) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (Array.isArray(freshBrowserBot?.mcpServers) &&
            (requestedMcpServers === undefined || requestedMcpServers.some((name) => !freshBrowserBot.mcpServers!.includes(name))) &&
            auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin && store.bots.some((candidate) => candidate.busy)) {
          return json(res, 409, { error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle." });
        }
        if (freshBrowserBot &&
            JSON.stringify(requestedMcpServers?.toSorted()) !== JSON.stringify(freshBrowserBot.mcpServers?.toSorted()) &&
            (freshBrowserBot.busy || activeGroupTurnForBot(freshBrowserBot.id))) {
          return json(res, 409, { error: "Stop this bot's turns before changing its MCP servers." });
        }
      }
      if (normalizedSelection && movedTask) {
        const current = store.projectBotForTask(movedTask.id, movedTask.threadId);
        if (!current) return json(res, 404, { error: "no such task" });
        const checked = checkedModelSelection(normalizedSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) });
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        if (freshBrowserBot && activeGroupTurnForBot(freshBrowserBot.id)) {
          const groupChecked = checkedModelSelection(normalizedSelection, { selection: freshBrowserBot.modelSelection, busy: true });
          if (!groupChecked.ok) return json(res, groupChecked.status, { error: groupChecked.error });
        }
      }
      if (freshBrowserBot && body.browserProfile !== undefined &&
          patch.browserProfile !== freshBrowserBot.browserProfile &&
          (freshBrowserBot.busy || browserRuntime.heldBy(currentBrowserSession(freshBrowserBot.id, freshBrowserBot.browserProfile)))) {
        return json(res, 409, { error: "Stop the bot and release browser control before changing its profile." });
      }
      if (profile.patch.soul !== undefined) {
        if (freshBrowserBot) assertTeamComputerChangeIdle(freshBrowserBot, { ...freshBrowserBot, ...patch } as BotRecord);
        // A mixed settings request must not turn a runtime revocation into
        // a persist-first edit. Apply runtime fields with their existing
        // fail-closed semantics; atomically commit only the profile fields.
        const runtimePatch = { ...patch };
        for (const field of Object.keys(profile.patch)) delete runtimePatch[field];
        if (Object.keys(runtimePatch).length) store.patchBot(m[1], runtimePatch);
        bot = store.patchBotProfile(m[1], profile.patch);
      } else {
        if (freshBrowserBot) assertTeamComputerChangeIdle(freshBrowserBot, { ...freshBrowserBot, ...patch } as BotRecord);
        bot = store.patchBot(m[1], patch);
      }
      if (!bot) return json(res, 404, { error: "no such bot" });
      // The same one durable write the desktop's all-threads grant commits.
      if (body.applyToAllThreads === true && requestedApprovalMode !== "custom") store.setAllThreadApprovalMode(bot.id, requestedApprovalMode);
      if (body.memoryUpkeep === false || body.memoryEnabled === false) memoryUpkeep.dropBot(bot.id);
      if (body.cacheKeepWarm !== undefined) cacheKeepWarm.refresh();
      // A defined Works on is the newest explicit choice: this bot's
      // auto-recorded pins that now point elsewhere give way immediately, so
      // the next turn on each thread follows the new setting. Person-set pins
      // and pins that already match stay; returning to Auto sweeps nothing.
      if (computerSpecified && requestedComputer !== undefined) store.clearAutoSurfacePins(m[1], requestedComputer);
      // A new bot model moves every thread that follows the bot, and the
      // moved thread (movedTask above) follows it from now on too.
      if (normalizedSelection && movedTask) store.patchTask(bot.id, movedTask.threadId, { modelSelection: undefined,
        ...hostedModels?.resetTask(movedTask.modelSelection, normalizedSelection) });
      if (existingBot && (bot.browserProfile !== beforeBrowserProfile || bot.browser !== beforeBrowserEnabled)) {
        browserLive.closeForBot(bot.id);
        if (beforeBrowserProfile === "guest" && (bot.browserProfile !== "guest" || bot.browser === false)) {
          void forgetTemporaryBrowser(bot.id).catch((error) => console.warn("temporary browser cleanup failed", error));
        }
      }
      const chiefChanges =
        body.chiefOfStaff === true || chiefMovedSections
          ? store.setChiefOfStaff(bot.id)
          : [];
      if (chiefChanges === null) return json(res, 404, { error: "no such bot" });
      if (beforeProfile) {
        const now = store.bot(bot.id)!;
        recordProfileChange(bot.id, "user", "api", beforeProfile, profileSnapshot(now));
      }
      // A new audience changes who may see this bot's rooms and teams too:
      // re-announce them so every member's stream gains or withdraws them.
      if (Object.hasOwn(patch, "visibility") && JSON.stringify(beforeVisibility ?? "everyone") !== JSON.stringify(bot.visibility ?? "everyone")) {
        for (const group of store.groups.filter((candidate) => candidate.memberIds.includes(bot!.id))) {
          broadcast({ kind: "group", group: publicGroupState(group) });
        }
        broadcast({ kind: "sections", sections: store.sections });
        audienceChanged();
      }
      return json(res, 200, { bot: wireBot(store.bot(bot.id)!) });
    }
    return PASS;
  };
}
