import { afterEach, describe, expect, it } from "vitest";

import { fillLogin, type FillCandidate } from "./login-fill.ts";
import { loginFields, OnePasswordLogins, onePasswordProblem, sdkOnePasswordClient } from "./onepassword.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";
import { fakeOnePasswordSdk } from "./testing/fake-onepassword.ts";
import { parseTotpKey, totpCode } from "./totp.ts";

// Obvious fakes only; no network.
const TOKEN = "ops_fake-service-account-token";
const VAULT_PASSWORD = "fake-1P-Passw0rd";
const KEY = "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example";

function setup(options: { token?: string | null; fail?: () => Error | null; now?: () => number } = {}) {
  const { sdk, calls } = fakeOnePasswordSdk({
    token: TOKEN,
    fail: options.fail,
    vaults: {
      v1: { title: "Shared with OMB", items: [
        { id: "i1", title: "Example", urls: ["https://accounts.example.com/login", "accounts.example.com"], username: "alice@example.com", password: VAULT_PASSWORD, totp: KEY },
        { id: "i2", title: "Two sites", urls: ["https://crm.example.org", "https://www.crm.example.org/"], username: "team", password: "fake-crm-pass" },
        { id: "i3", title: "No website", urls: [], username: "x", password: "fake-x-pass" },
        { id: "i4", title: "A note", category: "SecureNote", urls: ["https://notes.example.com"] },
        { id: "i5", title: "No password", urls: ["https://empty.example.com"], username: "nobody" },
      ] },
    },
  });
  let token: string | null = options.token === undefined ? TOKEN : options.token;
  const source = new OnePasswordLogins({ token: () => token, connect: (value) => sdkOnePasswordClient(sdk, value, "9.9.9"), now: options.now });
  return { source, calls, setToken: (value: string | null) => { token = value; } };
}

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

describe("the 1Password SDK adapter", () => {
  it("reads a Login item's username, password and one-time-password field, by id first, then by type and title", () => {
    expect(loginFields([
      { id: "username", title: "username", fieldType: "Text", value: "alice" },
      { id: "password", title: "password", fieldType: "Concealed", value: "fake-pw" },
      { id: "x", title: "one-time password", fieldType: "Totp", value: KEY },
    ])).toEqual({ username: "alice", password: "fake-pw", totp: KEY });
    expect(loginFields([
      { id: "a", title: "Email", fieldType: "Email", value: "bob@example.com" },
      { id: "b", title: "Password", fieldType: "Concealed", value: "fake-pw-2" },
    ])).toEqual({ username: "bob@example.com", password: "fake-pw-2", totp: null });
    // The built-in username field wins over another field that only looks like one.
    expect(loginFields([
      { id: "x", title: "Email", fieldType: "Email", value: "other@example.com" },
      { id: "username", title: "Account", fieldType: "Text", value: "alice" },
      { id: "password", title: "Password", fieldType: "Concealed", value: "fake-pw-3" },
    ]).username).toBe("alice");
    expect(loginFields([])).toEqual({ username: "", password: "", totp: null });
  });
});

