import assert from "node:assert/strict";
import test from "node:test";
import { planFolder } from "./cloud-sync-plan.mjs";

const AT = new Date(2026, 9, 15, 12).getTime();
const f = (sha, size = 1, mtimeMs = 1) => ({ sha256: sha, size, mtimeMs });
const plan = ({ base = {}, pc = {}, cloud = {}, ...rest }) => planFolder({
  base: new Map(Object.entries(base)), pc: new Map(Object.entries(pc)), cloud: new Map(Object.entries(cloud)), now: AT, ...rest,
});
const types = (result) => result.actions.map((a) => `${a.type}:${a.path ?? `${a.from}->${a.to}`}`);

test("each row of the table", () => {
  assert.deepEqual(types(plan({ pc: { a: f("1") } })), ["upload:a"]);
  assert.equal(plan({ pc: { a: f("1") } }).actions[0].baseSha256, null);
  assert.deepEqual(types(plan({ cloud: { a: f("1") } })), ["download:a"]);
  assert.deepEqual(types(plan({ base: { a: f("1") }, pc: { a: f("2") }, cloud: { a: f("1") } })), ["upload:a"]);
  assert.equal(plan({ base: { a: f("1") }, pc: { a: f("2") }, cloud: { a: f("1") } }).actions[0].baseSha256, "1");
  assert.deepEqual(types(plan({ base: { a: f("1") }, pc: { a: f("1") }, cloud: { a: f("2") } })), ["download:a"]);
  assert.deepEqual(types(plan({ base: { a: f("1") }, pc: { a: f("1") }, cloud: { a: f("1") } })), []);
  assert.deepEqual(types(plan({ base: { a: f("1") }, cloud: { a: f("1") } })), ["deleteCloud:a"]);
  assert.deepEqual(types(plan({ base: { a: f("1") }, pc: { a: f("1") } })), ["deletePc:a"]);
  assert.deepEqual(types(plan({ base: { a: f("1") }, cloud: { a: f("2") } })), ["download:a"], "an edit beats a delete");
  assert.deepEqual(types(plan({ base: { a: f("1") }, pc: { a: f("2") } })), ["upload:a"], "an edit beats a delete");
  assert.deepEqual(types(plan({ base: { a: f("1") } })), ["forget:a"]);
});

test("both sides changed: same bytes are recorded, different bytes keep both", () => {
  assert.deepEqual(types(plan({ base: { a: f("1") }, pc: { a: f("2") }, cloud: { a: f("2") } })), ["record:a"]);
  const clash = plan({ base: { "r.docx": f("1") }, pc: { "r.docx": f("2", 5) }, cloud: { "r.docx": f("3", 7) } }).actions[0];
  assert.deepEqual(clash, { type: "clash", path: "r.docx", clashPath: "r (PC copy, 15 Oct 2026).docx", pcSha256: "2", pcSize: 5, cloudSha256: "3", cloudSize: 7 });
});

test("a first sync never deletes", () => {
  const result = plan({ pc: { a: f("1"), b: f("2") }, cloud: { b: f("2"), c: f("3") } });
  assert.deepEqual(types(result), ["upload:a", "record:b", "download:c"]);
  assert.equal(result.actions.some((a) => a.type.startsWith("delete")), false);
});

test("a file still being written waits", () => {
  assert.deepEqual(types(plan({ base: { a: f("1") }, pc: { a: { unsettled: true } }, cloud: { a: f("2") } })), []);
});

test("a rename travels as a move, not a delete and a fresh copy", () => {
  assert.deepEqual(types(plan({ base: { old: f("9") }, pc: { new: f("9") }, cloud: { old: f("9") } })), ["moveCloud:old->new"]);
  assert.deepEqual(types(plan({ base: { old: f("9") }, pc: { old: f("9") }, cloud: { new: f("9") } })), ["movePc:old->new"]);
});

test("a Cloud name this PC cannot hold is held back, never read as deleted", () => {
  const windows = plan({ base: {}, cloud: { "a:b.txt": f("1"), "ok.txt": f("2") }, windows: true });
  assert.deepEqual(types(windows), ["download:ok.txt"]);
  assert.deepEqual(windows.held, [{ path: "a:b.txt", reason: "windows-name" }]);
  const cased = plan({ pc: { "notes.txt": f("1") }, base: { "notes.txt": f("1") }, cloud: { "notes.txt": f("1"), "Notes.txt": f("2") }, caseInsensitive: true });
  assert.deepEqual(types(cased), []);
  assert.deepEqual(cased.held, [{ path: "Notes.txt", reason: "case-clash" }]);
});

test("a case-only rename on My Cloud renames on a case-insensitive PC instead of deleting", () => {
  const renamed = plan({ base: { "report.docx": f("1") }, pc: { "report.docx": f("1") }, cloud: { "Report.docx": f("1") }, caseInsensitive: true });
  assert.deepEqual(types(renamed), ["movePc:report.docx->Report.docx"]);
  assert.deepEqual(renamed.held, []);
  const changed = plan({ base: { "report.docx": f("1") }, pc: { "report.docx": f("1") }, cloud: { "Report.docx": f("2") }, caseInsensitive: true });
  assert.equal(changed.actions.some((action) => action.type === "deletePc"), false);
});
