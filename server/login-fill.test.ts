import { afterEach, describe, expect, it } from "vitest";

import { fillLogin, type FillCandidate, type FillLoginDeps } from "./login-fill.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";
import { parseTotpKey, totpCode, type TotpKey } from "./totp.ts";

// Obvious fakes only.
const PASSWORD = "fake-S3cret!pass";
const KEY = parseTotpKey("JBSWY3DPEHPK3PXP")!;
const NOW = 1_700_000_010_000; // 10 s into a 30 s step

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

type Login = { id?: string; host: string; username: string; password?: string; totp?: TotpKey | null };
function setup(url: string, html: string, saved: Login[]) {
  page = new FakeLoginPage(url, html);
  const remembered: Array<[string, string]> = [];
  const candidates = async (host: string): Promise<FillCandidate[]> => saved.filter((login) => login.host === host).map((login, index) => ({
    id: login.id ?? `login-${index}`, host: login.host, username: login.username, source: "settings",
    secrets: async () => ({ password: login.password ?? PASSWORD, totp: login.totp ?? null }),
  }));
  const deps: FillLoginDeps = {
    engine: (args) => page!.engine(args),
    insertText: (text) => page!.insertText(text),
    remember: (value, kind) => { remembered.push([kind, value]); },
    now: () => NOW,
    sleep: async () => undefined,
  };
  const fill = (username?: string) => fillLogin({
    username, candidates, available: async () => saved.map(({ host, username: name }) => ({ host, username: name })),
  }, deps);
  return { page, fill, remembered };
}

/** No value of any secret in what the bot hears, nor on any engine command line. */
function expectNoSecret(outcome: unknown, current: FakeLoginPage, secrets: string[]) {
  const said = JSON.stringify(outcome);
  const commands = JSON.stringify(current.engineCalls);
  for (const secret of secrets) {
    expect(said).not.toContain(secret);
    expect(commands).not.toContain(secret);
  }
}

describe("fill_login on a saved login's own page", () => {
  it("types the username and password into the form as real input, and tells the bot only what it filled", async () => {
    const { page, fill, remembered } = setup("https://accounts.example.com/login", LOGIN_FORM, [{ host: "accounts.example.com", username: "alice@example.com" }]);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, host: "accounts.example.com", filled: ["username", "password"] });
    expect(outcome.text).toBe("Filled the username and the password for alice@example.com on accounts.example.com. Submit the form now (its sign-in button, or Enter), then check you are signed in. You never see the password; do not read it back from the page.");
    expect(page.field("#email").value).toBe("alice@example.com");
    expect(page.field("#password").value).toBe(PASSWORD);
    // The page's own scripts saw typing, as a React form needs.
    expect(page.state).toMatchObject({ email: "alice@example.com", password: PASSWORD });
    expect(page.typed).toEqual(["alice@example.com", PASSWORD]);
    // The search box and the hidden field are left alone, and no mark stays behind.
    expect(page.field("input[name=q]").value).toBe("");
    expect(page.field("input[name=csrf]").value).toBe("token-not-a-secret");
    expect(page.window.document.querySelectorAll("[data-omb-login]")).toHaveLength(0);
    // The typing goes over the session's relay (browser-relay.ts): fill_login
    // itself asks the engine for no stream.
    expect(page.engineCalls.filter((args) => args[0] === "stream")).toEqual([]);
    expect(remembered).toContainEqual(["password", PASSWORD]);
    expectNoSecret(outcome, page, [PASSWORD]);
  });

  it("types over what a field already holds, and keeps a username that is already right", async () => {
    const { page, fill } = setup("https://accounts.example.com/login", LOGIN_FORM, [{ host: "accounts.example.com", username: "alice@example.com" }]);
    page.field("#email").value = "alice@example.com";
    page.field("#password").value = "stale";
    expect(await fill()).toMatchObject({ ok: true, filled: ["username", "password"] });
    expect(page.typed).toEqual([PASSWORD]);
    expect(page.field("#password").value).toBe(PASSWORD);
  });
});

describe("the exact-origin rule", () => {
  const saved = [{ host: "example.com", username: "alice" }];
  it.each([
    ["a subdomain", "https://accounts.example.com/login"],
    ["www", "https://www.example.com/login"],
    ["a look-alike host", "https://example.com.evil.test/login"],
    ["a host that only ends the same", "https://myexample.com/login"],
  ])("refuses %s of the saved host", async (_name, url) => {
    const { page, fill } = setup(url, LOGIN_FORM, saved);
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain(`No saved login for ${new URL(url).hostname}.`);
    expect(outcome.text).toContain("Your saved logins: example.com (alice).");
    expect(page.typed).toEqual([]);
    expect(page.engineCalls).toEqual([["get", "url"]]);
  });

  it("refuses the saved host over plain http", async () => {
    const { page, fill } = setup("http://example.com/login", LOGIN_FORM, saved);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.text).toContain("not secure (http, not https)");
    expect(page.typed).toEqual([]);
  });

  it("allows plain http on this computer, for a developer's own app", async () => {
    const { fill } = setup("http://localhost:3000/login", LOGIN_FORM, [{ host: "localhost", username: "dev" }]);
    expect(await fill()).toMatchObject({ ok: true, filled: ["username", "password"] });
  });

  it("stops when the page leaves the host between finding the fields and typing", async () => {
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, saved);
    const engine = page.engine.bind(page);
    let evals = 0;
    page.engine = async (args) => {
      if (args[0] === "eval" && ++evals === 2) page.navigate("https://evil.test/login", LOGIN_FORM);
      return engine(args);
    };
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("moved away from example.com");
    expect(page.typed).toEqual([]);
  });

  it("says when no browser page is open", async () => {
    const { page, fill } = setup("about:blank", "", saved);
    expect((await fill()).text).toBe("The browser has no page open. Open the site's login page first, then call fill_login.");
    expect(page.typed).toEqual([]);
  });
});

