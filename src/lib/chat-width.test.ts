// Registry and stylesheet are two halves of one contract: a width listed here
// without a CSS block silently renders as full width, so it gets a test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_WIDTH_IDS, DEFAULT_CHAT_WIDTH, applyChatWidth, readChatWidth } from "./chat-width";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "styles.css"), "utf8");
const blocks = new Set(
  [...css.matchAll(/:root\[data-chat-width="([a-z-]+)"\]/g)].map(([, id]) => id),
);

describe("chat width", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} as DOMStringMap } });
  });

  it("defaults to full width", () => {
    expect(DEFAULT_CHAT_WIDTH).toBe("full");
    expect(readChatWidth()).toBe("full");
  });

  it("gives every non-default width a stylesheet block that sets the bubble variables", () => {
    for (const id of CHAT_WIDTH_IDS.filter((w) => w !== DEFAULT_CHAT_WIDTH)) {
      expect(blocks).toContain(id);
      const body = css.match(new RegExp(`:root\\[data-chat-width="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toMatch(/--chat-bubble-max\s*:/);
      expect(body).toMatch(/--chat-bubble-pct\s*:/);
      expect(body).toMatch(/--chat-card-pct\s*:/);
    }
  });

  it("registers every stylesheet block", () => {
    // SAFETY: the assertion only fits toContain()'s parameter type.
    for (const id of blocks) expect(CHAT_WIDTH_IDS).toContain(id as (typeof CHAT_WIDTH_IDS)[number]);
  });

  it("stamps a chosen width, remembers it, and clears the attribute for the default", () => {
    applyChatWidth("compact");
    expect(document.documentElement.dataset.chatWidth).toBe("compact");
    expect(readChatWidth()).toBe("compact");
    applyChatWidth(DEFAULT_CHAT_WIDTH);
    expect(document.documentElement.dataset.chatWidth).toBeUndefined();
    expect(readChatWidth()).toBe("full");
  });

  it("ignores an unknown stored value", () => {
    localStorage.setItem("omb-chat-width", "huge");
    expect(readChatWidth()).toBe("full");
  });

  it("leaves no hard-coded 42rem bubble cap in the components", () => {
    for (const f of ["ChatView", "GroupView", "ScreenFrame", "RoutineRunCard", "GoalRunCard"]) {
      expect(readFileSync(join(root, "components", `${f}.tsx`), "utf8")).not.toMatch(/min\(42rem/);
    }
  });
});
