// Stopping and deleting bots, moved out of server/index.ts's inline routes
// into the route table (server/routes/README.md). POST
// /api/local-computer/interrupt stops every bot working on this computer
// (its direct threads, routine run and room turn); DELETE /api/bots/:id
// hands the bot to index.ts's deleteBotWithLifecycle, which refuses while
// anything of the bot's is still running. The table runs after the auth
// gate; scope rules stay keyed by path in server/request-auth.ts.
import type { ProviderRegistry } from "../harness/registry.ts";
import type { RoutineManager } from "../routines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotLifecycleRouteDeps {
  store: Pick<Store, "bots">;
  /** The routine manager, assigned at boot after the routes are built. */
  routines(): RoutineManager | null;
  interruptAllDirectThreads(botId: string): Promise<void>;
  /** Drops this bot's queued direct turn (on the named thread when given). */
  cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): unknown;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  cancelGroupTurnOperations(groupId: string, threadId: string): void;
  runningTurnInstance(bot: BotRecord | null | undefined, threadId: string): ReturnType<ProviderRegistry["get"]>;
  closeOpenApprovals(threadId: string): void;
  /** The whole deletion, answered with the status and body it returns. */
  deleteBotWithLifecycle(botId: string): Promise<{ status: number; body: unknown }>;
}

export function createBotLifecycleRoutes(deps: BotLifecycleRouteDeps): RouteHandler {
  const {
    store, interruptAllDirectThreads, cancelDirectTurnDispatch, revokeInternalCapabilitiesForThread, activeGroupTurnForBot,
    cancelGroupTurnOperations, runningTurnInstance, closeOpenApprovals, deleteBotWithLifecycle,
  } = deps;
  return async ({ req, res, path, method, json }) => {
    /** scratch for the route match, as index.ts's shared `m` */
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();
    if (method === "POST" && path === "/api/local-computer/interrupt") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await Promise.allSettled(
        store.bots
          .filter((bot) => bot.computer === "local")
          .map(async (bot) => {
            await interruptAllDirectThreads(bot.id);
            const routineRun = routines!.activeBotRunForBot(bot.id);
            if (routineRun) {
              cancelDirectTurnDispatch(bot.id, routineRun.threadId);
              if (routineRun.threadId) {
                revokeInternalCapabilitiesForThread(routineRun.threadId);
              }
              await routines!.cancelRun(routineRun.id);
            }
            const groupTurn = activeGroupTurnForBot(bot.id);
            if (groupTurn) {
              cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
              revokeInternalCapabilitiesForThread(groupTurn.threadId);
              await runningTurnInstance(bot, groupTurn.threadId)?.adapter.interruptTurn(groupTurn.threadId).catch(() => {});
              closeOpenApprovals(groupTurn.threadId);
            }
          }),
      );
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const result = await deleteBotWithLifecycle(m[1]);
      return json(res, result.status, result.body);
    }
    return PASS;
  };
}
