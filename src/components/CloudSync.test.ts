import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudSyncBridge, CloudSyncStatus } from "../../electron/cloud-sync.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (v: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CloudSync, formatSyncBytes, syncStatusKey } from "./CloudSync";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; role?: string; "aria-label"?: string; "data-sync"?: string }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
let bridge: CloudSyncBridge;
function render() { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudSync({ bridge }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture)); return { html, nodes: nodes(tree) }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const GB = 1024 ** 3;
const synced: CloudSyncStatus = {
  enabled: true, openAtLogin: true, phase: "synced", lastSyncedAt: 1,
  disk: { totalBytes: 10 * GB, freeBytes: 1.5 * GB, syncedBytes: 6 * GB, botFileBytes: GB, trashBytes: 0.5 * GB, reserveBytes: GB, usedBytes: 8.5 * GB, planMaxBytes: 10 * GB, warn: true },
  folders: [], waiting: [{ folderId: "f", path: "movie.mov", size: 2 * GB }], clashes: [{ folderId: "f", path: "r.docx", clashPath: "r (PC copy, 15 Oct 2026).docx" }],
  held: [{ folderId: "f", path: "a:b.txt", reason: "windows-name" }], problems: [], notices: [{ folderId: "f", path: "CLAUDE.md" }], missing: [],
};
async function ready(state: CloudSyncStatus) { vi.mocked(bridge.state).mockResolvedValue(state); render(); f.effects[0]!(); await flush(); return render(); }
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = [];
  bridge = { state: vi.fn(), set: vi.fn(), trash: vi.fn().mockResolvedValue([]), restore: vi.fn(), open: vi.fn(), upgrade: vi.fn(), onState: vi.fn(() => () => {}) };
  vi.stubGlobal("window", { confirm: vi.fn(() => { throw new Error("no confirmation dialogs"); }) });
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); });

it("says where sync stands in one line", () => {
  expect(syncStatusKey(null)).toBeNull();
  expect(syncStatusKey({ ...synced, enabled: false })).toBeNull();
  expect(syncStatusKey(synced)).toBe("cloudSync.status.synced");
  expect(syncStatusKey({ ...synced, phase: "signed-out" })).toBe("cloudSync.status.signedOut");
  expect(formatSyncBytes(1.5 * GB)).toBe("1.5 GB");
  expect(formatSyncBytes(3 * 1024 ** 2)).toBe("3.0 MB");
});

it("shows the meter, the 80% warning, waiting files with Upgrade, clashes, held files and notices", async () => {
  const { html, nodes: tree } = await ready(synced);
  expect(html).toContain("8.5 GB of 10.0 GB used");
  expect(html).toContain("My Cloud is 80% full.");
  expect(html).toContain("1 files (2.0 GB) are waiting: My Cloud is full.");
  expect(html).toContain("r (PC copy, 15 Oct 2026).docx");
  expect(html).toContain("its name isn&#x27;t allowed here");
  expect(html).toContain("A bot on My Cloud changed CLAUDE.md");
  expect(html).toContain("Every bot on My Cloud can read and change synced files");
  tree.find((node) => node.props["data-sync"] === "upgrade")!.props.onClick!();
  expect(bridge.upgrade).toHaveBeenCalled();
});

it("turning on asks main; turning off asks whether to keep the Cloud copies, without a confirmation dialog", async () => {
  vi.mocked(bridge.set).mockResolvedValue(synced);
  const off = await ready({ ...synced, enabled: false, phase: "off", disk: null, waiting: [], clashes: [], held: [], notices: [] });
  off.nodes.find((node) => node.props["aria-label"] === "Sync with My Cloud" && typeof node.props.onClick === "function")!.props.onClick!();
  await flush();
  expect(bridge.set).toHaveBeenCalledWith({ enabled: true });
  const on = render();
  on.nodes.find((node) => node.props["aria-label"] === "Sync with My Cloud" && typeof node.props.onClick === "function")!.props.onClick!();
  const asking = render();
  expect(asking.html).toContain("Turn off Sync with My Cloud?");
  asking.nodes.find((node) => node.props["data-sync"] === "off-delete")!.props.onClick!();
  await flush();
  expect(bridge.set).toHaveBeenLastCalledWith({ enabled: false, keepCloudCopy: false });
});
