// The guard index.ts built once per request for every bot route that takes
// a threadId: the store once, then who is asking and the request's headers
// per request. One copy, shared by the bot route modules (bot-settings.ts,
// bot-patch.ts, bot-messages.ts).
import type { IncomingMessage } from "node:http";

import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";

export function pinnedClientThreadGuard(store: Pick<Store, "tasks">) {
  return (auth: RequestAuth, req: IncomingMessage) => {
    // Paired sessions are authenticated above. The companion marker may
    // only narrow behavior (including its capability-free local dev proxy);
    // it never grants authority or replaces the existing request gate.
    const requirePinnedClientThread = (botId: string, threadId: unknown): void => {
      if (threadId === undefined &&
        (auth.kind === "session" || req.headers["x-openmausbot-companion"] === "1") &&
        store.tasks(botId).length > 1) {
        throw Object.assign(new Error("This bot has more than one thread. Update the OpenMausBot app on this device, then choose a thread and try again."), { status: 409 });
      }
    };
    return requirePinnedClientThread;
  };
}
