import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SyncError, createCloudSync, type CloudSync } from "./cloud-sync.ts";

const PC = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const GB = 1024 ** 3;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const scratch: string[] = [];
const open: CloudSync[] = [];
function setup(options: { freeBytes?: number; now?: () => number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "omb-cloud-sync-"));
  scratch.push(home);
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir);
  const sync = createCloudSync({ dataDir, now: options.now, statfs: () => ({ totalBytes: 10 * GB, freeBytes: options.freeBytes ?? 9 * GB }) });
  open.push(sync);
  const folder = sync.register({ computerId: PC, computerName: "Ash-PC", pcPath: "C:\\Users\\Ash\\PA", name: "PA" });
  return { home, dataDir, sync, folder };
}
async function* parts(...chunks: string[]) { for (const chunk of chunks) yield Buffer.from(chunk); }
async function put(sync: CloudSync, folderId: string, path: string, text: string, baseSha256: string | null) {
  const { uploadId } = sync.beginUpload(folderId, { path, size: Buffer.byteLength(text), sha256: sha(text), baseSha256 });
  await sync.writePart(uploadId, 0, parts(text));
  return sync.commit(uploadId);
}
const status = async (work: () => unknown) => { try { await work(); return 200; } catch (error) { if (error instanceof SyncError) return error.status; throw error; } };
afterEach(() => {
  for (const sync of open.splice(0)) sync.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("sums up the synced folders and the disk", () => {
  const { sync, folder } = setup();
  const summary = sync.summary();
  expect(summary.folders).toEqual([folder]);
  expect(summary.disk).toEqual({ totalBytes: 10 * GB, freeBytes: 9 * GB, syncedBytes: 0, botFileBytes: 0, trashBytes: 0, reserveBytes: GB });
  expect(typeof summary.cursor).toBe("number");
});

it("refuses a malformed registration", async () => {
  const { sync } = setup();
  expect(await status(() => sync.register({ computerId: "nope", computerName: "PC", pcPath: "/a", name: "a" }))).toBe(400);
  expect(await status(() => sync.register({ computerId: PC, computerName: "PC", pcPath: "relative/path", name: "a" }))).toBe(400);
});

it("takes a file in resumable parts and commits it in place", async () => {
  const { sync, folder } = setup();
  const text = "hello world";
  const begun = sync.beginUpload(folder.id, { path: "notes/a.txt", size: text.length, sha256: sha(text), baseSha256: null });
  expect(begun.received).toBe(0);
  expect(sync.beginUpload(folder.id, { path: "notes/a.txt", size: text.length, sha256: sha(text), baseSha256: null }).uploadId).toBe(begun.uploadId);
  expect((await sync.writePart(begun.uploadId, 0, parts("hello "))).received).toBe(6);
  expect(await status(() => sync.writePart(begun.uploadId, 0, parts("hello ")))).toBe(409);
  expect((await sync.writePart(begun.uploadId, 6, parts("world"))).received).toBe(11);
  expect(await sync.commit(begun.uploadId)).toEqual({ sha256: sha(text) });
  expect(readFileSync(join(folder.cloudPath, "notes", "a.txt"), "utf8")).toBe(text);
  expect(await sync.files(folder.id)).toMatchObject([{ path: "notes/a.txt", size: 11, sha256: sha(text) }]);
});

it("refuses bytes that do not match their hash, and a commit over a version it has not seen", async () => {
  const { sync, folder } = setup();
  const { uploadId } = sync.beginUpload(folder.id, { path: "a.txt", size: 3, sha256: sha("abc"), baseSha256: null });
  await sync.writePart(uploadId, 0, parts("xyz"));
  expect(await status(() => sync.commit(uploadId))).toBe(422);
  await put(sync, folder.id, "a.txt", "v1", null);
  try { await put(sync, folder.id, "a.txt", "v2", null); throw new Error("committed"); }
  catch (error) { expect(error).toBeInstanceOf(SyncError); expect((error as SyncError).status).toBe(409); expect((error as SyncError).body.current).toMatchObject({ sha256: sha("v1") }); }
  expect(await put(sync, folder.id, "a.txt", "v2", sha("v1"))).toEqual({ sha256: sha("v2") });
  expect(sync.trash().entries).toMatchObject([{ path: "a.txt", size: 2 }]);
});

it("answers 507 when a file would leave less than 1 GB free", async () => {
  const { sync, folder } = setup({ freeBytes: GB + 10 });
  expect(sync.beginUpload(folder.id, { path: "small", size: 10, sha256: sha("x"), baseSha256: null }).received).toBe(0);
  try { sync.beginUpload(folder.id, { path: "big", size: 11, sha256: sha("y"), baseSha256: null }); throw new Error("accepted"); }
  catch (error) { expect((error as SyncError).status).toBe(507); expect((error as SyncError).body).toMatchObject({ neededBytes: 11 + GB, freeBytes: GB + 10 }); }
});

it("answers 410 when a folder's copy is gone, and can delete a folder's copy to the trash", async () => {
  const { sync, folder } = setup();
  await put(sync, folder.id, "a.txt", "keep me", null);
  rmSync(folder.cloudPath, { recursive: true });
  expect(await status(() => sync.files(folder.id))).toBe(410);
  mkdirSync(folder.cloudPath);
  writeFileSync(join(folder.cloudPath, "b.txt"), "bye");
  sync.unregister(folder.id, false);
  expect(existsSync(folder.cloudPath)).toBe(false);
  expect(sync.trash().entries.map((entry) => entry.path)).toEqual(["b.txt"]);
  expect(sync.summary().folders).toEqual([]);
});

it("serves a file with its hash", async () => {
  const { sync, folder } = setup();
  await put(sync, folder.id, "a.txt", "abc", null);
  const served = await sync.download(folder.id, "a.txt");
  expect(served).toEqual({ file: join(folder.cloudPath, "a.txt"), size: 3, sha256: sha("abc") });
  expect(await status(() => sync.download(folder.id, "missing.txt"))).toBe(404);
  expect(await status(() => sync.download(folder.id, "../escape"))).toBe(400);
});

it("deletes into the trash and moves, only over the version the desktop saw", async () => {
  const { sync, folder } = setup();
  await put(sync, folder.id, "deep/a.txt", "one", null);
  await put(sync, folder.id, "b.txt", "two", null);
  const { results } = await sync.ops(folder.id, { ops: [
    { op: "delete", path: "deep/a.txt", baseSha256: sha("stale") },
    { op: "move", from: "b.txt", to: "moved/b.txt", sha256: sha("two") },
  ] });
  expect(results[0]).toMatchObject({ conflict: true, current: { sha256: sha("one") } });
  expect(results[1]).toEqual({ ok: true });
  expect(readFileSync(join(folder.cloudPath, "moved", "b.txt"), "utf8")).toBe("two");
  expect((await sync.ops(folder.id, { ops: [{ op: "delete", path: "deep/a.txt", baseSha256: sha("one") }] })).results).toEqual([{ ok: true }]);
  expect(existsSync(join(folder.cloudPath, "deep"))).toBe(false);
  expect(sync.trash().entries.map((entry) => entry.path)).toEqual(["deep/a.txt"]);
});

it("restores a deleted file, beside the new one when its name is taken", async () => {
  const { sync, folder } = setup({ now: () => new Date(2026, 9, 15, 12).getTime() });
  await put(sync, folder.id, "a.txt", "old", null);
  await sync.ops(folder.id, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("old") }] });
  const [entry] = sync.trash().entries;
  await put(sync, folder.id, "a.txt", "new", null);
  expect(await sync.restore(entry!.id)).toEqual({ folderId: folder.id, path: "a (restored, 15 Oct 2026).txt" });
  expect(readFileSync(join(folder.cloudPath, "a (restored, 15 Oct 2026).txt"), "utf8")).toBe("old");
  expect(sync.trash().entries).toEqual([]);
});

