// Settings → Logins through the route table, on a real sealed store in a
// temporary folder: adding, changing and deleting a login, and the one rule
// that matters most — no answer ever carries a password or a 2FA key.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { LoginStore } from "../login-store.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createLoginRoutes, LOGIN_ERRORS } from "./logins.ts";
import { dispatchRoutes } from "./table.ts";

const PASSWORD = "fake-Settings-pass-1";
const NEW_PASSWORD = "fake-Settings-pass-2";
const KEY = "JBSWY3DPEHPK3PXP";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "omb-login-routes-"));
  dirs.push(dir);
  const store = new LoginStore({ dataDir: dir });
  const routes = [createLoginRoutes({
    list: () => store.list(), create: (input) => store.create(input), update: (id, patch) => store.update(id, patch),
    remove: (id) => store.remove(id), botExists: (id) => ["pepper", "quill"].includes(id),
  })];
  const answers: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, type = "application/json") => {
    const response = await fetch(base + path, { method, headers: { "content-type": type }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text), cache: response.headers.get("cache-control") };
  };
  return { store, call, answers };
}

describe("Settings → Logins routes", () => {
  it("are for admins only", () => {
    for (const method of ["GET", "POST"]) expect(requiredScope(method, "/api/logins")).toBe("admin");
    for (const method of ["PATCH", "DELETE"]) expect(requiredScope(method, "/api/logins/abc")).toBe("admin");
  });

  it("add, list, change and delete a login, and never return its password or 2FA key", async () => {
    const { store, call, answers } = await serve();
    const added = await call("POST", "/api/logins", { site: "https://accounts.example.com/login", username: " alice@example.com ", password: PASSWORD, totp: KEY, bots: ["pepper"] });
    expect(added.status).toBe(201);
    expect(added.body.login).toMatchObject({ host: "accounts.example.com", username: "alice@example.com", hasTotp: true, source: "settings", bots: ["pepper"] });
    const id = added.body.login.id;

    const listed = await call("GET", "/api/logins");
    expect(listed).toMatchObject({ status: 200, cache: "no-store" });
    expect(listed.body.logins).toEqual([added.body.login]);

    expect((await call("PATCH", `/api/logins/${id}`, { password: NEW_PASSWORD, bots: "all" })).body.login).toMatchObject({ bots: "all", hasTotp: true });
    expect(store.get(id)?.password).toBe(NEW_PASSWORD);
    expect((await call("PATCH", `/api/logins/${id}`, { totp: null })).body.login.hasTotp).toBe(false);
    // An empty change keeps the saved password.
    expect((await call("PATCH", `/api/logins/${id}`, {})).status).toBe(200);
    expect(store.get(id)?.password).toBe(NEW_PASSWORD);

    for (const answer of answers) for (const secret of [PASSWORD, NEW_PASSWORD, KEY]) expect(answer).not.toContain(secret);

    expect(await call("DELETE", `/api/logins/${id}`)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await call("GET", "/api/logins")).body.logins).toEqual([]);
    expect((await call("DELETE", `/api/logins/${id}`)).status).toBe(404);
  });

  it.each([
    [{ site: "not a site", username: "a", password: PASSWORD }, LOGIN_ERRORS.site],
    [{ site: "javascript:alert(1)", username: "a", password: PASSWORD }, LOGIN_ERRORS.site],
    [{ site: "example.com", username: "a" }, LOGIN_ERRORS.password],
    [{ site: "example.com", username: "a", password: "" }, LOGIN_ERRORS.password],
    [{ site: "example.com", username: "a", password: "x".repeat(513) }, LOGIN_ERRORS.long],
    [{ site: "example.com", username: "a", password: PASSWORD, totp: "not a key" }, LOGIN_ERRORS.totp],
    [{ site: "example.com", username: "a", password: PASSWORD, bots: ["nobody"] }, LOGIN_ERRORS.bots],
  ])("refuses a login it cannot save: %j", async (body, error) => {
    const { call } = await serve();
    expect(await call("POST", "/api/logins", body)).toMatchObject({ status: 400, body: { error } });
    expect((await call("GET", "/api/logins")).body.logins).toEqual([]);
  });

  it("takes changes as JSON only, so another page's form cannot post one", async () => {
    const { call } = await serve();
    expect((await call("POST", "/api/logins", { site: "example.com", password: PASSWORD }, "text/plain")).status).toBe(415);
  });
});
