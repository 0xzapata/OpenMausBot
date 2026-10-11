// @vitest-environment happy-dom
// A notification's click opens its thread as the sidebar shows threads at
// that moment. With threads hidden a bot is one conversation, and a sibling
// is reached only through its activity row while it is unread: following a
// notification to another thread must not pass the reply in the thread the
// bot was left on as read. With threads shown nothing changed. The real
// provider, its live stream and the real display preference.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import type { BotAnnouncement } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}
class FixtureNotification {
  static permission = "granted";
  static shown: FixtureNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(readonly title: string) { FixtureNotification.shown.push(this); }
}

// The person is in another bot's chat. Scout was left on "left-behind",
// where a routine's reply landed unread; the person last wrote in
// "main-chat"; "finished" is the side job the notification is about.
const elsewhere: BotAnnouncement = {
  id: "other", threadId: "other-chat", name: "Other", title: "", description: "", notifications: true, unread: false,
  color: "blue", modelSelection: { instanceId: "fake", model: "m" }, tasks: [{ threadId: "other-chat", title: "Chat", createdAt: 1 }],
};
const scout: BotAnnouncement = {
  id: "scout", threadId: "left-behind", mainThreadId: "main-chat", name: "Scout", title: "", description: "",
  notifications: true, unread: true, color: "green", modelSelection: { instanceId: "fake", model: "m" },
  tasks: [
    { threadId: "left-behind", title: "Routine report", createdAt: 1, unread: true },
    { threadId: "main-chat", title: "Main chat", createdAt: 2 },
    { threadId: "finished", title: "Side job", createdAt: 3, unread: true },
  ],
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const requests: Array<{ path: string; body?: string }> = [];

const { StoreProvider } = await import("./store");
const { setAdvancedMode } = await import("@/lib/interface-mode");
const { setShowThreads } = await import("@/lib/thread-preferences");

let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const stream = () => FixtureEventSource.opened.at(-1)!;

beforeAll(() => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("Notification", FixtureNotification);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    requests.push({ path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (path.startsWith("/api/bots?")) return json({ bots: [elsewhere, scout], groups: [] });
    if (path.startsWith("/api/bots/scout/tasks/finished")) return json({ bot: { ...scout, threadId: "finished", messages: [] } });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    if (path === "/api/instances") return json({ instances: [] });
    return json({});
  });
});
afterAll(() => vi.unstubAllGlobals());
// Each test starts from the app as it opens: in the other bot's chat.
beforeEach(async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, null)));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  requests.length = 0;
  FixtureNotification.shown.length = 0;
});
afterEach(() => flushSync(() => root.unmount()));

/** Scout's side job finished; the person clicks the notification. */
async function followNotification() {
  const frame: ServerFrame = { kind: "notify", notification: { kind: "done", botId: "scout", botName: "Scout", threadId: "finished", title: "Scout finished", body: "Side job done." } };
  stream().send(frame, "run:1");
  await settle();
  expect(FixtureNotification.shown).toHaveLength(1);
  FixtureNotification.shown[0]!.onclick!();
  await settle();
  return requests.map((request) => request.body ? `${request.path} ${request.body}` : request.path);
}

describe("following a notification", () => {
  it("opens its thread by the switch alone while threads are hidden, leaving the reply the bot was left on unread", async () => {
    flushSync(() => { setAdvancedMode(true); setShowThreads(false); });
    const sent = await followNotification();
    expect(sent.filter((request) => request.startsWith("/api/bots/scout/tasks/finished"))).toHaveLength(1);
    expect(sent.filter((request) => request.startsWith("/api/bots/scout/read"))).toEqual([]);
  });

  it("selects the bot first while threads are shown, as it always has", async () => {
    flushSync(() => { setAdvancedMode(true); setShowThreads(true); });
    const sent = await followNotification();
    expect(sent).toContain('/api/bots/scout/read {"threadId":"left-behind"}');
    expect(sent.filter((request) => request.startsWith("/api/bots/scout/tasks/finished"))).toHaveLength(1);
  });
});
