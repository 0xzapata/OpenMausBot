import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newReport, syncFolder } from "./cloud-sync-engine.mjs";
import { openSyncState } from "./cloud-sync-state.mjs";
import { fakeCloud } from "./fixtures/cloud-sync-fake-cloud.mjs";

const AT = new Date(2026, 9, 15, 12).getTime();
const GB = 1024 ** 3;
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-sync-engine-"));
  const state = openSyncState(join(dir, "state.db"));
  t.after(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });
  const local = join(dir, "PA");
  mkdirSync(local);
  const cloud = fakeCloud(options);
  const folder = cloud.addFolder({ id: "f1", kind: "pc", computerId: "c", pcPath: local, cloudPath: "/data/Synced/PC/PA" });
  const trashed = [];
  const run = async (extra = {}) => {
    const report = newReport();
    await syncFolder({ client: cloud.client, state, folder, local, platform: "linux", now: () => AT + 60_000, trashItem: async (file) => { trashed.push(file); rmSync(file); }, report, ...extra });
    return report;
  };
  const write = (path, text) => { const file = join(local, ...path.split("/")); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); utimesSync(file, new Date(AT), new Date(AT)); };
  const read = (path) => readFileSync(join(local, ...path.split("/")), "utf8");
  return { dir, state, local, cloud, folder, run, write, read, trashed };
}

test("new files go both ways, and a second pass moves nothing", async (t) => {
  const s = setup(t);
  s.write("mine.txt", "from the PC");
  s.cloud.put("f1", "out/report.md", "from a bot");
  await s.run();
  assert.equal(s.cloud.get("f1", "mine.txt"), "from the PC");
  assert.equal(s.read("out/report.md"), "from a bot");
  const before = s.cloud.calls.length;
  await s.run();
  assert.equal(s.cloud.calls.length, before);
});

test("edits travel both ways", async (t) => {
  const s = setup(t);
  s.write("a.txt", "v1");
  s.cloud.put("f1", "b.txt", "v1");
  await s.run();
  s.write("a.txt", "v2 from the PC");
  utimesSync(join(s.local, "a.txt"), new Date(AT + 1), new Date(AT + 1));
  s.cloud.put("f1", "b.txt", "v2 from a bot");
  await s.run();
  assert.equal(s.cloud.get("f1", "a.txt"), "v2 from the PC");
  assert.equal(s.read("b.txt"), "v2 from a bot");
});

test("edited in both places: the Cloud keeps the name and the PC copy sits beside it on both sides", async (t) => {
  const s = setup(t);
  s.write("r.docx", "v1");
  await s.run();
  s.write("r.docx", "PC edit");
  utimesSync(join(s.local, "r.docx"), new Date(AT + 1), new Date(AT + 1));
  s.cloud.put("f1", "r.docx", "bot edit");
  const report = await s.run();
  assert.equal(s.read("r.docx"), "bot edit");
  assert.equal(s.read("r (PC copy, 15 Oct 2026).docx"), "PC edit");
  assert.equal(s.cloud.get("f1", "r (PC copy, 15 Oct 2026).docx"), "PC edit");
  assert.deepEqual(report.clashes, [{ folderId: "f1", path: "r.docx", clashPath: "r (PC copy, 15 Oct 2026).docx" }]);
});

test("deletes travel both ways: into the Cloud's trash, and into the PC's Recycle Bin", async (t) => {
  const s = setup(t);
  s.write("a.txt", "a");
  s.cloud.put("f1", "b.txt", "b");
  await s.run();
  rmSync(join(s.local, "a.txt"));
  s.cloud.folders.get("f1").files.delete("b.txt");
  await s.run();
  assert.equal(s.cloud.get("f1", "a.txt"), undefined);
  assert.deepEqual(s.trashed, [join(s.local, "b.txt")]);
});

test("a rename on the PC is a move on My Cloud, not a fresh upload", async (t) => {
  const s = setup(t);
  s.write("old.txt", "same bytes");
  await s.run();
  s.write("new.txt", "same bytes");
  rmSync(join(s.local, "old.txt"));
  await s.run();
  assert.deepEqual(s.cloud.calls.filter(([kind]) => kind !== "download").slice(-1), [["move", "old.txt->new.txt"]]);
  assert.equal(s.cloud.get("f1", "new.txt"), "same bytes");
});

test("near full: small files keep syncing, the big one waits, and growing the disk is tried once", async (t) => {
  const s = setup(t, { freeBytes: GB + 100 });
  s.write("a-big.bin", "x".repeat(500));
  s.write("b-small.txt", "tiny");
  let grows = 0;
  const report = await s.run({ grow: async () => { grows++; return false; } });
  assert.equal(s.cloud.get("f1", "b-small.txt"), "tiny");
  assert.equal(s.cloud.get("f1", "a-big.bin"), undefined);
  assert.deepEqual(report.waiting, [{ folderId: "f1", path: "a-big.bin", size: 500 }]);
  assert.equal(grows, 1);
});

test("a folder missing on My Cloud leaves the PC copy exactly as it is", async (t) => {
  const s = setup(t);
  s.write("a.txt", "keep");
  await s.run();
  s.cloud.missing.add("f1");
  const report = await s.run();
  assert.deepEqual(report.missing, ["f1"]);
  assert.equal(s.read("a.txt"), "keep");
  assert.deepEqual(s.trashed, []);
});

test("sync's own half-downloaded files are never uploaded, and stale ones are removed", async (t) => {
  const s = setup(t);
  writeFileSync(join(s.local, ".x.txt.omb-sync-aaaaaaaa"), "half");
  utimesSync(join(s.local, ".x.txt.omb-sync-aaaaaaaa"), new Date(AT), new Date(AT));
  writeFileSync(join(s.local, ".y.txt.omb-sync-bbbbbbbb"), "old half");
  utimesSync(join(s.local, ".y.txt.omb-sync-bbbbbbbb"), new Date(AT - 2 * 86_400_000), new Date(AT - 2 * 86_400_000));
  await s.run();
  assert.deepEqual(s.cloud.calls.filter(([kind]) => kind === "upload"), []);
  assert.equal(existsSync(join(s.local, ".x.txt.omb-sync-aaaaaaaa")), true);
  assert.equal(existsSync(join(s.local, ".y.txt.omb-sync-bbbbbbbb")), false);
});

test("a file the PC cannot touch is retried and listed only after three failures", async (t) => {
  const s = setup(t);
  s.cloud.put("f1", "open.xlsx", "v1");
  await s.run();
  s.cloud.folders.get("f1").files.delete("open.xlsx");
  s.cloud.put("f1", "other.txt", "still syncs");
  const busy = async () => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); };
  assert.deepEqual((await s.run({ trashItem: busy })).problems, []);
  assert.equal(s.read("other.txt"), "still syncs");
  assert.deepEqual((await s.run({ trashItem: busy })).problems, []);
  assert.deepEqual((await s.run({ trashItem: busy })).problems, [{ folderId: "f1", path: "open.xlsx", error: "EBUSY: resource busy or locked" }]);
});

test("says when a Cloud bot changed instructions coding tools on this PC read", async (t) => {
  const s = setup(t);
  s.cloud.put("f1", "CLAUDE.md", "be terse");
  assert.deepEqual((await s.run()).notices, [{ folderId: "f1", path: "CLAUDE.md" }]);
});
