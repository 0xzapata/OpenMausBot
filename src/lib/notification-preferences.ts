import { useSyncExternalStore } from "react";

export const NOTIFICATION_SOUNDS_KEY = "omb-notification-sounds";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function notificationSoundsEnabled(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(NOTIFICATION_SOUNDS_KEY) !== "0";
  } catch {
    return true;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== NOTIFICATION_SOUNDS_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
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
  sessionChoice = enabled;
  try {
    const local = storage();
    const value = enabled ? "1" : "0";
    local?.setItem(NOTIFICATION_SOUNDS_KEY, value);
    if (local?.getItem(NOTIFICATION_SOUNDS_KEY) === value) sessionChoice = undefined;
  } catch {
  }
  notify();
}

export function useNotificationSounds(): boolean {
  return useSyncExternalStore(subscribe, notificationSoundsEnabled, () => true);
}
