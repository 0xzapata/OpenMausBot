import { describe, expect, it } from "vitest";

import { loginOriginCheck, loginUsableBy, normalizeLoginHost, savedLoginResumePrompt } from "./logins.ts";

describe("a login's host", () => {
  it.each([
    ["accounts.example.com", "accounts.example.com"],
    ["https://Accounts.Example.com/login?next=/", "accounts.example.com"],
    ["www.example.com", "www.example.com"],
    ["http://localhost:3000/sign-in", "localhost"],
    ["  example.com  ", "example.com"],
  ])("keeps %s exactly, as %s", (raw, host) => {
    expect(normalizeLoginHost(raw)).toBe(host);
  });

  it.each(["", "example", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/", "ftp://example.com", "exa mple.com", 42])(
    "refuses %s", (raw) => {
      expect(normalizeLoginHost(raw)).toBeNull();
    });
});

describe("the exact-origin check", () => {
  it("passes the saved host over https, and over http only on this computer", () => {
    expect(loginOriginCheck("https://example.com/login", "example.com")).toEqual({ ok: true, pageHost: "example.com" });
    expect(loginOriginCheck("https://EXAMPLE.com:8443/login", "example.com").ok).toBe(true);
    expect(loginOriginCheck("http://localhost:3000/", "localhost").ok).toBe(true);
    expect(loginOriginCheck("http://127.0.0.1:8080/", "127.0.0.1").ok).toBe(true);
  });

  it.each([
    ["a subdomain", "https://accounts.example.com/", "example.com", "host"],
    ["the parent", "https://example.com/", "accounts.example.com", "host"],
    ["www", "https://www.example.com/", "example.com", "host"],
    ["a look-alike", "https://example.com.evil.test/", "example.com", "host"],
    ["plain http", "http://example.com/", "example.com", "insecure"],
    ["a script address", "javascript:alert(1)", "example.com", "address"],
    ["no address", "not a url", "example.com", "address"],
  ])("refuses %s", (_name, url, host, reason) => {
    expect(loginOriginCheck(url, host)).toMatchObject({ ok: false, reason });
  });
});

describe("who may use a login", () => {
  it("is every bot, or the ones named", () => {
    expect(loginUsableBy({ bots: "all" }, "pepper")).toBe(true);
    expect(loginUsableBy({ bots: ["pepper"] }, "pepper")).toBe(true);
    expect(loginUsableBy({ bots: ["pepper"] }, "quill")).toBe(false);
  });
});

it("tells a resumed bot to call fill_login, never to ask for the password", () => {
  const prompt = savedLoginResumePrompt("accounts.example.com");
  expect(prompt).toContain("saved a login for accounts.example.com");
  expect(prompt).toContain("call fill_login");
  expect(prompt).toContain("Never ask for a password or a one-time code in chat.");
});
