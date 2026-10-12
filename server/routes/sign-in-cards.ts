// A sign-in card's two answers (shared/sign-in-request.ts). Nothing secret
// crosses here: the person typed the password into the page itself, never
// into OpenMausBot. POST /api/bots/<bot>/sign-in-cards/<message>/(done|cancel)
// with {threadId}; scoped like the other card answers in server/request-auth.ts.
import { PASS, type RouteHandler } from "./table.ts";

export type SignInOutcome = "done" | "cancelled";

export interface SignInCardRouteDeps {
  settle(botId: string, threadId: string, messageId: string, outcome: SignInOutcome): { status: number; body: Record<string, unknown> };
}

const CARD = /^\/api\/bots\/([\w-]+)\/sign-in-cards\/([\w-]+)\/(done|cancel)$/u;

export function createSignInCardRoutes(deps: SignInCardRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const m = CARD.exec(path);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    const result = deps.settle(m[1]!, String(body.threadId ?? ""), m[2]!, m[3] === "done" ? "done" : "cancelled");
    return json(res, result.status, result.body);
  };
}
