import type { SignInPlace } from "../../shared/sign-in-request.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

/** The person's card answers use the ordinary authenticated route table. */
export function createSignInCardRoutes(deps: {
  settle(botId: string, threadId: string, messageId: string, outcome: "done" | "cancelled"): { status: number; body: Record<string, unknown> };
}): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const match = path.match(/^\/api\/bots\/([\w-]+)\/sign-in-cards\/([\w-]+)\/(done|cancel)$/);
    if (!match || method !== "POST") return PASS;
    const body = await readBody(req);
    const result = deps.settle(match[1]!, String(body.threadId ?? ""), match[2]!, match[3] === "done" ? "done" : "cancelled");
    return json(res, result.status, result.body);
  };
}

/** Only dispatch inside the internal capability gate, with its guarded body
 * reader. The global route table must never register this endpoint. */
export function createInternalSignInRoutes(deps: {
  readBody(): ReturnType<RouteContext["readBody"]>;
  request(site: unknown, reason: unknown): { messageId: string; site: string; place: SignInPlace } | { status: number; error: string };
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/request-sign-in") return PASS;
    const body = await deps.readBody();
    const result = deps.request(body.site, body.reason);
    return "error" in result ? json(res, result.status, { error: result.error }) : json(res, 201, result);
  };
}
