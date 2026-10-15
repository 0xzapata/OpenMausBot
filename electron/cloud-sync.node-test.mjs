import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCloudSyncService, linkedFolders } from "./cloud-sync.mjs";
import { fakeCloud } from "./fixtures/cloud-sync-fake-cloud.mjs";

const AT = new Date(2026, 9, 15, 12).getTime();
function setup(t, { origin = "https://omb-u-aaaaaaaaaaaa.fly.dev" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-sync-service-"));
  const project = join(dir, "home", "Clients", "Acme");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "brief.md"), "the brief");
  utimesSync(join(project, "brief.md"), new Date(AT), new Date(AT));
  const cloud = fakeCloud();
  // The service builds its client per pass, so a test can point it at another Cloud by swapping holder.cloud.
  const holder = { cloud };
  const current = { origin };
  const local = { bots: [{ id: "owl", name: "Owl", cwd: project, tasks: [{ threadId: "t1", cwd: join(project, "sub") }] }], groups: [{ id: "room", cwd: project }] };
  cloud.setBots({ bots: [{ id: "owl", name: "Owl", tasks: [{ threadId: "t9", title: "Q3: plan?" }] }], groups: [{ id: "room" }] });
  const service = createCloudSyncService({
    settingsFile: join(dir, "user", "settings.json"), stateFile: join(dir, "user", "state.db"),
    documentsDir: join(dir, "Documents"), localDataDir: join(dir, "home", ".openmausbot"), homeDir: join(dir, "home"),
    platform: "linux", hostname: "Ash-PC", cloudOrigin: () => current.origin, fetch: async () => { throw new Error("no network in tests"); },
    localBots: async () => local, growDisk: async () => null, planDisk: () => null, trashItem: async (file) => rmSync(file),
    createClient: () => holder.cloud.client, watch: () => () => {}, freeBytes: () => 100 * 1024 ** 3, now: () => AT + 60_000,
  });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, project, cloud, holder, current, service };
}

test("finds the folders local bots and rooms use, folding nested ones and refusing the home folder", () => {
  const result = linkedFolders({
    bots: [{ id: "a", cwd: "/Users/ash/Clients/Acme", tasks: [{ cwd: "/Users/ash/Clients/Acme/sub" }, { cwd: "/Users/ash/.openmausbot/task-workspaces/a/t" }] }, { id: "b", cwd: "/Users/ash" }],
    groups: [{ id: "r", cwd: "/Users/ash/Clients/Acme" }],
    localDataDir: "/Users/ash/.openmausbot", homeDir: "/Users/ash", platform: "darwin",
  });
  assert.deepEqual(result.links, [{ pcPath: "/Users/ash/Clients/Acme", bots: ["a"], rooms: ["r"] }]);
  assert.deepEqual(result.refused, [{ pcPath: "/Users/ash", reason: "too-broad" }]);
  const windows = linkedFolders({ bots: [{ id: "a", cwd: "C:\\Users\\Ash\\PA" }, { id: "b", cwd: "c:\\users\\ash\\pa" }], groups: [], localDataDir: "C:\\Users\\Ash\\.openmausbot", homeDir: "C:\\Users\\Ash", platform: "win32" });
  assert.deepEqual(windows.links, [{ pcPath: "C:\\Users\\Ash\\PA", bots: ["a", "b"], rooms: [] }]);
});

test("turning on registers the folders bots use, syncs them, and points the Cloud bots and rooms at the copies once", async (t) => {
  const s = setup(t);
  await s.service.setEnabled(true);
  await s.service.pass();
  assert.deepEqual(s.cloud.calls.filter(([kind]) => kind === "register"), [["register", s.project]]);
  const folder = [...s.cloud.folders.values()][0].folder;
  assert.equal(s.cloud.get(folder.id, "brief.md"), "the brief");
  assert.deepEqual(s.cloud.calls.filter(([kind]) => kind.startsWith("set")), [["setBotFolder", "owl", folder.cloudPath], ["setRoomFolder", "room", folder.cloudPath]]);
  await s.service.pass();
  assert.equal(s.cloud.calls.filter(([kind]) => kind.startsWith("set")).length, 2, "relinked once");
  assert.equal(s.service.state().phase, "synced");
});

test("a bot's conversation folder lands in Documents/MausBot/<bot>/<conversation> and keeps that name", async (t) => {
  const s = setup(t);
  s.cloud.addFolder({ id: "bot-owl-t9", kind: "bot", botId: "owl", threadId: "t9", cloudPath: "/data/.openmausbot/task-workspaces/owl/t9" });
  s.cloud.put("bot-owl-t9", "report.md", "made on My Cloud");
  await s.service.setEnabled(true);
  await s.service.pass();
  const landed = join(s.dir, "Documents", "MausBot", "Owl", "Q3- plan-", "report.md");
  assert.equal(readFileSync(landed, "utf8"), "made on My Cloud");
  s.cloud.setBots({ bots: [{ id: "owl", name: "Renamed", tasks: [{ threadId: "t9", title: "New title" }] }], groups: [] });
  s.cloud.put("bot-owl-t9", "second.md", "more");
  await s.service.pass();
  assert.equal(existsSync(join(s.dir, "Documents", "MausBot", "Owl", "Q3- plan-", "second.md")), true);
});

