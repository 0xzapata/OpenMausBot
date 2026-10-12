// @vitest-environment happy-dom
// A held room member is listed with a way back.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [] as Bot[] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { RoomHoldsBanner } = await import("./GroupView");

const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: ["lead", "bee"],
  defaultResponder: { kind: "member", botId: "lead" }, bulletin: "", unread: false,
  createdAt: 1, messages: [],
};
const lead = { id: "lead", name: "Lead", color: "blue" } as Bot;
const bee = { id: "bee", name: "Bee", color: "green" } as Bot;

let host: HTMLDivElement;
let root: Root;
const render = (element: ReturnType<typeof createElement>) => flushSync(() => root.render(element));

beforeEach(() => {
  fixture.dispatch.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("held room members", () => {
  it("lists who is held and resumes one from the banner", () => {
    render(createElement(RoomHoldsBanner, { group: { ...room, holds: { bee: { at: 1 } } }, members: [lead, bee] }));
    expect(host.textContent).toContain("Stopped by you: Bee.");
    const resume = [...host.querySelectorAll("button")].find((button) => button.textContent === "Resume Bee")!;
    flushSync(() => resume.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "setGroupHold", groupId: "room", botId: "bee", held: false });
  });

  it("shows nothing when nobody is held", () => {
    render(createElement(RoomHoldsBanner, { group: { ...room, holds: {} }, members: [lead, bee] }));
    expect(host.innerHTML).toBe("");
  });
});
