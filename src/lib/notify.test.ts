import { afterEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({ enabled: true, messages: true }));
vi.mock("./notification-preferences", () => ({
  notificationSoundsEnabled: () => sounds.enabled,
  messageNotificationsEnabled: () => sounds.messages,
}));

import {
  buildNotificationOptions,
  initNotificationServiceWorker,
  takeNotificationTarget,
  requestNotificationPermission,
  showNotification,
  type NotifyFrame,
} from "./notify";

const frame: NotifyFrame = {
  kind: "done",
  botId: "bot-1",
  botName: "Maus",
  threadId: "thread-1",
  title: "Maus finished",
  body: "All done",
};

function installNotification(permission: NotificationPermission, focused = false) {
  const notices: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(public title: string, public options?: NotificationOptions) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hasFocus: () => focused });
  vi.stubGlobal("window", { focus: vi.fn() });
  return { notices, requestPermission };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sounds.enabled = true;
  sounds.messages = true;
});

describe("desktop notifications", () => {
  it("does not request permission from a background notification frame", () => {
    const { notices, requestPermission } = installNotification("default");
    showNotification(frame, vi.fn());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
  });

  it("requests permission through the explicit settings action", async () => {
    const { requestPermission } = installNotification("default");
    await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("contains rejected and synchronous permission failures so Settings can retry", async () => {
    const { requestPermission } = installNotification("default");
    requestPermission.mockRejectedValueOnce(new Error("blocked"));
    await expect(requestNotificationPermission()).resolves.toBe("default");
    requestPermission.mockImplementationOnce(() => { throw new Error("unavailable"); });
    await expect(requestNotificationPermission()).resolves.toBe("default");
    await expect(requestNotificationPermission()).resolves.toBe("granted");
  });

  it("reads fresh permission when browser settings changed while Settings stayed mounted", async () => {
    const { requestPermission } = installNotification("granted");
    await expect(requestNotificationPermission()).resolves.toBe("granted");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("mutes completion notifications without hiding required approval, sign-in or spend notices", () => {
    const { notices } = installNotification("granted");
    sounds.messages = false;
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(0);
    showNotification({ ...frame, kind: "approval" }, vi.fn());
    showNotification({ ...frame, kind: "sign-in" }, vi.fn());
    showNotification({ ...frame, kind: "spend" }, vi.fn());
    expect(notices).toHaveLength(3);
  });

  it("shows a notification after permission is granted", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: frame.title, options: { body: frame.body, tag: `openmausbot:${frame.botId}` } });
  });

  it("stays quiet only when the exact target thread is already visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, frame.threadId);

    expect(notices).toHaveLength(0);
  });

  it("shows a spend notice even over the thread it points at, in its own stack", () => {
    const { notices } = installNotification("granted", true);

    showNotification({ ...frame, kind: "spend", title: "Monthly spend limit reached" }, vi.fn(), "https://avatar.test/a.png", frame.threadId);

    expect(notices).toHaveLength(1);
    expect(notices[0]!.options).toMatchObject({ tag: "openmausbot:spend", icon: undefined });
  });

  it("still alerts a focused app when another task is visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, "another-thread");

    expect(notices).toHaveLength(1);
  });

  it("opens the exact detached task carried by the notification", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();

    showNotification({ ...frame, threadId: "detached-routine-thread" }, onOpen);
    notices[0]!.onclick?.();

    expect(window.focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith({
      botId: frame.botId,
      threadId: "detached-routine-thread",
    });
  });

  it("groups under the bot, not the thread", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn());
    showNotification(
      { ...frame, threadId: "thread-2", body: "Second task done" },
      vi.fn(),
    );

    // one bot across two threads shares a tag, so the platform replaces
    // rather than stacks; another bot gets its own key
    expect(notices[0]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    expect(notices[1]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    showNotification({ ...frame, botId: "bot-2" }, vi.fn());
    expect(notices[2]?.options?.tag).toBe(`openmausbot:bot-2`);
  });

  it("carries the bot's avatar when its profile has one", () => {
    const { notices } = installNotification("granted");
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png";

    showNotification(frame, vi.fn(), avatarUrl);
    expect(notices[0]?.options?.icon).toBe(avatarUrl);

    showNotification(frame, vi.fn(), null);
    expect(notices[1]?.options?.icon).toBeUndefined();
  });
});

