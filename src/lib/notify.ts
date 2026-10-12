// Desktop and mobile notifications, driven by the harness's {kind:"notify"} frames
// and new message arrivals.
import type { Notification } from "../../shared/notification";
import { messageNotificationsEnabled, notificationSoundsEnabled } from "./notification-preferences";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** Ask while handling the settings click. Browsers may reject permission
 * requests that are triggered later by an incoming SSE frame. */
export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (typeof Notification === "undefined") return null;
  try {
    return Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  } catch {
    // Leave the explicit Settings action available after a browser refusal.
    return Notification.permission;
  }
}

function notificationTarget(value: unknown): value is NotificationTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<NotificationTarget>;
  return typeof target.botId === "string" && target.botId.length > 0 &&
    typeof target.threadId === "string" && target.threadId.length > 0;
}

/** The worker carries a cold-start destination in the fragment, never to the server. */
export function takeNotificationTarget(): NotificationTarget | null {
  if (typeof location === "undefined" || !location.hash.startsWith("#notification=")) return null;
  const encoded = location.hash.slice("#notification=".length);
  history.replaceState(history.state, "", location.pathname + location.search);
  try {
    const target: unknown = JSON.parse(decodeURIComponent(encoded));
    return notificationTarget(target) ? target : null;
  } catch {
    return null;
  }
}

/** Listening is side-effect free; worker registration happens only for a granted notification. */
export function initNotificationServiceWorker(onOpen: (target: NotificationTarget) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const serviceWorker = navigator.serviceWorker;
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === "openmausbot:notification-click" && notificationTarget(event.data.target)) {
      window.focus();
      onOpen(event.data.target);
    }
  };
  serviceWorker.addEventListener("message", onMessage);
  return () => serviceWorker.removeEventListener("message", onMessage);
}

async function showMobileNotification(title: string, options: NotificationOptions): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const serviceWorker = navigator.serviceWorker;
  // A notification-only scope cannot take over the PWA, API or another app's worker.
  const scope = "/notifications/";
  const existing = await serviceWorker.getRegistration(scope);
  const scriptURL = new URL("/sw.js", location.href).href;
  if (existing && [existing.active, existing.waiting, existing.installing].some((worker) => worker && worker.scriptURL !== scriptURL)) return;
  const registration = existing ?? await serviceWorker.register("/sw.js", { scope });
  const worker = registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) return;
  if (worker.state !== "activated") {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        worker.removeEventListener("statechange", changed);
        if (error) reject(error); else resolve();
      };
      const changed = () => {
        if (worker.state === "activated") finish();
        else if (worker.state === "redundant") finish(new Error("Notification worker unavailable"));
      };
      const timer = setTimeout(() => finish(new Error("Notification worker activation timed out")), 10_000);
      worker.addEventListener("statechange", changed);
      changed();
    });
  }
  await registration.showNotification(title, options);
}

/** The identity a notification groups under: one bot, wherever it was
 * working. Keyed by bot rather than thread so a single bot running across
 * tasks and rooms coalesces into one stack instead of stacking banners. */
export interface NotificationBotIdentity {
  id: string;
  avatarUrl?: string | null;
}

/** Presentation options for one bot's notifications: the stable per-bot
 * coalescing key platforms replace on (`tag`) and its avatar, when the
 * profile has one. Pure so the grouping rule stays testable on its own. */
export function buildNotificationOptions(bot: NotificationBotIdentity): NotificationOptions {
  return { tag: `openmausbot:${bot.id}`, icon: bot.avatarUrl ?? undefined };
}

function fallbackNotification(
  title: string,
  options: NotificationOptions,
  open: () => void,
) {
  try {
    const notification = new Notification(title, options);
    notification.onclick = open;
  } catch {
    // Mobile browsers reject the constructor, even after explicit permission.
    void showMobileNotification(title, options).catch(() => {});
  }
}

/** Show one unless the exact destination conversation is already visible.
 * A focused app may still be showing another task (routine runs are detached),
 * so window focus alone is not proof that the actionable card can be seen. */
export function showNotification(
  frame: NotifyFrame,
  onOpen: (target: NotificationTarget) => void,
  avatarUrl?: string | null,
  visibleThreadId?: string | null,
) {
  if (typeof Notification === "undefined") return;
  if (frame.kind === "done" && !messageNotificationsEnabled()) return;
  // A spend notice is the workspace's news, not the thread's: it shows even
  // over the conversation whose turn crossed the line.
  const spend = frame.kind === "spend";
  if (!spend && document.hasFocus() && visibleThreadId === frame.threadId) return;

  const open = () => {
    window.focus();
    onOpen({ botId: frame.botId, threadId: frame.threadId });
  };

  if (Notification.permission === "granted") {
    const options: NotificationOptions = {
      body: frame.body,
      data: { botId: frame.botId, threadId: frame.threadId },
      ...buildNotificationOptions({ id: frame.botId, avatarUrl }),
      // its own stack, so a bot's next "finished" never replaces it
      ...(spend ? { tag: "openmausbot:spend", icon: undefined } : {}),
      // The banner still lands; only the platform's alert sound is held
      // back, which is what a person on a call with the bot asked for.
      ...(notificationSoundsEnabled() ? {} : { silent: true }),
    };

    fallbackNotification(frame.title, options, open);
  }
}
