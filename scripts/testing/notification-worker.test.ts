import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const target = { botId: "scout", threadId: "detached-task" };

function fixture(clients: Array<{ url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }> = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: "https://workspace.test" },
    addEventListener: (name: string, listener: (event: unknown) => void) => handlers.set(name, listener),
    clients: { matchAll: vi.fn(async () => clients), openWindow },
  };
  runInNewContext(source, { self, URL, encodeURIComponent });
  const click = async (data: unknown = target) => {
    const close = vi.fn();
    let pending: Promise<unknown> | undefined;
    handlers.get("notificationclick")!({ notification: { data, close }, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
    expect(close).toHaveBeenCalledOnce();
  };
  return { handlers, openWindow, click };
}

describe("notification worker", () => {
  it("does not claim pages or intercept/cache their network traffic", () => {
    expect([...fixture().handlers.keys()]).toEqual(["notificationclick"]);
  });

  it("focuses a workspace window, not an unrelated app on the origin", async () => {
    const other = { url: "https://workspace.test/another-app/", focus: vi.fn(), postMessage: vi.fn() };
    const workspace = { url: "https://workspace.test/", focus: vi.fn(), postMessage: vi.fn() };
    const { click, openWindow } = fixture([other, workspace]);
    await click();
    expect(other.focus).not.toHaveBeenCalled();
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(workspace.postMessage).toHaveBeenCalledWith({ type: "openmausbot:notification-click", target });
    expect(workspace.focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("retains the exact destination when it has to launch a new workspace window", async () => {
    const { click, openWindow } = fixture();
    await click();
    expect(openWindow).toHaveBeenCalledWith(`/#notification=${encodeURIComponent(JSON.stringify(target))}`);
  });

  it("ignores malformed notification data", async () => {
    const { click, openWindow } = fixture();
    await click({ botId: 42, threadId: "task" });
    await click(null);
    expect(openWindow).not.toHaveBeenCalled();
  });
});
