// The computers a team or a bot works on, moved out of server/index.ts's
// inline routes into the route table (server/routes/README.md): the named
// team computers (create, assign, provision, sleep, join, take and release
// control), the account-wide Boat and VPS inventories (list, sleep, delete,
// remove), and the Local VM — the shared desktop's status, setup actions
// and screenshot, and a bot's own desktop with its phone join. The Local VM
// flags (`localVmImageBusy`, `localVmProvisionBusy`, `localVmModeChangeBusy`)
// stay in index.ts with the turn code that also reads them; they reach here
// as get/set views.
import { z, type ZodString } from "zod";
import * as boat from "../boat.ts";
import type { ComputerControl } from "../computer-control.ts";
import { localVmMaxInstances, localVmMode, type AppConfig } from "../config.ts";
import {
  containerComputerAction,
  containerComputerExists,
  containerComputerScreenshot,
  containerComputerStatus,
  SHARED_LOCAL_VM_TARGET,
  setupCommands,
  type LocalVmTarget,
  type Runtime,
} from "../container-computer.ts";
import { localVmViewerStatus, viewerTargetId } from "../desktop-viewer-targets.ts";
import type { LocalVmIdleTimer } from "../local-vm-idle.ts";
import type { LocalVmLease } from "../local-vm-lease.ts";
import { redactSecretsInText } from "../redact.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import type { SessionRegistry } from "../sessions.ts";
import { sectionKey, type BotRecord, type Store } from "../store.ts";
import { teamComputerAssignment, teamComputerCreate, teamComputerOwner, type TeamComputerRecord, type TeamComputers } from "../team-computers.ts";
import * as vps from "../vps-computer.ts";
import type { BusyFlag, RemoteComputerProvider } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ComputerRouteDeps {
  store: Pick<Store, "bot" | "bots" | "sections">;
  cfg: AppConfig;
  sessions: Pick<SessionRegistry, "isLive">;
  teamComputers: Pick<TeamComputers, "get" | "create" | "assign" | "setProblem">;
  computerControl: Pick<ComputerControl, "snapshot" | "take" | "release" | "acquireLease" | "releaseLease" | "ownsLease">;
  /** The routines, once started (index.ts assigns them at boot). */
  routines(): Pick<RoutineManager, "activeRunForBot"> | null;
  /** A control lease id as a client may present it (index.ts `controlLeaseIdSchema`). */
  controlLeaseIdSchema: ZodString;
  /** Bots and team computers whose cloud computer is being changed or deleted. */
  boatLifecycleBusyBots: Pick<Set<string>, "has">;
  /** The remote providers whose account is being switched right now. */
  computerProviderConfigTransitions: Pick<Set<RemoteComputerProvider>, "has">;
  /** Local VM targets a thread is using, a setup action holds, or a desktop was seen on. */
  localVmActiveThreads: Pick<Map<string, string>, "has">;
  localVmLifecycleBusy: Pick<Set<string>, "has" | "add" | "delete">;
  localVmSeen: Pick<Set<string>, "add">;
  localVmImageBusy: BusyFlag;
  localVmProvisionBusy: BusyFlag;
  localVmModeChangeBusy: Pick<BusyFlag, "get">;
  localVmOwnerBusy(botId: string): boolean;
  localVmIdleMs(): number;
  localVmLeaseFor(target: LocalVmTarget): Pick<LocalVmLease, "current">;
  localVmIdleFor(target: LocalVmTarget): Pick<LocalVmIdleTimer, "touch" | "cancel">;
  localVmTargetForBot(botId: string): LocalVmTarget;
  localVmTargetForStatus(botId: string, threadId?: string): LocalVmTarget;
  /** What the user's machine can host, for the panel. */
  localVmPayload(target: LocalVmTarget, auth: RequestAuth): Promise<unknown>;
  localVmInventoryPayload(): Promise<unknown>;
  existingPerBotLocalVmCount(runtime: Runtime): Promise<number>;
  teamComputersPayload(): Promise<unknown>;
  teamComputerInUse(computer: TeamComputerRecord): boolean;
  managedBoatOwners(): boat.ManagedBoatOwner[];
  providerTransitionMessage(provider: RemoteComputerProvider): string;
  botHasActiveTurn(botId: string): boolean;
  botComputerControlKey(bot: BotRecord): string;
  botComputerControlSnapshot(botId: string): { held: boolean };
  /** The bot a computer preview names, with its thread pinned by `?threadId`. */
  computerPreviewBot(botId: string, url: URL): BotRecord | null;
  computerPreviewSurface(bot: BotRecord, threadId?: string): Promise<string | undefined>;
  /** Lifecycle fences: each returns the release. */
  claimTeamComputerLifecycle(computer: TeamComputerRecord): () => void;
  claimBotComputerLifecycle(botId: string): () => void;
  claimBoatInventoryRequest(boxId: string): () => void;
  claimManagedBoatMutation(instance: boat.ManagedBoatInventoryInstance): () => void;
  claimManagedVpsMutation(containerName: string): () => void;
}

