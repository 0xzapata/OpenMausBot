import { useSyncExternalStore } from "react";

export const NOTIFICATION_SOUNDS_KEY = "omb-notification-sounds";
export const MESSAGE_NOTIFICATIONS_KEY = "omb-message-notifications";

// Whether desktop/mobile notifications on THIS browser play the alert sound
// or pop for incoming assistant messages.
// Stored per client in localStorage, matching thread-preferences.ts.
let sessionSoundsChoice: boolean | undefined;
let sessionMessageChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** True unless this client has muted notification sounds. */
export function notificationSoundsEnabled(): boolean {
  if (sessionSoundsChoice !== undefined) return sessionSoundsChoice;
  try {
    return storage()?.getItem(NOTIFICATION_SOUNDS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** True unless this client has disabled notifications for new assistant messages. */
export function messageNotificationsEnabled(): boolean {
  if (sessionMessageChoice !== undefined) return sessionMessageChoice;
  try {
    return storage()?.getItem(MESSAGE_NOTIFICATIONS_KEY) !== "0";
  } catch {
    return true;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (
    event.key !== NOTIFICATION_SOUNDS_KEY &&
    event.key !== MESSAGE_NOTIFICATIONS_KEY &&
    event.key !== null
  ) {
    return;
  }
  if (event.storageArea && event.storageArea !== storage()) return;
  if (event.key === NOTIFICATION_SOUNDS_KEY || event.key === null) {
    sessionSoundsChoice = undefined;
  }
  if (event.key === MESSAGE_NOTIFICATIONS_KEY || event.key === null) {
    sessionMessageChoice = undefined;
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setNotificationSounds(enabled: boolean): void {
  sessionSoundsChoice = enabled;
  try {
    const local = storage();
    const value = enabled ? "1" : "0";
    local?.setItem(NOTIFICATION_SOUNDS_KEY, value);
    if (local?.getItem(NOTIFICATION_SOUNDS_KEY) === value) sessionSoundsChoice = undefined;
  } catch {
    // Session fallback on storage failure
  }
  notify();
}

export function setMessageNotifications(enabled: boolean): void {
  sessionMessageChoice = enabled;
  try {
    const local = storage();
    const value = enabled ? "1" : "0";
    local?.setItem(MESSAGE_NOTIFICATIONS_KEY, value);
    if (local?.getItem(MESSAGE_NOTIFICATIONS_KEY) === value) sessionMessageChoice = undefined;
  } catch {
    // Session fallback on storage failure
  }
  notify();
}

export function useNotificationSounds(): boolean {
  return useSyncExternalStore(subscribe, notificationSoundsEnabled, () => true);
}

export function useMessageNotifications(): boolean {
  return useSyncExternalStore(subscribe, messageNotificationsEnabled, () => true);
}
