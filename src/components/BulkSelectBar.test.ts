import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BulkSelectBar, BulkSelectFilters } from "./BulkSelectBar";
import { SidebarThreadRow } from "./SidebarThreadRow";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

const rows = [
  { threadId: "a", title: "Old chat", pinned: true },
  { threadId: "b", title: "Other chat" },
];
const noop = vi.fn();

describe("select mode rows", () => {
  const row = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(SidebarThreadRow, {
    task: { threadId: "a", title: "Old chat", ...extra }, ownerId: "bot", current: false, locale: "en",
    onSelect: noop, onRename: noop, onDelete: noop, selectMode: true, checked: true, onToggleSelect: noop,
  }));
  it("renders a checkbox row without the actions menu", () => {
    const markup = row({});
    expect(markup).toContain('role="checkbox"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="Select Old chat"');
    expect(markup).not.toContain("Actions for");
  });
  it("marks a running thread as disabled", () => {
    expect(row({ busy: true, activity: "working" })).toContain('aria-disabled="true"');
    expect(row({})).toContain('aria-disabled="false"');
  });
  it("keeps the normal row outside select mode", () => {
    const markup = renderToStaticMarkup(createElement(SidebarThreadRow, {
      task: { threadId: "a", title: "Old chat" }, ownerId: "bot", current: false, locale: "en",
      onSelect: noop, onRename: noop, onDelete: noop,
    }));
    expect(markup).not.toContain('role="checkbox"');
    expect(markup).toContain("Actions for");
  });
});

describe("select mode controls", () => {
  it("shows the quick filters and Done", () => {
    const markup = renderToStaticMarkup(createElement(BulkSelectFilters, { rows, selected: new Set<string>(), now: 0, onChange: noop, onDone: noop }));
    for (const label of ["Select all", "Older than 30 days", "Archived", "Clear", "Done"]) expect(markup).toContain(label);
  });
  it("disables Delete with nothing selected and shows the count", () => {
    const markup = renderToStaticMarkup(createElement(BulkSelectBar, { rows, selected: new Set<string>(), freshConversation: true, onChange: noop, onDelete: noop }));
    expect(markup).toContain("0 selected");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Delete 0</);
  });
  it("enables Delete for a selection and warns when a channel would lose every thread", () => {
    const ok = renderToStaticMarkup(createElement(BulkSelectBar, { rows, selected: new Set(["b"]), maxDeletable: 1, freshConversation: false, onChange: noop, onDelete: noop }));
    expect(ok).toContain("1 selected");
    expect(ok).not.toMatch(/<button[^>]*disabled=""[^>]*>Delete 1</);
    const over = renderToStaticMarkup(createElement(BulkSelectBar, { rows, selected: new Set(["a", "b"]), maxDeletable: 1, freshConversation: false, onChange: noop, onDelete: noop }));
    expect(over).toMatch(/<button[^>]*disabled=""[^>]*>Delete 2</);
    expect(over).toContain("A channel keeps at least one thread");
  });
});
