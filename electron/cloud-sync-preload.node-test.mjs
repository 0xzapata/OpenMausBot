import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const origin = "http://127.0.0.1:48992";
function load({ remote, active = true }) {
  const invoked = [];
  let bridge;
  const context = vm.createContext({
    process: { platform: "fixture", argv: [`--omb-local-origin=${origin}`, "--omb-company-desktop=1"] },
    location: { origin: remote ? "https://omb-u-aaaaaaaaaaaa.fly.dev" : origin }, TextEncoder,
    navigator: { userActivation: { isActive: active } },
    localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } }, ipcRenderer: {
      on: () => {}, removeListener: () => {}, send: () => {}, sendSync: () => false,
      invoke: (...args) => { invoked.push(args); return Promise.resolve(null); },
    } }),
  });
  vm.runInContext(source, context);
  return { bridge, invoked };
}

test("the My Cloud page can ask to link a folder on a click, and sees none of the sync settings", async () => {
  const remote = load({ remote: true });
  assert.equal(typeof remote.bridge.cloudSync.linkFolder, "function");
  assert.equal(remote.bridge.cloudAccount, undefined);
  await remote.bridge.cloudSync.linkFolder();
  assert.deepEqual(remote.invoked.filter(([channel]) => channel === "cloud-sync:link-folder"), [["cloud-sync:link-folder"]]);
  await assert.rejects(load({ remote: true, active: false }).bridge.cloudSync.linkFolder());
});

test("this computer's own Settings gets the sync controls", async () => {
  const local = load({ remote: false });
  await local.bridge.cloudAccount.sync.set({ enabled: true });
  assert.deepEqual(local.invoked.at(-1), ["sync:set", { enabled: true }]);
});
