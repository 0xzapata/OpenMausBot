import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { LoginStore } from "../login-store.ts";
import { OnePasswordLogins, sdkOnePasswordClient } from "../onepassword.ts";
import { fakeOnePasswordSdk } from "../testing/fake-onepassword.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createLoginRoutes, LOGIN_ERRORS } from "./logins.ts";
import { dispatchRoutes } from "./table.ts";

const PASSWORD = "fake-Settings-pass-1";
const NEW_PASSWORD = "fake-Settings-pass-2";
const KEY = "JBSWY3DPEHPK3PXP";
const TOKEN = "ops_fake-route-token";
const VAULT_PASSWORD = "fake-vault-pass";

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
  const { sdk } = fakeOnePasswordSdk({ token: TOKEN, vaults: { v1: { title: "Shared with OMB", items: [
    { id: "i1", title: "Example", urls: ["https://vault.example.com"], username: "vault-user", password: VAULT_PASSWORD },
  ] } } });
  const onePassword = new OnePasswordLogins({ token: () => store.onePasswordToken(), connect: (token) => sdkOnePasswordClient(sdk, token, "0.0.0") });
  const routes = [createLoginRoutes({
    list: () => store.list(), create: (input) => store.create(input), update: (id, patch) => store.update(id, patch),
    remove: (id) => store.remove(id), botExists: (id) => ["pepper", "quill"].includes(id),
    onePassword: {
      status: () => onePassword.status(),
      list: () => onePassword.list(),
      connect: async (token) => { const status = await onePassword.refresh(token); store.setOnePasswordToken(token); return status; },
      refresh: () => onePassword.refresh(),
      disconnect: () => { store.setOnePasswordToken(null); onePassword.clear(); return onePassword.status(); },
    },
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
    expect(listed.body).toEqual({ logins: [added.body.login], onePassword: { connected: false } });

    expect((await call("PATCH", `/api/logins/${id}`, { password: NEW_PASSWORD, bots: "all" })).body.login).toMatchObject({ bots: "all", hasTotp: true });
    expect(store.get(id)?.password).toBe(NEW_PASSWORD);
    expect((await call("PATCH", `/api/logins/${id}`, { totp: null })).body.login.hasTotp).toBe(false);
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

  it("connects 1Password with a token it checks first, lists its logins read-only, and never returns the token", async () => {
    const { store, call, answers } = await serve();
    expect((await call("GET", "/api/logins")).body).toEqual({ logins: [], onePassword: { connected: false } });
    for (const token of ["", "ops_ has spaces", "ops_wrong-fake-token"]) {
      expect((await call("POST", "/api/logins/1password", { token })).status, token).toBe(400);
    }
    expect((await call("POST", "/api/logins/1password", { token: "ops_wrong-fake-token" })).body.error).toBe("1Password did not accept the token. Paste a service account token (it starts with ops_), or make a new one.");
    expect(store.onePasswordToken()).toBeNull();

    expect(await call("POST", "/api/logins/1password", { token: TOKEN })).toMatchObject({ status: 200, body: { onePassword: { connected: true, vaults: ["Shared with OMB"], items: 1 } } });
    expect(store.onePasswordToken()).toBe(TOKEN);
    const listed = await call("GET", "/api/logins");
    expect(listed.body.logins).toEqual([expect.objectContaining({ host: "vault.example.com", username: "vault-user", source: "1password", bots: "all" })]);
    const id = listed.body.logins[0].id as string;
    for (const method of ["PATCH", "DELETE"]) {
      expect(await call(method, `/api/logins/${encodeURIComponent(id)}`, method === "PATCH" ? { password: "fake-x-pass" } : undefined))
        .toMatchObject({ status: 409, body: { error: LOGIN_ERRORS.readOnly } });
    }
    expect((await call("POST", "/api/logins/1password/refresh", {})).body.onePassword).toMatchObject({ connected: true, items: 1 });

    expect(await call("DELETE", "/api/logins/1password")).toMatchObject({ status: 200, body: { onePassword: { connected: false } } });
    expect(store.onePasswordToken()).toBeNull();
    expect((await call("GET", "/api/logins")).body.logins).toEqual([]);
    for (const answer of answers) for (const secret of [TOKEN, VAULT_PASSWORD]) expect(answer).not.toContain(secret);
  });

  it("takes changes as JSON only, so another page's form cannot post one", async () => {
    const { call } = await serve();
    expect((await call("POST", "/api/logins", { site: "example.com", password: PASSWORD }, "text/plain")).status).toBe(415);
    expect((await call("POST", "/api/logins/1password", { token: TOKEN }, "text/plain")).status).toBe(415);
  });
});
