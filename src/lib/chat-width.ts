// How wide a message bubble may grow in the chat column. Pure CSS like fonts:
// each non-default width is one `:root[data-chat-width=…]` block in styles.css
// that sets the --chat-* variables the bubbles read; this module only decides
// which one is active and remembers it. "full" is the default and sets no attribute.

export const CHAT_WIDTH_IDS = ["full", "wide", "compact"] as const;
export type ChatWidthId = (typeof CHAT_WIDTH_IDS)[number];

export const DEFAULT_CHAT_WIDTH: ChatWidthId = "full";

const KEY = "omb-chat-width";

function isChatWidthId(value: unknown): value is ChatWidthId {
  // SAFETY: the assertion only satisfies includes()' parameter type; the
  // check itself is what decides, and a non-member returns false.
  return CHAT_WIDTH_IDS.includes(value as ChatWidthId);
}

function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readChatWidth(): ChatWidthId {
  try {
    const stored = getStore()?.getItem(KEY);
    return isChatWidthId(stored) ? stored : DEFAULT_CHAT_WIDTH;
  } catch {
    return DEFAULT_CHAT_WIDTH;
  }
}

/** Stamp the width on the document and remember it (main.tsx before first paint, then on each change in Settings). */
export function applyChatWidth(id: ChatWidthId): void {
  if (id === DEFAULT_CHAT_WIDTH) delete document.documentElement.dataset.chatWidth;
  else document.documentElement.dataset.chatWidth = id;
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the width still applies for this session */
  }
}
