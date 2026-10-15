import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCloudSync } from "./cloud-sync-main.mjs";

test("registers Settings channels as local-only and Choose on this PC for the My Cloud page", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omb-sync-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map(), guards = [];
  let login = { openAtLogin: false };
  const installed = installCloudSync({
    app: { getPath: (name) => join(dir, name), getLoginItemSettings: () => login, setLoginItemSettings: (next) => { login = next; } },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { trashItem: async () => {}, showItemInFolder: () => {} },
    powerMonitor: { on: () => {} },
    Tray: class {}, Menu: { buildFromTemplate: () => ({}) }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "/icon.png",
    fetch: async () => { throw new Error("offline"); },
    localWorkspaceOnly: (channel, handler) => { guards.push(["local", channel]); return handler; },
    cloudPageSender: (channel, handler) => { guards.push(["cloud", channel]); return () => handler(true); },
    send: () => {}, cloudOrigin: () => null, localBots: async () => ({ bots: [], groups: [] }),
    cloudAccount: () => ({ growDisk: async () => null, openDashboard: async () => {} }), planDisk: () => null,
    localDataDir: join(dir, ".openmausbot"), openSettings: () => {},
  });
  t.after(() => installed.close());
  assert.deepEqual(guards, [
    ["local", "sync:state"], ["local", "sync:set"], ["local", "sync:trash"], ["local", "sync:restore"], ["local", "sync:open"], ["local", "sync:upgrade"],
    ["cloud", "cloud-sync:link-folder"],
  ]);
  const state = await handlers.get("sync:set")({}, { enabled: true });
  assert.equal(state.enabled, true);
  assert.equal(login.openAtLogin, true, "turning sync on opens the app at login");
  assert.equal((await handlers.get("sync:set")({}, { openAtLogin: false })).openAtLogin, false);
  assert.equal(await handlers.get("cloud-sync:link-folder")({}), null, "a cancelled picker links nothing");
});
