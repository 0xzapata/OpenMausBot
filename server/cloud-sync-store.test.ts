import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SyncPathError, insideFolder, syncRoot } from "./cloud-sync-paths.ts";
import { CloudSyncStore, syncedFolders } from "./cloud-sync-store.ts";

const PC = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const scratch: string[] = [];
const stores: CloudSyncStore[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), "omb-sync-store-"));
  scratch.push(home);
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir);
  const store = new CloudSyncStore({ dataDir, now: () => 1_000 });
  stores.push(store);
  return { home, dataDir, store };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("puts synced folders beside the data folder unless OMB_SYNC_ROOT says otherwise", () => {
  expect(syncRoot("/data/.openmausbot", {})).toBe("/data/Synced");
  expect(syncRoot("/data/.openmausbot", { OMB_SYNC_ROOT: "/mnt/sync" })).toBe("/mnt/sync");
});

it("registers a PC folder once, under that computer's own folder, and creates it", () => {
  const { home, store } = setup();
  const first = store.register({ computerId: PC, computerName: "Ash-PC", pcPath: "C:\\Users\\Ash\\Documents\\PA", name: "PA" });
  expect(first.cloudPath).toBe(join(home, "Synced", "Ash-PC", "PA"));
  expect(existsSync(first.cloudPath)).toBe(true);
  expect(store.register({ computerId: PC, computerName: "Ash-PC", pcPath: "c:\\users\\ash\\documents\\pa", name: "PA" }).id).toBe(first.id);
  const second = store.register({ computerId: PC, computerName: "Ash-PC", pcPath: "D:\\Work\\PA", name: "PA" });
  expect(second.cloudPath).toBe(join(home, "Synced", "Ash-PC", "PA (2)"));
  const other = store.register({ computerId: OTHER, computerName: "Ash-PC", pcPath: "/Users/ash/PA", name: "PA" });
  expect(other.cloudPath).toBe(join(home, "Synced", "Ash-PC (2)", "PA"));
  expect(store.pcFolders().map((folder) => folder.id)).toEqual([first.id, second.id, other.id]);
  expect(syncedFolders(store.dataDir)).toEqual([
    { computerName: "Ash-PC", pcPath: "C:\\Users\\Ash\\Documents\\PA", cloudPath: first.cloudPath },
    { computerName: "Ash-PC", pcPath: "D:\\Work\\PA", cloudPath: second.cloudPath },
    { computerName: "Ash-PC", pcPath: "/Users/ash/PA", cloudPath: other.cloudPath },
  ]);
  expect(store.unregister(second.id)?.id).toBe(second.id);
  expect(store.folder(second.id)).toBeUndefined();
});

it("offers a bot's conversation folder only once it holds a file", () => {
  const { dataDir, store } = setup();
  mkdirSync(join(dataDir, "task-workspaces", "bot1", "thread1"), { recursive: true });
  mkdirSync(join(dataDir, "task-workspaces", "bot1", "thread2", "node_modules"), { recursive: true });
  writeFileSync(join(dataDir, "task-workspaces", "bot1", "thread2", "node_modules", "x.js"), "skipped");
  expect(store.botFolders()).toEqual([]);
  writeFileSync(join(dataDir, "task-workspaces", "bot1", "thread1", "report.md"), "# Report");
  expect(store.botFolders()).toEqual([{ id: "bot-bot1-thread1", kind: "bot", botId: "bot1", threadId: "thread1", cloudPath: join(dataDir, "task-workspaces", "bot1", "thread1") }]);
});

it("resolves a path only inside its folder, never through a link", () => {
  const { home } = setup();
  const folder = join(home, "f");
  mkdirSync(join(folder, "real"), { recursive: true });
  symlinkSync(home, join(folder, "link"));
  expect(insideFolder(folder, "real/a.txt")).toBe(join(folder, "real", "a.txt"));
  for (const bad of ["../x", "/etc/passwd", "a\\b", "link/a.txt"]) expect(() => insideFolder(folder, bad)).toThrow(SyncPathError);
});
