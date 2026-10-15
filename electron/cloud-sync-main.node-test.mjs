import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCloudFiles } from "./cloud-sync-main.mjs";

test("Files channels answer this computer's own window only, and share only a folder the person picked here", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-files-main-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const picked = join(dir, "home", "Clients");
  mkdirSync(picked, { recursive: true });
  const handlers = new Map(), guards = [], opened = [];
  let pick = { canceled: false, filePaths: [picked] };
  const installed = installCloudFiles({
    app: { getPath: (name) => join(dir, name) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => pick },
    shell: { trashItem: async () => {}, openPath: async (folder) => { opened.push(folder); return ""; } },
    powerMonitor: { on: () => {} },
    fetch: async () => { throw new Error("offline"); },
    localWorkspaceOnly: (channel, handler) => { guards.push(channel); return handler; },
    send: () => {}, cloudOrigin: () => null, cloudAccount: () => ({ openDashboard: async () => {} }),
    localDataDir: join(dir, "home", ".openmausbot"),
  });
  t.after(() => installed.close());
  assert.deepEqual(guards, ["files:state", "files:pick", "files:check", "files:share", "files:stop", "files:deletes", "files:locate", "files:outputs", "files:open", "files:more-space"]);
  const checked = await handlers.get("files:pick")({});
  assert.equal(checked.name, "Clients");
  assert.equal(checked.refusal, null);
  // Only the token stands for the folder: a made-up one, or the same one twice, shares nothing.
  await assert.rejects(handlers.get("files:share")({}, "not-a-token"), /Choose the folder again/);
  const state = await handlers.get("files:share")({}, checked.token);
  assert.deepEqual(state.shared.map((folder) => folder.pcPath), [picked]);
  await assert.rejects(handlers.get("files:share")({}, checked.token), /Choose the folder again/);
  // A refused folder gets no token that shares it.
  pick = { canceled: false, filePaths: [join(dir, "home")] };
  const broad = await handlers.get("files:pick")({});
  assert.equal(broad.refusal, "app-data");
  await assert.rejects(handlers.get("files:share")({}, broad.token));
  pick = { canceled: true, filePaths: [] };
  assert.equal(await handlers.get("files:pick")({}), null);
  await assert.rejects(handlers.get("files:check")({}, "not a list"));
  await handlers.get("files:open")({}, { outputs: true });
  assert.deepEqual(opened, [join(dir, "documents", "MausBot")]);
  // before-quit runs twice when quitting: closing again must not throw.
  installed.close();
  assert.doesNotThrow(() => installed.close());
});
