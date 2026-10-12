// @vitest-environment happy-dom
// Settings → Logins: the list says where each login works and as whom,
// never its password; Add and Change send what was typed once and forget
// it; Delete asks a second click.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), admin: true as boolean | null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { bots: [{ id: "pepper", name: "Pepper" }, { id: "quill", name: "Quill" }] }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
const { LoginsSettings } = await import("./LoginsSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const CARD_LOGIN = { id: "l1", host: "accounts.example.com", username: "alice@example.com", hasTotp: true, source: "card", bots: ["pepper"], createdAt: 1, lastUsedAt: Date.now() - 120_000 };
const SHARED_LOGIN = { id: "l2", host: "crm.example.org", username: "team", hasTotp: false, source: "settings", bots: "all", createdAt: 2 };

beforeEach(() => {
  fixture.api.mockReset();
  fixture.admin = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => root.render(createElement(LoginsSettings)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function type(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { host.querySelector("form")!.requestSubmit(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Settings → Logins", () => {
  it("lists each login by site, username, 2FA, source, who may use it and last use", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN, SHARED_LOGIN] });
    await render();
    expect(fixture.api).toHaveBeenCalledWith("/api/logins");
    const rows = [...host.querySelectorAll("[data-login-row]")].map((row) => row.textContent);
    expect(rows[0]).toContain("accounts.example.com");
    expect(rows[0]).toContain("alice@example.com");
    expect(rows[0]).toContain("2FA");
    expect(rows[0]).toContain("Saved from a chat · Pepper · Used 2 min ago");
    expect(rows[1]).toContain("Added here · All bots · Not used yet");
    expect(host.querySelectorAll("input")).toHaveLength(0);
  });

  it("adds a login for the bots chosen, and keeps nothing it was typed once saved", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [] }).mockResolvedValueOnce({ login: SHARED_LOGIN }).mockResolvedValueOnce({ logins: [SHARED_LOGIN] });
    await render();
    expect(host.textContent).toContain("No saved logins yet.");
    await click("Add login");
    await type("site", "crm.example.org");
    await type("username", "team");
    await type("password", "fake-typed-pass");
    await act(async () => { [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!.click(); });
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins", { method: "POST", body: JSON.stringify({ site: "crm.example.org", username: "team", password: "fake-typed-pass", bots: ["pepper"] }) });
    expect(host.querySelector("form")).toBeNull();
    expect(host.innerHTML).not.toContain("fake-typed-pass");
  });

  it("replaces a password, keeps the 2FA key unless asked, and changes who may use it", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN] }).mockResolvedValueOnce({ login: CARD_LOGIN }).mockResolvedValueOnce({ logins: [CARD_LOGIN] });
    await render();
    await click("Change the login for accounts.example.com");
    // Only the secrets and the picker: the password field is empty, as there is nothing to show.
    expect(host.querySelector<HTMLInputElement>('input[name="password"]')!.value).toBe("");
    await type("password", "fake-new-pass");
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/l1", { method: "PATCH", body: JSON.stringify({ password: "fake-new-pass", bots: "all" }) });
  });

  it("deletes only on a second click", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN] }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ logins: [] });
    await render();
    await click("Delete the login for accounts.example.com");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    await click("Delete for good");
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/l1", { method: "DELETE" });
  });

  it("is for admins only", async () => {
    fixture.admin = false;
    await render();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Only an admin of this installation can see and change saved logins.");
  });
});
