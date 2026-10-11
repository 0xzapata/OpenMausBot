// Desktop and mobile notifications, driven by the harness's {kind:"notify"} frames
// and new message arrivals.
import type { Notification } from "../../shared/notification";
import { notificationSoundsEnabled } from "./notification-preferences";

export type NotifyFrame = Notification;

export type NotificationTarget = Pick<NotifyFrame, "botId" | "threadId">;

/** Ask while handling the settings click. Browsers may reject permission
 * requests that are triggered later by an incoming SSE frame. */
export function requestNotificationPermission(): Promise<NotificationPermission> | null {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return null;
  return Notification.requestPermission();
}

/** Register service worker for cross-platform notifications (Windows, Android, etc.)
 * and listen for notification clicks. */
export function initNotificationServiceWorker(onOpen: (target: NotificationTarget) => void): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  // Register worker
  navigator.serviceWorker
    .register("/sw.js")
    .catch(() => {
      // Ignore registration errors (e.g. in insecure context or unsupported browser)
    });

  // Listen for notification click messages from sw.js
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "openmausbot:notification-click" && event.data.target) {
      window.focus();
      onOpen(event.data.target);
    }
  });
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
    // Mobile browsers (e.g. Android Chrome) throw TypeError on new Notification().
    // Show through ServiceWorkerRegistration if supported.
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.ready
        ?.then((reg) => reg.showNotification(title, options))
        ?.catch(() => {});
    }
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
      ...buildNotificationOptions({ id: frame.botId, avatarUrl }),
      // its own stack, so a bot's next "finished" never replaces it
      ...(spend ? { tag: "openmausbot:spend", icon: undefined } : {}),
      // The banner still lands; only the platform's alert sound is held
      // back, which is what a person on a call with the bot asked for.
      ...(notificationSoundsEnabled() ? {} : { silent: true }),
    };

    const sw = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
    if (sw?.controller) {
      sw.ready
        .then((registration) => {
          return registration.showNotification(frame.title, {
            ...options,
            data: { botId: frame.botId, threadId: frame.threadId },
          });
        })
        .catch(() => {
          fallbackNotification(frame.title, options, open);
        });
    } else {
      fallbackNotification(frame.title, options, open);
    }
  }
}