export function createComputerRoutes(deps: ComputerRouteDeps): RouteHandler {
  const {
    store, cfg, sessions, teamComputers, computerControl, controlLeaseIdSchema, boatLifecycleBusyBots,
    computerProviderConfigTransitions, localVmActiveThreads, localVmLifecycleBusy, localVmSeen, localVmImageBusy,
    localVmProvisionBusy, localVmModeChangeBusy, localVmOwnerBusy, localVmIdleMs, localVmLeaseFor, localVmIdleFor,
    localVmTargetForBot, localVmTargetForStatus, localVmPayload, localVmInventoryPayload, existingPerBotLocalVmCount,
    teamComputersPayload, teamComputerInUse, managedBoatOwners, providerTransitionMessage, botHasActiveTurn,
    botComputerControlKey, botComputerControlSnapshot, computerPreviewBot, computerPreviewSurface,
    claimTeamComputerLifecycle, claimBotComputerLifecycle, claimBoatInventoryRequest, claimManagedBoatMutation,
    claimManagedVpsMutation,
  } = deps;
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const routines = deps.routines();
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    // Named team Boats use real independent ownership, never a hidden bot or
    // an arbitrary provider id. These new routes remain admin-only by default.
    if (path === "/api/team-computers" && method === "GET") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await teamComputersPayload());
    }
    m = path.match(/^\/api\/team-computers(?:\/([\w-]+)(?:\/(provision|join|sleep|control))?)?$/);
    if (m) {
      const computerId = m[1];
      const action = m[2];
      let found = computerId ? teamComputers.get(computerId) : undefined;
      if (computerId && !found) return json(res, 404, { error: "No such team computer" });
      if (method === "GET" && action === "control" && found) {
        return json(res, 200, computerControl.snapshot(teamComputerOwner(found.id)));
      }
      // A GET carries no body, so the content-type gate below can only
      // mislead: the control snapshot is the sole GET on this subtree.
      if (method === "GET" && action !== "control") {
        return json(res, 404, { error: "unknown team computer action" });
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const body = await readBody(req);
      found = computerId ? teamComputers.get(computerId) : undefined;
      const assertCurrentOwner = () => {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) throw Object.assign(new Error("Your session ended; sign in again"), { status: 401 });
        if (computerProviderConfigTransitions.has("box")) throw Object.assign(new Error(providerTransitionMessage("box")), { status: 409 });
      };
      assertCurrentOwner();
      if (action === "control" && method === "POST" && found) {
        const parsed = z.object({ action: z.enum(["take", "release"]), controlLeaseId: controlLeaseIdSchema.optional() }).strict().safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Choose take or release with a valid optional controlLeaseId" });
        const key = teamComputerOwner(found.id);
        if (parsed.data.action === "take" && boatLifecycleBusyBots.has(key)) return json(res, 409, { error: "Wait for this computer's action to finish before taking control" });
        if (parsed.data.controlLeaseId) {
          const result = parsed.data.action === "take"
            ? computerControl.acquireLease(key, parsed.data.controlLeaseId)
            : computerControl.releaseLease(key, parsed.data.controlLeaseId);
          return json(res, 200, { ...result.snapshot, ...result });
        }
        return json(res, 200, parsed.data.action === "take" ? computerControl.take(key) : computerControl.release(key));
      }
      if (method === "PATCH" && found && !action) {
        const parsed = teamComputerAssignment.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Confirm shared desktop access with section and acknowledgeSharedAccess: true" });
        const section = parsed.data.section;
        const checkAssignment = () => {
          assertCurrentOwner();
          if (section !== null && section !== "" && !store.sections.includes(section)) throw Object.assign(new Error("Create the team before assigning a computer"), { status: 404 });
          if (section !== null && store.bots.some(bot => sectionKey(bot.section) === section && (
            botHasActiveTurn(bot.id) || routines?.activeRunForBot(bot.id) || botComputerControlSnapshot(bot.id).held || boatLifecycleBusyBots.has(bot.id)
          ))) throw Object.assign(new Error("Stop the target team's work and release computer control before assigning this computer"), { status: 409 });
        };
        checkAssignment();
        const release = claimTeamComputerLifecycle(found);
        try {
          if (section !== null && !(await boat.findBoat(cfg, teamComputerOwner(found.id)))) return json(res, 409, { error: "Create or retry this computer before assigning it to a team" });
          checkAssignment();
          if (teamComputerInUse(found)) return json(res, 409, { error: "This team computer became busy; stop its work before assigning it" });
          teamComputers.assign(found.id, section);
          return json(res, 200, { ok: true });
        } finally { release(); }
      }
      if (method === "POST" && !computerId) {
        const parsed = teamComputerCreate.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Provide requestId (UUID), a name, and acknowledgeCost: true to create a paid cloud computer" });
        if (!boat.boatConfigured(cfg)) return json(res, 409, { error: "Configure Boat in Settings before creating a cloud computer" });
        const computer = teamComputers.create(parsed.data.name, parsed.data.requestId);
        const release = claimTeamComputerLifecycle(computer);
        try {
          await boat.provisionBoat(cfg, teamComputerOwner(computer.id), computer.name);
          teamComputers.setProblem(computer.id);
          return json(res, 201, { id: computer.id });
        } catch (error) {
          teamComputers.setProblem(computer.id, redactSecretsInText(error instanceof Error ? error.message : String(error)));
          throw error;
        } finally { release(); }
      }
      if (method === "POST" && found && action && action !== "control") {
        if (action === "provision" && body?.acknowledgeCost !== true) return json(res, 400, { error: "Confirm cloud computer creation or wake costs with acknowledgeCost: true" });
        // A ready-only join never wakes, provisions or steals an agent's turn.
        // The caller takes a separate explicit human-control lease first.
        if (action === "join") {
          const key = teamComputerOwner(found.id);
          if (boatLifecycleBusyBots.has(key)) return json(res, 409, { error: "Wait for this computer's action to finish" });
          if (!computerControl.snapshot(key).held) return json(res, 409, { error: "Take control before opening this shared desktop" });
          const release = claimBotComputerLifecycle(key);
          try { return json(res, 200, await boat.joinReadyBoat(cfg, key)); }
          finally { release(); }
        }
        const release = claimTeamComputerLifecycle(found);
        try {
          const result = action === "provision"
            ? await boat.provisionBoat(cfg, teamComputerOwner(found.id), found.name)
            : await boat.sleepBoat(cfg, teamComputerOwner(found.id));
          teamComputers.setProblem(found.id);
          return json(res, 200, result);
        } catch (error) {
          teamComputers.setProblem(found.id, redactSecretsInText(error instanceof Error ? error.message : String(error)));
          throw error;
        } finally { release(); }
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // Account-wide Boat inventory is a Settings surface, never a provisioning
    // path. Listing remains read-only; lifecycle changes require explicit
    // JSON actions and are revalidated against a fresh provider listing.
    // The REST path keeps its historical /boxes segment.
    if (method === "GET" && path === "/api/computers/boxes") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await boat.listManagedBoats(cfg, managedBoatOwners()));
    }
    m = path.match(/^\/api\/computers\/boxes\/([\w-]+)\/(sleep|delete)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (computerProviderConfigTransitions.has("box")) {
        return json(res, 409, { error: providerTransitionMessage("box") });
      }
      const releaseInventoryRequest = claimBoatInventoryRequest(m[1]);
      try {
        const owners = managedBoatOwners();
        if (m[2] === "sleep") {
          return json(res, 200, await boat.sleepManagedBoat(cfg, owners, m[1], claimManagedBoatMutation));
        }
        if (typeof body?.confirmName !== "string" || body.confirmName.length > 100) {
          return json(res, 400, { error: "confirmName must be the cloud computer name shown in Settings" });
        }
        return json(res, 202, await boat.deleteManagedBoat(
          cfg,
          owners,
          m[1],
          body.confirmName,
          claimManagedBoatMutation,
        ));
      } finally {
        releaseInventoryRequest();
      }
    }
    if (method === "GET" && path === "/api/computers/vps") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await vps.listManagedVpsComputers(cfg, managedBoatOwners()));
    }
    m = path.match(/^\/api\/computers\/vps\/([\w-]+)\/remove$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (computerProviderConfigTransitions.has("vps")) {
        return json(res, 409, { error: providerTransitionMessage("vps") });
      }
      if (typeof body?.confirmName !== "string" || body.confirmName.length > 100) {
        return json(res, 400, { error: "confirmName must be the VPS computer name shown in Settings" });
      }
      const releaseComputerLifecycle = claimManagedVpsMutation(m[1]);
      try {
        return json(res, 200, await vps.removeManagedVpsComputer(
          cfg,
          managedBoatOwners(),
          m[1],
          body.confirmName,
        ));
      } finally {
        releaseComputerLifecycle();
      }
    }

    // what the user's machine can host: which runtime is installed, whether
    // its daemon is up, and whether the desktop image and container exist
    if (method === "GET" && path === "/api/local-computer") {
      return json(res, 200, await localVmPayload(SHARED_LOCAL_VM_TARGET, auth));
    }
    if (method === "GET" && path === "/api/local-computer/instances") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await localVmInventoryPayload());
    }
    m = path.match(/^\/api\/local-computer\/(pull|run|start|stop|remove)$/);
    if (m && method === "POST") {
      // Requiring JSON makes these localhost lifecycle mutations non-simple
      // browser requests. A hostile web page cannot submit them with a form,
      // and its cross-origin JSON request is stopped by the browser preflight
      // because this server deliberately emits no CORS permission.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const action = z.enum(["pull", "run", "start", "stop", "remove"]).parse(m[1]);
      if (localVmImageBusy.get() || localVmModeChangeBusy.get() || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key)) {
        return json(res, 409, { error: "another Local VM setup action is still running" });
      }
      if (localVmMode(cfg) === "per-bot" && action === "run") {
        return json(res, 409, { error: "Per-bot mode creates each desktop from that bot's Computer panel" });
      }
      if (localVmMode(cfg) === "pool" && action === "run") {
        return json(res, 409, { error: "Pool mode creates its desktops automatically from conversation turns" });
      }
      const vmOwner = localVmLeaseFor(SHARED_LOCAL_VM_TARGET).current(localVmOwnerBusy);
      if (vmOwner && (action === "stop" || action === "remove" || action === "run")) {
        return json(res, 409, { error: "the Local VM is being used by a bot — stop that turn first" });
      }
      // A lease can lapse under a long, quiet turn whose thread still holds
      // the desktop, so stop/remove must also refuse while the thread
      // registry or a setup action pins it — the same guard bot deletion uses.
      if ((action === "stop" || action === "remove") && (localVmActiveThreads.has(SHARED_LOCAL_VM_TARGET.key) || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key))) {
        return json(res, 409, { error: localVmActiveThreads.has(SHARED_LOCAL_VM_TARGET.key) ? "the Local VM is being used by a bot — stop that turn first" : "another Local VM setup action is still running" });
      }
      if (action === "pull") localVmImageBusy.set(true);
      else localVmLifecycleBusy.add(SHARED_LOCAL_VM_TARGET.key);
      try {
        const status = await containerComputerAction(action, undefined, undefined, SHARED_LOCAL_VM_TARGET);
        if (action === "run" || action === "start") {
          localVmSeen.add(SHARED_LOCAL_VM_TARGET.key);
          localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
        }
        if (action === "stop" || action === "remove") localVmIdleFor(SHARED_LOCAL_VM_TARGET).cancel();
        return json(res, 200, {
          ...localVmViewerStatus(status, auth),
          commands: setupCommands(status.runtime, process.platform, SHARED_LOCAL_VM_TARGET),
          idle_timeout_ms: localVmIdleMs(),
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
      } finally {
        if (action === "pull") localVmImageBusy.set(false);
        else localVmLifecycleBusy.delete(SHARED_LOCAL_VM_TARGET.key);
      }
    }
    if (method === "POST" && path === "/api/local-computer/screenshot") {
      localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, SHARED_LOCAL_VM_TARGET),
      });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer$/);
    if (m && method === "GET") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, await localVmPayload(localVmTargetForStatus(bot.id, bot.threadId), auth));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/(run|start|stop|remove)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (boatLifecycleBusyBots.has(bot.id)) {
        return json(res, 409, { error: "this bot's computer is being changed or deleted — wait for it to finish" });
      }
      const action = z.enum(["run", "start", "stop", "remove"]).parse(m[2]);
      const target = localVmTargetForBot(bot.id);
      if (target.key === SHARED_LOCAL_VM_TARGET.key) {
        return json(res, 409, { error: "Shared mode manages this desktop in App Settings → Computers" });
      }
      if (localVmImageBusy.get() || localVmModeChangeBusy.get() || localVmLifecycleBusy.has(target.key)) {
        return json(res, 409, { error: "this bot's Local VM setup action is still running" });
      }
      if (action === "run" && localVmProvisionBusy.get()) {
        return json(res, 409, { error: "another per-bot Local VM is being created — retry after it finishes" });
      }
      const vmOwner = localVmLeaseFor(target).current(localVmOwnerBusy);
      if (vmOwner) return json(res, 409, { error: "this bot is using its Local VM — stop the turn first" });
      // Mirrors the shared-target guard above: the lease alone can miss a
      // long, quiet turn, and a setup action must not be torn down mid-call.
      if ((action === "stop" || action === "remove") && (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key))) {
        return json(res, 409, { error: localVmActiveThreads.has(target.key) ? "this bot is using its Local VM — stop the turn first" : "this bot's Local VM setup action is still running" });
      }
      // Fence this target, and the cross-target capacity decision for creates,
      // before the first await so two requests cannot both pass the limit.
      localVmLifecycleBusy.add(target.key);
      if (action === "run") localVmProvisionBusy.set(true);
      try {
        if (action === "run") {
          const before = await containerComputerStatus(undefined, undefined, target);
          if (!before.runtime) return json(res, 409, { error: before.problem ?? "No container runtime is installed" });
          if (!(await containerComputerExists(before.runtime, target))) {
            const count = await existingPerBotLocalVmCount(before.runtime);
            if (count >= localVmMaxInstances(cfg)) {
              return json(res, 409, {
                error: `The per-bot Local VM limit is ${localVmMaxInstances(cfg)} — delete an unused bot VM or raise the limit in App Settings`,
              });
            }
          }
        }
        const status = await containerComputerAction(action, undefined, undefined, target);
        if (action === "run" || action === "start") {
          localVmSeen.add(target.key);
          localVmIdleFor(target).touch();
        }
        if (action === "stop" || action === "remove") localVmIdleFor(target).cancel();
        return json(res, 200, {
          ...localVmViewerStatus(status, auth),
          commands: setupCommands(status.runtime, process.platform, target),
          idle_timeout_ms: localVmIdleMs(),
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
      } finally {
        if (action === "run") localVmProvisionBusy.set(false);
        localVmLifecycleBusy.delete(target.key);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/screenshot$/);
    if (m && method === "POST") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (url.searchParams.has("threadId") && await computerPreviewSurface(bot, bot.threadId) !== "vm") {
        return json(res, 409, { error: "This conversation is not using the Local VM" });
      }
      const target = localVmTargetForStatus(bot.id, url.searchParams.has("threadId") ? bot.threadId : undefined);
      localVmIdleFor(target).touch();
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, target),
      });
    }
    // The Local VM's live desktop for a phone, granted only to the control
    // lease that holds this bot's computer right now. Two callers:
    //
    // The companion sidecar (a loopback caller) gets the VM's own noVNC
    // address, VNC password included, relays it to a paired phone the owner
    // has allowed computer access, keeps re-checking the lease with
    // `action: "check"`, and cuts the relay when it no longer holds.
    //
    // A phone paired with this server directly (`openmausbot serve`, no
    // sidecar) never sees that address. It gets this server's own
    // authenticated desktop proxy, bound to its lease: the proxy re-checks
    // the lease and the session every few seconds and closes the socket when
    // either lapses. Reaching here at all took the admin scope, which a
    // chat-only pairing (`openmausbot pair --client`) does not have, so
    // computer access is the same explicit choice the owner's browser makes.
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/join$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const threadId = url.searchParams.has("threadId") ? bot.threadId : undefined;
      if (threadId && await computerPreviewSurface(bot, threadId) !== "vm") {
        return json(res, 409, { error: "This conversation is not using the Local VM" });
      }
      // A bot's human-control hold does not reserve a shared desktop or pool
      // seat. Another bot could drive it while the phone is holding this bot.
      if (localVmMode(cfg) !== "per-bot") {
        return json(res, 409, { error: "Phone control requires a per-bot Local VM. Select per-bot mode in Settings → Computers." });
      }
      const lease = controlLeaseIdSchema.safeParse(url.searchParams.get("controlLeaseId") ?? undefined);
      if (!lease.success) return json(res, 400, { error: "controlLeaseId is required" });
      const controlBot = store.bot(bot.id);
      if (!controlBot || !computerControl.ownsLease(botComputerControlKey(controlBot), lease.data)) {
        return json(res, 409, { error: "Take control of this computer first" });
      }
      const target = localVmTargetForStatus(bot.id, threadId);
      const status = await containerComputerStatus(undefined, undefined, target);
      if (!status.ready || !status.managed || status.container !== "running" || status.network !== "loopback"
        || !status.viewer_url) {
        return json(res, 409, { error: status.problem ?? "The Local VM is not ready" });
      }
      localVmIdleFor(target).touch();
      res.setHeader("cache-control", "private, no-store");
      if (auth.kind === "loopback") return json(res, 200, { joinUrl: status.viewer_url });
      const socket = new URLSearchParams({ botId: bot.id, ...(threadId ? { threadId } : {}), controlLeaseId: lease.data });
      return json(res, 200, {
        socketPath: `api/desktop-viewer/${viewerTargetId(target)}/websockify?${socket}`,
        password: new URLSearchParams(new URL(status.viewer_url).hash.slice(1)).get("password"),
      });
    }
    return PASS;
  };
}