describe("two-step logins and one-time codes", () => {
  it("fills the username alone, then the password on the next page", async () => {
    const { page, fill } = setup("https://login.example.com/", `<form><input name="identifier" type="email" autocomplete="username"><button>Next</button></form>`,
      [{ host: "login.example.com", username: "alice@example.com" }]);
    const first = await fill();
    expect(first).toMatchObject({ ok: true, filled: ["username"] });
    expect(first.text).toContain("Go on to the next step (such as Next or Continue), then call fill_login again for the password.");
    expect(page.typed).toEqual(["alice@example.com"]);
    page.navigate("https://login.example.com/challenge", `<form><input name="Passwd" type="password"><button>Next</button></form>`);
    const second = await fill();
    expect(second).toMatchObject({ ok: true, filled: ["password"] });
    expect(page.field("input[name=Passwd]").value).toBe(PASSWORD);
  });

  it("fills a one-time code made at fill time from the saved 2FA key, and remembers it for the scrubber", async () => {
    const { page, fill, remembered } = setup("https://example.com/2fa", `<form><input name="otp" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>`,
      [{ host: "example.com", username: "alice", totp: KEY }]);
    const code = totpCode(KEY, NOW);
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["code"] });
    expect(page.field("input[name=otp]").value).toBe(code);
    expect(remembered).toContainEqual(["code", code]);
    expectNoSecret(outcome, page, [PASSWORD, code, KEY.secret]);
  });

  it("fills six one-digit boxes one digit each", async () => {
    const boxes = Array.from({ length: 6 }, (_, index) => `<input name="d${index}" maxlength="1" inputmode="numeric" ${index === 0 ? 'autocomplete="one-time-code"' : ""}>`).join("");
    const { page, fill } = setup("https://example.com/2fa", `<form><div class="code">${boxes}</div></form>`, [{ host: "example.com", username: "alice", totp: KEY }]);
    expect(await fill()).toMatchObject({ ok: true, filled: ["code"] });
    expect(Array.from({ length: 6 }, (_, index) => page.field(`input[name=d${index}]`).value).join("")).toBe(totpCode(KEY, NOW));
  });

  it("sends the person in when a code is asked for and no 2FA key is saved", async () => {
    const { page, fill } = setup("https://example.com/2fa", `<input name="verification_code">`, [{ host: "example.com", username: "alice" }]);
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("asks for a one-time code, and the saved login has no 2FA key. Call request_sign_in");
    expect(page.typed).toEqual([]);
  });

  it("never takes a sign-up form's new-password box for the login's password", async () => {
    const { page, fill } = setup("https://example.com/join", `<form><input name="email" type="email"><input name="new" type="password" autocomplete="new-password"></form>`,
      [{ host: "example.com", username: "alice@example.com" }]);
    expect(await fill()).toMatchObject({ ok: true, filled: ["username"] });
    expect(page.field("input[name=new]").value).toBe("");
  });
});

describe("choosing a login, and pages with nothing to fill", () => {
  it("asks which login when a site has several, and fills the one named", async () => {
    const saved = [{ host: "example.com", username: "alice", password: "fake-alice-pw" }, { host: "example.com", username: "bob", password: "fake-bob-pw" }];
    const { page, fill } = setup("https://example.com/login", LOGIN_FORM, saved);
    const asked = await fill();
    expect(asked.ok).toBe(false);
    expect(asked.text).toBe("There are 2 saved logins for example.com: alice, bob. Call fill_login again with the username to use.");
    expect(await fill("Bob")).toMatchObject({ ok: true });
    expect(page.field("#password").value).toBe("fake-bob-pw");
    expect((await fill("carol")).text).toContain('has the username "carol"');
  });

  it("says when the page has no login fields", async () => {
    const { page, fill } = setup("https://example.com/", `<main><input type="search" name="q"><input type="hidden" name="x"></main>`, [{ host: "example.com", username: "alice" }]);
    const outcome = await fill();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("No login fields found on example.com.");
    expect(page.typed).toEqual([]);
  });

  it("ignores fields that are hidden from view", async () => {
    const { page, fill } = setup("https://example.com/login",
      `<form style="display:none"><input name="email" type="email"><input name="password" type="password"></form><form><input name="user" type="text" autocomplete="username"></form>`,
      [{ host: "example.com", username: "alice" }]);
    expect(await fill()).toMatchObject({ ok: true, filled: ["username"] });
    expect(page.field("input[name=password]").value).toBe("");
  });
});