describe("notification-only worker", () => {
  function worker() {
    const sw = Object.assign(new EventTarget(), {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async (): Promise<unknown> => undefined),
    });
    const registration = {
      active: { scriptURL: "https://workspace.test/sw.js", state: "activated" },
      showNotification: vi.fn(async () => {}),
    };
    vi.stubGlobal("navigator", { serviceWorker: sw });
    vi.stubGlobal("location", new URL("https://workspace.test/"));
    return { sw, registration };
  }

  it("never registers on mount and disposes click listeners across remounts", () => {
    installNotification("default");
    const { sw } = worker();
    const first = vi.fn();
    const dispose = initNotificationServiceWorker(first);
    expect(sw.register).not.toHaveBeenCalled();
    dispose();
    const second = vi.fn();
    const stop = initNotificationServiceWorker(second);
    sw.dispatchEvent(new MessageEvent("message", { data: { type: "openmausbot:notification-click", target: { botId: 123, threadId: "thread-1" } } }));
    expect(second).not.toHaveBeenCalled();
    sw.dispatchEvent(new MessageEvent("message", { data: { type: "openmausbot:notification-click", target: { botId: "bot-1", threadId: "thread-1" } } }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    stop();
  });

  it("lazily displays mobile notifications in a dedicated scope with the exact click target", async () => {
    installNotification("granted");
    const { sw, registration } = worker();
    vi.stubGlobal("Notification", class {
      static permission = "granted";
      constructor() { throw new TypeError("Use ServiceWorkerRegistration on mobile"); }
    });
    showNotification(frame, vi.fn());
    await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledOnce());
    expect(sw.register).toHaveBeenCalledWith("/sw.js", { scope: "/notifications/" });
    expect(registration.showNotification).toHaveBeenCalledWith(frame.title, expect.objectContaining({ data: { botId: frame.botId, threadId: frame.threadId } }));
  });

  it("does not replace an unrelated worker or use its ready promise", async () => {
    installNotification("granted");
    const { sw, registration } = worker();
    sw.getRegistration.mockResolvedValueOnce({ active: { scriptURL: "https://workspace.test/other-worker.js" } });
    vi.stubGlobal("Notification", class {
      static permission = "granted";
      constructor() { throw new TypeError("mobile"); }
    });
    showNotification(frame, vi.fn());
    await vi.waitFor(() => expect(sw.getRegistration).toHaveBeenCalled());
    expect(sw.register).not.toHaveBeenCalled();
    expect(registration.showNotification).not.toHaveBeenCalled();
  });

  it("waits for first worker activation, without waiting for page control", async () => {
    installNotification("granted");
    const { sw, registration } = worker();
    const installing = Object.assign(new EventTarget(), { state: "installing", scriptURL: "https://workspace.test/sw.js" });
    sw.getRegistration.mockResolvedValueOnce({ active: null, installing, showNotification: registration.showNotification });
    vi.stubGlobal("Notification", class {
      static permission = "granted";
      constructor() { throw new TypeError("mobile"); }
    });
    showNotification(frame, vi.fn());
    await vi.waitFor(() => expect(sw.getRegistration).toHaveBeenCalledOnce());
    expect(registration.showNotification).not.toHaveBeenCalled();
    installing.state = "activated";
    installing.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledOnce());
    expect(sw.register).not.toHaveBeenCalled();
  });

  it("contains registration failures without unhandled rejection", async () => {
    installNotification("granted");
    const { sw, registration } = worker();
    sw.register.mockRejectedValueOnce(new Error("insecure origin"));
    vi.stubGlobal("Notification", class {
      static permission = "granted";
      constructor() { throw new TypeError("mobile"); }
    });
    showNotification(frame, vi.fn());
    await vi.waitFor(() => expect(sw.register).toHaveBeenCalledOnce());
    expect(registration.showNotification).not.toHaveBeenCalled();
  });

  it("consumes only a valid cold-start notification fragment", () => {
    const target = { botId: "bot-1", threadId: "thread-1" };
    const history = { state: null, replaceState: vi.fn() };
    vi.stubGlobal("history", history);
    vi.stubGlobal("location", new URL(`https://workspace.test/#notification=${encodeURIComponent(JSON.stringify(target))}`));
    expect(takeNotificationTarget()).toEqual(target);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    for (const fragment of ["#notification=%FF", "#notification=%7B%7D", "#unrelated=thing"]) {
      vi.stubGlobal("location", new URL(`https://workspace.test/${fragment}`));
      expect(takeNotificationTarget()).toBeNull();
    }
  });
});

describe("notification sounds", () => {
  it("lets the platform play its sound by default", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices[0]?.options?.silent).toBeUndefined();
  });

  it("posts silently when sounds are muted on this computer, keeping the banner", () => {
    sounds.enabled = false;
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]?.options).toMatchObject({ body: frame.body, silent: true });
  });
});

describe("buildNotificationOptions", () => {
  it("keys coalescing on botId and omits a missing avatar", () => {
    expect(buildNotificationOptions({ id: "bot-9" })).toEqual({
      tag: "openmausbot:bot-9",
      icon: undefined,
    });
  });
});
