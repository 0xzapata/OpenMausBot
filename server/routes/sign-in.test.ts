import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createInternalSignInRoutes, createSignInCardRoutes } from "./sign-in.ts";
import { dispatchRoutes, PASS, type RouteContext } from "./table.ts";

function context(path: string, method = "POST", body: unknown = {}): RouteContext {
  // These handlers only hand req/res to the injected reader/reply; no sockets.
  return {
    req: {} as IncomingMessage, res: {} as ServerResponse,
    path, method, url: new URL(path, "http://fixture.invalid"),
    auth: { kind: "loopback", scopes: ["admin", "client"] },
    readBody: vi.fn(async () => body), json: vi.fn(),
  };
}

describe("sign-in card route", () => {
  it.each(["done", "cancel"])("settles %s with the same ids, body and response", async action => {
    const result = { status: 200, body: { resumed: true, [action === "done" ? "done" : "cancelled"]: true } };
    const settle = vi.fn(() => result);
    const ctx = context(`/api/bots/bot-1/sign-in-cards/card-2/${action}`, "POST", { threadId: "thread-3" });
    expect(await dispatchRoutes([createSignInCardRoutes({ settle })], ctx)).toBe(true);
    expect(ctx.readBody).toHaveBeenCalledExactlyOnceWith(ctx.req);
    expect(settle).toHaveBeenCalledExactlyOnceWith("bot-1", "thread-3", "card-2", action === "done" ? "done" : "cancelled");
    expect(ctx.json).toHaveBeenCalledExactlyOnceWith(ctx.res, result.status, result.body);
  });

  it.each([undefined, null, 42])("preserves threadId conversion for %s", async threadId => {
    const settle = vi.fn(() => ({ status: 404, body: { error: "no such sign-in request" } }));
    const ctx = context("/api/bots/b/sign-in-cards/m/done", "POST", { threadId });
    await createSignInCardRoutes({ settle })(ctx);
    expect(settle).toHaveBeenCalledExactlyOnceWith("b", String(threadId ?? ""), "m", "done");
  });

  it.each([403, 404, 409])("preserves a %s settlement refusal", async status => {
    const result = { status, body: { error: "fixture refusal" } };
    const ctx = context("/api/bots/b/sign-in-cards/m/cancel");
    await createSignInCardRoutes({ settle: () => result })(ctx);
    expect(ctx.json).toHaveBeenCalledExactlyOnceWith(ctx.res, status, result.body);
  });

  it.each([
    ["GET", "/api/bots/b/sign-in-cards/m/done"],
    ["PATCH", "/api/bots/b/sign-in-cards/m/cancel"],
    ["POST", "/api/bots/b/sign-in-cards/m/provide"],
    ["POST", "/api/bots/b/sign-in-cards/m/done/extra"],
    ["POST", "/api/internal/request-sign-in"],
  ])("passes %s %s without reading or settling", async (method, path) => {
    const settle = vi.fn(() => ({ status: 200, body: {} }));
    const ctx = context(path!, method);
    expect(await createSignInCardRoutes({ settle })(ctx)).toBe(PASS);
    expect(ctx.readBody).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it("propagates body errors without settling", async () => {
    const error = Object.assign(new Error("invalid JSON body"), { status: 400 });
    const settle = vi.fn(() => ({ status: 200, body: {} }));
    const ctx = context("/api/bots/b/sign-in-cards/m/done");
    ctx.readBody = vi.fn().mockRejectedValue(error);
    await expect(createSignInCardRoutes({ settle })(ctx)).rejects.toBe(error);
    expect(settle).not.toHaveBeenCalled();
    expect(ctx.json).not.toHaveBeenCalled();
  });
});

describe("internal sign-in route", () => {
  const result = { messageId: "card-1", site: "example.com", place: "browser" as const };

  it("awaits the guarded reader before dispatching only site and reason", async () => {
    let release!: (body: { site: string; reason: string }) => void;
    const readBody = vi.fn(() => new Promise<{ site: string; reason: string }>(resolve => { release = resolve; }));
    const request = vi.fn(() => result);
    const ctx = context("/api/internal/request-sign-in");
    const pending = dispatchRoutes([createInternalSignInRoutes({ readBody, request })], ctx);
    expect(readBody).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    release({ site: "https://example.com/login", reason: "Fixture task" });
    expect(await pending).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith("https://example.com/login", "Fixture task");
    expect(ctx.readBody).not.toHaveBeenCalled();
    expect(ctx.json).toHaveBeenCalledExactlyOnceWith(ctx.res, 201, result);
  });

  it.each([400, 403, 409])("preserves a %s request refusal", async status => {
    const ctx = context("/api/internal/request-sign-in");
    await createInternalSignInRoutes({
      readBody: async () => ({}), request: () => ({ status, error: "fixture refusal" }),
    })(ctx);
    expect(ctx.json).toHaveBeenCalledExactlyOnceWith(ctx.res, status, { error: "fixture refusal" });
  });

  it.each([400, 401, 403])("does not dispatch when the guarded reader rejects with %s", async status => {
    const error = Object.assign(new Error("body/capability/provenance refusal"), { status });
    const request = vi.fn(() => result);
    const ctx = context("/api/internal/request-sign-in");
    await expect(createInternalSignInRoutes({ readBody: vi.fn().mockRejectedValue(error), request })(ctx)).rejects.toBe(error);
    expect(request).not.toHaveBeenCalled();
    expect(ctx.readBody).not.toHaveBeenCalled();
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/internal/request-sign-in"],
    ["PATCH", "/api/internal/request-sign-in"],
    ["POST", "/api/internal/request-sign-in/extra"],
    ["POST", "/api/bots/b/sign-in-cards/m/done"],
  ])("passes %s %s without reading or creating a card", async (method, path) => {
    const readBody = vi.fn(async () => ({}));
    const request = vi.fn(() => result);
    const ctx = context(path!, method);
    expect(await createInternalSignInRoutes({ readBody, request })(ctx)).toBe(PASS);
    expect(readBody).not.toHaveBeenCalled();
    expect(ctx.readBody).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("lets request errors reach the existing outer handler", async () => {
    const error = new Error("fixture persistence failure");
    const ctx = context("/api/internal/request-sign-in");
    await expect(createInternalSignInRoutes({ readBody: async () => ({}), request: () => { throw error; } })(ctx)).rejects.toBe(error);
    expect(ctx.json).not.toHaveBeenCalled();
  });
});

it("keeps internal dispatch inside the capability gate with its guarded reader", () => {
  const text = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "createInternalSignInRoutes") calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  let enclosing: ts.Node | undefined = call.parent;
  while (enclosing && !(ts.isIfStatement(enclosing) && enclosing.expression.getText(source) === 'path.startsWith("/api/internal/")')) enclosing = enclosing.parent;
  expect(enclosing, "internal sign-in must not move into the global route table").toBeDefined();
  const before = text.slice(enclosing!.getStart(source), call.getStart(source));
  for (const guard of [
    "authorizedInternalCapability(req.headers.authorization)", "!internalCapability", "!internalSender",
    "externalRuntimeMayCall(method, path)", "internalCapability.kind !== requiredCapabilityKind",
    "claimed !== internalSender.id", "claimedThread !== internalCapability.threadId",
    "internalCapabilityIsActive(internalCapability)", "String(body[key]) !== internalSender.id",
    "String(body[key]) !== internalCapability.threadId",
  ]) expect(before).toContain(guard);
  expect(call.arguments[0]!.getText(source)).toContain("readBody: readInternalBody");
  expect(call.arguments[0]!.getText(source)).toContain("requestSignIn(internalSender, internalCapability.threadId, site, reason)");
  expect(text).toContain("ROUTES.push(createSignInCardRoutes({ settle: settleSignIn }))");
});