describe("1Password logins", () => {
  it("lists every Login item with a website and a password, by exact host, read-only and for every bot", async () => {
    const { source, calls } = setup();
    expect(await source.refresh()).toEqual({ connected: true, vaults: ["Shared with OMB"], items: 2 });
    expect(calls).toEqual(["createClient OpenMausBot", "vaults.list", "items.list v1", "items.getAll v1 i1,i2,i5"]);
    const rows = source.list();
    expect(rows.map((row) => [row.host, row.username, row.hasTotp, row.source, row.bots])).toEqual([
      ["accounts.example.com", "alice@example.com", true, "1password", "all"],
      ["crm.example.org", "team", false, "1password", "all"],
      ["www.crm.example.org", "team", false, "1password", "all"],
    ]);
    expect(JSON.stringify(rows)).not.toContain(VAULT_PASSWORD);
    expect(JSON.stringify(source.status())).not.toContain(TOKEN);
    expect(source.hosts()).toContainEqual({ host: "accounts.example.com", username: "alice@example.com" });
  });

  it("offers a login only on its exact host, and reads its password and 2FA key from 1Password at fill time", async () => {
    const { source, calls } = setup();
    await source.refresh();
    expect(source.candidates("example.com")).toEqual([]);
    expect(source.candidates("login.accounts.example.com")).toEqual([]);
    const [candidate] = source.candidates("accounts.example.com");
    expect(candidate).toMatchObject({ host: "accounts.example.com", username: "alice@example.com", source: "1password" });
    calls.length = 0;
    expect(await candidate!.secrets()).toEqual({ password: VAULT_PASSWORD, totp: parseTotpKey(KEY) });
    expect(calls).toEqual(["items.getAll v1 i1"]);
  });

  it("is filled through the same path as a saved login: same origin rule, same TOTP, nothing back to the bot", async () => {
    const { source } = setup();
    await source.refresh();
    const now = 1_700_000_010_000;
    page = new FakeLoginPage("https://accounts.example.com/login", `${LOGIN_FORM}<input name="otp" autocomplete="one-time-code">`);
    const remembered: string[] = [];
    const saved: FillCandidate = { id: "local", host: "other.example.com", username: "local", source: "settings", secrets: async () => ({ password: "fake-local", totp: null }) };
    const fill = () => fillLogin({
      candidates: async (host) => [...[saved].filter((login) => login.host === host), ...source.candidates(host)],
      available: async () => [{ host: saved.host, username: saved.username }, ...source.hosts()],
    }, {
      engine: (args) => page!.engine(args), insertText: (port, text) => page!.insertText(port, text),
      remember: (value) => { remembered.push(value); }, now: () => now, sleep: async () => undefined,
    });
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password", "code"] });
    expect(outcome.text).toContain("for alice@example.com (from 1Password) on accounts.example.com.");
    expect(page.field("#password").value).toBe(VAULT_PASSWORD);
    expect(page.field("input[name=otp]").value).toBe(totpCode(parseTotpKey(KEY)!, now));
    // The scrubber learns the filled password and code; the bot learns neither.
    expect(remembered).toEqual(expect.arrayContaining([VAULT_PASSWORD, totpCode(parseTotpKey(KEY)!, now)]));
    expect(JSON.stringify(outcome)).not.toContain(VAULT_PASSWORD);
    expect(JSON.stringify(page.engineCalls)).not.toContain(VAULT_PASSWORD);

    // The exact-host rule holds for 1Password's logins too.
    page.navigate("https://example.com/login", LOGIN_FORM);
    const typed = page.typed.length;
    const refused = await fill();
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("No saved login for example.com.");
    expect(page.typed).toHaveLength(typed);
  });

  it("refuses a token 1Password does not accept, in words, without keeping anything", async () => {
    const { source } = setup({ token: null });
    await expect(source.refresh("ops_wrong-fake-token")).rejects.toThrow("1Password did not accept the token.");
    expect(source.status()).toEqual({ connected: false });
    expect(source.list()).toEqual([]);
  });

  it("keeps what it read, and says why, when 1Password stops answering", async () => {
    let failure: Error | null = null;
    const { source } = setup({ fail: () => failure });
    await source.refresh();
    failure = Object.assign(new Error("rate limit exceeded"), { name: "RateLimitExceededError" });
    expect(await source.refresh()).toMatchObject({ connected: true, error: "1Password is limiting requests right now. Try again in a few minutes." });
    expect(source.list()).toHaveLength(3);
    expect(onePasswordProblem(new Error("getaddrinfo ENOTFOUND my.1password.com"))).toBe("Could not reach 1Password. Check the internet connection and try again.");
  });

  it("reads 1Password again only once its index is stale, and forgets everything when disconnected", async () => {
    let now = 0;
    const { source, calls, setToken } = setup({ now: () => now });
    await source.fresh();
    expect(calls.filter((call) => call === "vaults.list")).toHaveLength(1);
    now = 5 * 60_000;
    await source.fresh();
    expect(calls.filter((call) => call === "vaults.list")).toHaveLength(1);
    now = 11 * 60_000;
    await source.fresh();
    expect(calls.filter((call) => call === "vaults.list")).toHaveLength(2);
    // The token gone is enough: nothing read with it is offered any more.
    setToken(null);
    expect(source.list()).toEqual([]);
    expect(source.hosts()).toEqual([]);
    expect(source.candidates("accounts.example.com")).toEqual([]);
    source.clear();
    expect(source.list()).toEqual([]);
    expect(source.candidates("accounts.example.com")).toEqual([]);
    expect(source.status()).toEqual({ connected: false });
  });
});