test("a different My Cloud starts over without deleting anything", async (t) => {
  const s = setup(t);
  await s.service.setEnabled(true);
  await s.service.pass();
  const other = fakeCloud();
  other.setBots({ bots: [], groups: [] });
  s.holder.cloud = other;
  s.current.origin = "https://omb-u-bbbbbbbbbbbb.fly.dev";
  await s.service.pass();
  assert.equal(readFileSync(join(s.project, "brief.md"), "utf8"), "the brief");
  assert.equal(other.calls.some(([kind]) => kind === "delete"), false);
  assert.deepEqual(other.calls.filter(([kind]) => kind === "upload"), [["upload", "brief.md"]], "a first sync on the new Cloud");
});

test("turning off can delete the Cloud copies and clears the bots' and rooms' folders; nothing on this computer goes", async (t) => {
  const s = setup(t);
  await s.service.setEnabled(true);
  await s.service.pass();
  const folder = [...s.cloud.folders.values()][0].folder;
  s.cloud.setBots({ bots: [{ id: "owl", cwd: folder.cloudPath }], groups: [{ id: "room", cwd: folder.cloudPath }] });
  await s.service.setEnabled(false, { keepCloudCopy: false });
  assert.deepEqual(s.cloud.calls.filter(([kind]) => kind === "unregister"), [["unregister", folder.id, false]]);
  assert.deepEqual(s.cloud.calls.filter(([kind]) => kind.startsWith("set")).slice(-2), [["setBotFolder", "owl", null], ["setRoomFolder", "room", null]]);
  assert.equal(readFileSync(join(s.project, "brief.md"), "utf8"), "the brief");
  assert.equal(s.service.state().enabled, false);
});

test("Choose on this PC adds a folder and answers its Cloud copy; a too-broad folder is refused", async (t) => {
  const s = setup(t);
  await assert.rejects(s.service.linkFolder(s.project), /Turn on Sync with My Cloud first/);
  await s.service.setEnabled(true);
  const extra = join(s.dir, "home", "Notes");
  mkdirSync(extra);
  assert.deepEqual(await s.service.linkFolder(extra), { cloudPath: "/data/Synced/PC/Notes" });
  await assert.rejects(s.service.linkFolder(join(s.dir, "home")), /too broad/);
});

test("a folder that fails is listed and the others still sync", async (t) => {
  const s = setup(t);
  s.cloud.addFolder({ id: "bot-x-y", kind: "bot", botId: "x", threadId: "y", cloudPath: "/x" });
  const files = s.cloud.client.files;
  s.cloud.client.files = async (id) => { if (id === "bot-x-y") throw Object.assign(new Error("My Cloud answered 500"), { status: 500 }); return files(id); };
  await s.service.setEnabled(true);
  await s.service.pass();
  const folder = [...s.cloud.folders.values()].find((entry) => entry.folder.kind === "pc").folder;
  assert.equal(s.cloud.get(folder.id, "brief.md"), "the brief");
  assert.equal(s.service.state().phase, "synced");
  assert.deepEqual(s.service.state().problems.filter((problem) => problem.folderId === "bot-x-y").map((problem) => problem.error), ["My Cloud answered 500"]);
});

test("a link to the home folder is as broad as the home folder, and a folder inside a synced one folds into it", async (t) => {
  const s = setup(t);
  await s.service.setEnabled(true);
  await s.service.pass();
  const link = join(s.dir, "points-home");
  symlinkSync(join(s.dir, "home"), link);
  await assert.rejects(s.service.linkFolder(link), /too broad/);
  mkdirSync(join(s.project, "Drafts"));
  const registered = s.cloud.calls.filter(([kind]) => kind === "register").length;
  assert.deepEqual(await s.service.linkFolder(join(s.project, "Drafts")), { cloudPath: "/data/Synced/PC/Acme/Drafts" });
  assert.equal(s.cloud.calls.filter(([kind]) => kind === "register").length, registered);
});

test("turning sync off and on again keeps the same folders on this computer", async (t) => {
  const s = setup(t);
  s.cloud.addFolder({ id: "bot-owl-t9", kind: "bot", botId: "owl", threadId: "t9", cloudPath: "/data/.openmausbot/task-workspaces/owl/t9" });
  s.cloud.put("bot-owl-t9", "report.md", "made on My Cloud");
  await s.service.setEnabled(true);
  await s.service.pass();
  await s.service.setEnabled(false);
  await s.service.setEnabled(true);
  await s.service.pass();
  assert.deepEqual(readdirSync(join(s.dir, "Documents", "MausBot")), ["Owl"]);
  assert.deepEqual(readdirSync(join(s.dir, "Documents", "MausBot", "Owl")), ["Q3- plan-"]);
  assert.equal(s.cloud.calls.filter(([kind]) => kind === "upload").length, 1, "nothing became a clash");
});
