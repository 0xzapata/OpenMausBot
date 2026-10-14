// POST /api/bots/<bot>/sign-in-cards/<message>/(done|cancel|save-login) with {threadId}. A saved password goes into the
// encrypted store and no route ever returns it.
import { PASS, type RouteHandler } from "./table.ts";

export type SignInOutcome = "done" | "cancelled";

type Answer = { status: number; body: Record<string, unknown> };

export interface SignInCardRouteDeps {
  settle(botId: string, threadId: string, messageId: string, outcome: SignInOutcome): Answer;
  saveLogin(botId: string, threadId: string, messageId: string, body: Record<string, unknown>): Answer;
}

const CARD = /^\/api\/bots\/([\w-]+)\/sign-in-cards\/([\w-]+)\/(done|cancel|save-login)$/u;

export function createSignInCardRoutes(deps: SignInCardRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const m = CARD.exec(path);
    if (!m || method !== "POST") return PASS;
    if (m[3] === "save-login") {
      // JSON only, so a form posted from another local page cannot save one.
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (mediaType !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
      const body = await readBody(req, 16_384);
      const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const result = deps.saveLogin(m[1]!, String(fields.threadId ?? ""), m[2]!, fields);
      return json(res, result.status, result.body);
    }
    const body = await readBody(req);
    const result = deps.settle(m[1]!, String(body.threadId ?? ""), m[2]!, m[3] === "done" ? "done" : "cancelled");
    return json(res, result.status, result.body);
  };
}