it("answers a long poll as soon as a folder changes, and every folder for a cursor it did not issue", async () => {
  const { sync, folder } = setup();
  const signal = new AbortController().signal;
  const all = await sync.changes(0, 60_000, signal);
  expect(all.folderIds).toEqual([folder.id]);
  const waiting = sync.changes(all.cursor, 60_000, signal);
  await put(sync, folder.id, "a.txt", "x", null);
  const woke = await waiting;
  expect(woke.folderIds).toEqual([folder.id]);
  expect(woke.cursor).toBeGreaterThan(all.cursor);
  // The watcher also reports the commit's own rename a moment later; let it land before checking for quiet.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const settled = await sync.changes(woke.cursor, 0, signal);
  const quiet = await sync.changes(settled.cursor, 20, signal);
  expect(quiet).toEqual({ cursor: settled.cursor, folderIds: [] });
});

it("notices a file a bot writes straight into a synced folder", async () => {
  const { sync, folder } = setup();
  const signal = new AbortController().signal;
  const { cursor } = await sync.changes(0, 60_000, signal);
  const waiting = sync.changes(cursor, 5_000, signal);
  writeFileSync(join(folder.cloudPath, "from-a-bot.md"), "written by a bot");
  expect((await waiting).folderIds).toContain(folder.id);
});
