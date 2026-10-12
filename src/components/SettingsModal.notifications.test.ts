// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { SettingsModal } from "./SettingsModal";

const fixture = vi.hoisted(() => ({
  optedIn: true,
  setMessageNotifications: vi.fn(),
  api: vi.fn(),
}));
vi.mock("@/state/store", async original => ({
  ...await original<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { appSettingsSection: "appearance", instances: [] }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" } } }) }));
vi.mock("@/lib/notification-preferences", () => ({
  useNotificationSounds: () => true,
  setNotificationSounds: vi.fn(),
  useMessageNotifications: () => fixture.optedIn,
  setMessageNotifications: fixture.setMessageNotifications,
}));

let root: Root | undefined;
let container: HTMLDivElement;
let permission: NotificationPermission;
const readPermission = vi.fn(() => permission);
const requestPermission = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fixture.optedIn = true;
  permission = "granted";
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", { get permission() { return readPermission(); }, requestPermission });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network in the notification settings fixture")));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container.remove();
  expect(fetch).not.toHaveBeenCalled();
  expect(fixture.api).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Browser notifications"]')!;
const mount = async () => { await act(async () => root!.render(createElement(StrictMode, null, createElement(SettingsModal)))); };
const resume = async (event: "visibilitychange" | "focus") => {
  await act(async () => (event === "focus" ? window : document).dispatchEvent(new Event(event)));
};

it.each(["visibilitychange", "focus"] as const)("refreshes external deny/grant on %s without remounting or prompting", async event => {
  await mount();
  const original = toggle();
  expect(original.getAttribute("aria-checked")).toBe("true");
  permission = "denied";
  await resume(event);
  expect(toggle()).toBe(original);
  expect(toggle().disabled).toBe(true);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("Notifications are blocked in your browser settings");
  permission = "granted";
  await resume(event);
  expect(toggle()).toBe(original);
  expect(toggle().disabled).toBe(false);
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).not.toContain("Notifications are blocked in your browser settings");
  expect(requestPermission).not.toHaveBeenCalled();
  expect(fixture.setMessageNotifications).not.toHaveBeenCalled();
});

it("preserves a muted preference when permission is granted elsewhere", async () => {
  fixture.optedIn = false;
  permission = "denied";
  await mount();
  expect(toggle().disabled).toBe(true);
  permission = "granted";
  await resume("visibilitychange");
  expect(toggle().disabled).toBe(false);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(requestPermission).not.toHaveBeenCalled();
  expect(fixture.setMessageNotifications).not.toHaveBeenCalled();
});

it("ignores hidden events and removes both listeners on unmount, including StrictMode replay", async () => {
  await mount();
  permission = "denied";
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await resume("visibilitychange");
  await resume("focus");
  expect(toggle().disabled).toBe(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await resume("focus");
  expect(toggle().disabled).toBe(true);
  await act(async () => root!.unmount());
  root = undefined;
  readPermission.mockClear();
  await resume("visibilitychange");
  await resume("focus");
  expect(readPermission).not.toHaveBeenCalled();
});
