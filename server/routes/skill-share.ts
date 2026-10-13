// Sharing learned skills with the team (features.shareLearnedSkills): the
// receipt's "Share with team" button, and sharing a bot's learned skill by
// name (a coordinator such as an editing lead acting on the owner's behalf).
// The work is server/host/skill-share-host.ts; scope rules stay keyed by
// path in server/request-auth.ts.
import type { SkillShareRecord } from "../../shared/skill-request.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SkillShareRouteDeps {
  /** features.shareLearnedSkills is not "off". */
  enabled(): boolean;
  botExists(botId: string): boolean;
  /** Why this session may not act on the receipt card, or null. */
  cardRefusal(auth: RequestAuth, threadId: string, requestId: string): string | null;
  shareFromReceipt(threadId: string, requestId: string): { ok: true; shared: SkillShareRecord } | { ok: false; status: number; error: string };
  shareFromBot(botId: string, name: string): SkillShareRecord | { error: string };
}

export function createSkillShareRoutes(deps: SkillShareRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (method !== "POST") return PASS;
    let m = path.match(/^\/api\/threads\/([\w-]+)\/share-skill$/);
    if (m) {
      if (!deps.enabled()) return json(res, 404, { error: "sharing learned skills is not enabled" });
      const body = await readBody(req);
      const requestId = typeof body?.requestId === "string" ? body.requestId : "";
      if (!requestId) return json(res, 400, { error: "requestId is required" });
      const refusal = deps.cardRefusal(auth, m[1]!, requestId);
      if (refusal) return json(res, 403, { error: refusal });
      const result = deps.shareFromReceipt(m[1]!, requestId);
      if (!result.ok) return json(res, result.status, { error: result.error });
      return json(res, 200, { ok: true, shared: result.shared });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)\/share$/);
    if (m) {
      if (!deps.enabled()) return json(res, 404, { error: "sharing learned skills is not enabled" });
      if (!deps.botExists(m[1]!)) return json(res, 404, { error: "no such bot" });
      const shared = deps.shareFromBot(m[1]!, m[2]!);
      if ("error" in shared) return json(res, 422, { error: shared.error });
      return json(res, 200, { ok: true, shared });
    }
    return PASS;
  };
}
