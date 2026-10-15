# Cloud Folder Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One "Sync with My Cloud" switch in the desktop app that keeps every PC folder a bot is linked to, and every bot's output folder on My Cloud, the same on both sides, so Cloud bots can work on the person's files with the PC off.

**Architecture:** The desktop drives every pass. A pure planner compares each folder's base (the state when last in step), the PC and the Cloud, and emits actions; an engine carries them out over new `/api/sync/*` routes on the Cloud home, which lists files (hashes cached in SQLite), accepts whole files in resumable parts, serves them back and keeps replaced or deleted files in a 30-day trash. Synced PC folders live under `/data/Synced` on the Cloud and count against the plan's disk; when they do not fit, files wait behind an Upgrade button.

**Tech Stack:** Node 24 (`node:sqlite`, `fs.watch` recursive), TypeScript on type stripping (server), plain ESM `.mjs` with `.d.mts` (Electron 43 main process), React + Tailwind (renderer), vitest (server, renderer) and `node --test` (electron).

**Spec:** `docs/superpowers/specs/2026-10-15-cloud-folder-sync-design.md`

## Global Constraints

- Every command runs on Node 24: prefix with `export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" &&`. On the default Node 22 the suite fails in ways that look like regressions.
- Server code runs on type stripping: no `enum`, no namespaces, no constructor parameter properties; a type-only import is `import type` (or an inline `type`), or the server crashes at boot even though `tsc` passes.
- `electron/*.mjs` modules other than `main.mjs` never import `electron`; Electron objects are passed in. They never import `server/*` or `shared/*.ts`.
- The rules module lives at `electron/cloud-sync-rules.mjs` (the desktop package ships only `electron/**`); the server imports it from there.
- `server/index.ts` stays at exactly 17,972 lines. `electron/main.mjs` must not grow; after Task 15 its line in `scripts/testing/file-size-ratchet.test.ts` is lowered to the new count. Every new file stays under 1,000 lines.
- New routes are not added to `server/index.ts` (`scripts/testing/index-route-ratchet.test.ts`); `server/routes/table.ts` lists them in `ROUTES`.
- Copy says "My Cloud", "Sync with My Cloud", "this computer". Never "workspace", "OMB" or "Boat". New strings go only in `src/locales/en.json`; never reword an existing key.
- Paths on the wire: relative, `/`-separated, NFC (`validWirePath`).
- Constants: `RESERVE_BYTES` = 1 GiB; `CHUNK_BYTES` = 16 MiB, halved on HTTP 413 down to `MIN_CHUNK_BYTES` = 512 KiB; `QUIET_MS` = 2 s; `TRASH_DAYS` = 30; full pass every 5 min; change long poll 60 s; 2 transfers at a time; PC watcher debounce 1 s; an upload left 24 h is dropped; a download temp file left 24 h is removed.
- Cloud layout: sync root `OMB_SYNC_ROOT` or `join(dirname(DATA_DIR), "Synced")`; registry `DATA_DIR/sync/folders.json`; index `DATA_DIR/sync/index.db`; uploads `DATA_DIR/sync/uploads/`; trash `DATA_DIR/sync/trash/`.
- PC layout for bot output: `<Documents>/MausBot/<Bot name>/<Conversation title>`, named once and never renamed.
- Clash copy name: `<stem> (PC copy, 15 Oct 2026)<ext>`, then `… 15 Oct 2026 2)`; the Cloud's version keeps the name.
- `/api/sync/*` answers only on a Cloud home, only to a session with admin scope.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push and never open a PR.

## Review Focus

1. **A synced folder vanishes on My Cloud** (a bot runs `rm -rf` on it): the PC copy must be left exactly as it is and the folder shown as missing. Pinned by Task 5 (the server answers 410 for a folder whose Cloud root is gone) and Task 13 (the engine deletes nothing on 410).
2. **Near full, one big file and many small ones**: the small files keep syncing and only what does not fit waits. Pinned by Task 13 (uploads run smallest first; test with a file larger than the room left).
3. **The app quits mid-transfer**: sync's own `.omb-sync-*` download files are never synced, a fresh one is resumed, a stale one is removed. Pinned by Task 1 (`skipped`) and Task 13.
4. **Signed in to a different Cloud** while sync is on: no old base applies, and the next pass is a first sync that deletes nothing. Pinned by Task 14.
5. **A file the PC cannot touch right now** (open in Excel: `EBUSY`/`EPERM`): the pass carries on, the file is retried, and it is listed only after three failures. Pinned by Task 13.

---

### Task 1: Sync rules shared by both sides

**Files:**
- Create: `electron/cloud-sync-rules.mjs`
- Create: `electron/cloud-sync-rules.d.mts`
- Test: `electron/cloud-sync-rules.node-test.mjs`

**Interfaces:**
- Produces: `RESERVE_BYTES`, `CHUNK_BYTES`, `MIN_CHUNK_BYTES`, `QUIET_MS`, `TRASH_DAYS` (numbers); `skipped(name: string, directory: boolean): boolean`; `validWirePath(path: unknown): path is string`; `windowsProblem(path: string): "characters" | "trailing" | "reserved" | null`; `foldKey(path: string): string`; `clashPath(path: string, at: number, taken: (path: string) => boolean, label?: string): string`; `safeFolderName(name: string, taken: ReadonlySet<string>): string` (`taken` holds `foldKey`s).

- [ ] **Step 1: Write the failing test**

```js
// electron/cloud-sync-rules.node-test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { clashPath, foldKey, safeFolderName, skipped, validWirePath, windowsProblem } from "./cloud-sync-rules.mjs";

test("skips build folders, system litter, lock and temporary files, and sync's own downloads", () => {
  for (const dir of ["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".cache"]) assert.equal(skipped(dir, true), true, dir);
  assert.equal(skipped("src", true), false);
  for (const file of [".DS_Store", "Thumbs.db", "desktop.ini", "~$port.docx", "draft.tmp", "movie.crdownload", "a.part", ".~lock.sheet.ods#", ".Report.docx.omb-sync-1a2b3c4d"]) {
    assert.equal(skipped(file, false), true, file);
  }
  assert.equal(skipped("Report.docx", false), false);
  assert.equal(skipped("node_modules", false), false, "only a directory by that name is skipped");
});

test("a wire path is relative, slash-separated and NFC", () => {
  for (const good of ["a.txt", "a/b.txt", "Caf\u00e9/x.md"]) assert.equal(validWirePath(good), true, good);
  for (const bad of ["", "/a", "a//b", "a/./b", "../a", "a/..", "a\\b", "a\0b", "Cafe\u0301.txt", 7, null]) assert.equal(validWirePath(bad), false, String(bad));
});

test("names a Windows PC cannot hold", () => {
  assert.equal(windowsProblem("a/b:c.txt"), "characters");
  assert.equal(windowsProblem("notes./x"), "trailing");
  assert.equal(windowsProblem("notes /x"), "trailing");
  assert.equal(windowsProblem("CON.txt"), "reserved");
  assert.equal(windowsProblem("x/lpt9"), "reserved");
  assert.equal(windowsProblem("Reports/Q3.xlsx"), null);
});

test("case and Unicode form fold together", () => {
  assert.equal(foldKey("Caf\u00e9/A.txt"), foldKey("cafe\u0301/a.TXT"));
  assert.notEqual(foldKey("a.txt"), foldKey("b.txt"));
});

test("a clash copy is named for the PC and the day, then numbered", () => {
  const at = new Date(2026, 9, 15, 12).getTime();
  assert.equal(clashPath("docs/report.docx", at, () => false), "docs/report (PC copy, 15 Oct 2026).docx");
  const taken = new Set(["docs/report (PC copy, 15 Oct 2026).docx"]);
  assert.equal(clashPath("docs/report.docx", at, (path) => taken.has(path)), "docs/report (PC copy, 15 Oct 2026 2).docx");
  assert.equal(clashPath("Makefile", at, () => false), "Makefile (PC copy, 15 Oct 2026)");
  assert.equal(clashPath(".env", at, () => false), ".env (PC copy, 15 Oct 2026)");
  assert.equal(clashPath("a.txt", at, () => false, "restored"), "a (restored, 15 Oct 2026).txt");
});

test("folder names both Windows and macOS hold, without clashing", () => {
  assert.equal(safeFolderName("Q3: plan?", new Set()), "Q3- plan-");
  assert.equal(safeFolderName("notes. ", new Set()), "notes");
  assert.equal(safeFolderName("CON", new Set()), "CON_");
  assert.equal(safeFolderName("   ", new Set()), "Untitled");
  assert.equal(safeFolderName("Research", new Set(["research"])), "Research (2)");
  assert.equal(safeFolderName("Research", new Set(["research", "research (2)"])), "Research (3)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/cloud-sync-rules.node-test.mjs`
Expected: FAIL with `Cannot find module '.../electron/cloud-sync-rules.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// electron/cloud-sync-rules.mjs
// What Sync with My Cloud never carries, and the name rules between a PC (Windows or macOS) and the Linux Cloud. One
// module for both sides: the desktop imports it directly, the Cloud's server through its bundle.

export const RESERVE_BYTES = 1024 ** 3;
export const CHUNK_BYTES = 16 * 1024 ** 2;
export const MIN_CHUNK_BYTES = 512 * 1024;
export const QUIET_MS = 2_000;
export const TRASH_DAYS = 30;

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".next", ".turbo", ".cache"]);
const SKIP_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_CHARACTERS = /[<>:"\\|?*\u0000-\u001f]/;

/** True for a directory or file sync never carries, including its own half-downloaded files. */
export function skipped(name, directory) {
  if (directory) return SKIP_DIRS.has(name);
  return SKIP_FILES.has(name.toLowerCase()) || name.startsWith("~$") || /\.(?:tmp|crdownload|part)$/i.test(name)
    || /^\.~lock\..*#$/.test(name) || /\.omb-sync-[0-9a-f]+$/.test(name);
}

/** A path as it travels: relative, "/"-separated, NFC, with no empty, "." or ".." part. */
export function validWirePath(path) {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
  if (path !== path.normalize("NFC")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Why a Windows PC cannot hold this path, or null. */
export function windowsProblem(path) {
  for (const part of path.split("/")) {
    if (WINDOWS_CHARACTERS.test(part)) return "characters";
    if (/[. ]$/.test(part)) return "trailing";
    if (WINDOWS_RESERVED.test(part)) return "reserved";
  }
  return null;
}

/** Equal for two paths a case-insensitive PC treats as one. */
export function foldKey(path) {
  return path.normalize("NFC").toLowerCase();
}

/** The PC copy's name in a clash, "report (PC copy, 15 Oct 2026).docx", numbered past any name `taken` says is used. */
export function clashPath(path, at, taken, label = "PC copy") {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  const date = new Date(at);
  const day = `${label}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  for (let n = 1; ; n++) {
    const candidate = `${dir}${stem} (${day}${n === 1 ? "" : ` ${n}`})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** A folder name Windows and macOS both hold, not already in `taken` (a set of foldKeys). */
export function safeFolderName(name, taken) {
  let safe = String(name).normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().replace(/[. ]+$/, "").slice(0, 80);
  if (!safe) safe = "Untitled";
  if (WINDOWS_RESERVED.test(safe)) safe = `${safe}_`;
  let candidate = safe;
  for (let n = 2; taken.has(foldKey(candidate)); n++) candidate = `${safe} (${n})`;
  return candidate;
}
```

```ts
// electron/cloud-sync-rules.d.mts
export declare const RESERVE_BYTES: number;
export declare const CHUNK_BYTES: number;
export declare const MIN_CHUNK_BYTES: number;
export declare const QUIET_MS: number;
export declare const TRASH_DAYS: number;
export declare function skipped(name: string, directory: boolean): boolean;
export declare function validWirePath(path: unknown): path is string;
export declare function windowsProblem(path: string): "characters" | "trailing" | "reserved" | null;
export declare function foldKey(path: string): string;
export declare function clashPath(path: string, at: number, taken: (path: string) => boolean, label?: string): string;
export declare function safeFolderName(name: string, taken: ReadonlySet<string>): string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/cloud-sync-rules.node-test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/cloud-sync-rules.mjs electron/cloud-sync-rules.d.mts electron/cloud-sync-rules.node-test.mjs
git commit -m "feat(sync): rules both sides of Sync with My Cloud share

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The three-way planner

**Files:**
- Create: `electron/cloud-sync-plan.mjs`
- Test: `electron/cloud-sync-plan.node-test.mjs`

**Interfaces:**
- Consumes: `clashPath`, `foldKey`, `windowsProblem` (Task 1).
- Produces: `planFolder({ base, pc, cloud, windows?, caseInsensitive?, now? }) → { actions, held }`, where
  - `base: Map<path, { sha256, size, mtimeMs }>`
  - `pc: Map<path, { sha256, size, mtimeMs } | { unsettled: true }>`
  - `cloud: Map<path, { sha256, size, mtimeMs }>`
  - `held: Array<{ path, reason: "windows-name" | "case-clash" }>` (Cloud files this PC cannot hold)
  - `actions`, each one of:
    - `{ type: "upload", path, sha256, size, mtimeMs, baseSha256: string | null }`
    - `{ type: "download", path, sha256, size }`
    - `{ type: "deleteCloud", path, baseSha256 }`
    - `{ type: "deletePc", path, sha256 }`
    - `{ type: "clash", path, clashPath, pcSha256, pcSize, cloudSha256, cloudSize }`
    - `{ type: "record", path, sha256, size, mtimeMs }`
    - `{ type: "forget", path }`
    - `{ type: "moveCloud", from, to, sha256, size, mtimeMs }`
    - `{ type: "movePc", from, to, sha256, size }`

- [ ] **Step 1: Write the failing test**

```js
// electron/cloud-sync-plan.node-test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/cloud-sync-plan.node-test.mjs`
Expected: FAIL with `Cannot find module '.../electron/cloud-sync-plan.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// electron/cloud-sync-plan.mjs
// One folder's decisions for Sync with My Cloud: compare the base (each file as it was when last in step on both
// sides), the PC and the Cloud, and say what to do. No I/O. With no base nothing reads as deleted, so a first sync, or
// one after the record was lost, never deletes.
import { clashPath, foldKey, windowsProblem } from "./cloud-sync-rules.mjs";

export function planFolder({ base, pc, cloud, windows = false, caseInsensitive = false, now = Date.now() }) {
  const held = [];
  const visible = new Map();
  const localSpelling = new Map();
  if (caseInsensitive) for (const path of [...base.keys(), ...pc.keys()]) localSpelling.set(foldKey(path), path);
  const seen = new Set();
  for (const path of [...cloud.keys()].sort()) {
    if (windows && windowsProblem(path)) { held.push({ path, reason: "windows-name" }); continue; }
    if (caseInsensitive) {
      const key = foldKey(path);
      const local = localSpelling.get(key);
      if (seen.has(key) || (local !== undefined && local !== path)) { held.push({ path, reason: "case-clash" }); continue; }
      seen.add(key);
    }
    visible.set(path, cloud.get(path));
  }
  const taken = (path) => pc.has(path) || cloud.has(path);
  const actions = [];
  for (const path of [...new Set([...base.keys(), ...pc.keys(), ...visible.keys()])].sort()) {
    if (cloud.has(path) && !visible.has(path)) continue;
    const b = base.get(path), l = pc.get(path), c = visible.get(path);
    if (l?.unsettled) continue;
    const local = !l ? (b ? "deleted" : "absent") : !b ? "new" : l.sha256 === b.sha256 ? "same" : "changed";
    const remote = !c ? (b ? "deleted" : "absent") : !b ? "new" : c.sha256 === b.sha256 ? "same" : "changed";
    switch (`${local}/${remote}`) {
      case "new/absent":
      case "changed/deleted":
        actions.push({ type: "upload", path, sha256: l.sha256, size: l.size, mtimeMs: l.mtimeMs, baseSha256: null });
        break;
      case "changed/same":
        actions.push({ type: "upload", path, sha256: l.sha256, size: l.size, mtimeMs: l.mtimeMs, baseSha256: b.sha256 });
        break;
      case "absent/new":
      case "same/changed":
      case "deleted/changed":
        actions.push({ type: "download", path, sha256: c.sha256, size: c.size });
        break;
      case "new/new":
      case "changed/changed":
        if (l.sha256 === c.sha256) actions.push({ type: "record", path, sha256: l.sha256, size: l.size, mtimeMs: l.mtimeMs });
        else actions.push({ type: "clash", path, clashPath: clashPath(path, now, taken), pcSha256: l.sha256, pcSize: l.size, cloudSha256: c.sha256, cloudSize: c.size });
        break;
      case "deleted/same":
        actions.push({ type: "deleteCloud", path, baseSha256: b.sha256 });
        break;
      case "same/deleted":
        actions.push({ type: "deletePc", path, sha256: b.sha256 });
        break;
      case "deleted/deleted":
        actions.push({ type: "forget", path });
        break;
      default:
        break;
    }
  }
  return { actions: pairRenames(actions), held };
}

// A delete on one side and a new file with the same bytes on that side is a rename: move it on the other side.
function pairRenames(actions) {
  const out = [...actions];
  const pair = (gone, arrived, make) => {
    for (const removed of out.filter((action) => action.type === gone)) {
      const sha = removed.baseSha256 ?? removed.sha256;
      const added = out.find((action) => action.type === arrived && action.sha256 === sha && (arrived !== "upload" || action.baseSha256 === null));
      if (!added) continue;
      out.splice(out.indexOf(removed), 1);
      out.splice(out.indexOf(added), 1, make(removed, added));
    }
  };
  pair("deleteCloud", "upload", (removed, added) => ({ type: "moveCloud", from: removed.path, to: added.path, sha256: added.sha256, size: added.size, mtimeMs: added.mtimeMs }));
  pair("deletePc", "download", (removed, added) => ({ type: "movePc", from: removed.path, to: added.path, sha256: added.sha256, size: added.size }));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/cloud-sync-plan.node-test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/cloud-sync-plan.mjs electron/cloud-sync-plan.node-test.mjs
git commit -m "feat(sync): three-way planner for one synced folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cloud paths and the folder registry

**Files:**
- Create: `server/cloud-sync-paths.ts`
- Create: `server/cloud-sync-store.ts` (registry part; Task 4 adds the index and trash)
- Test: `server/cloud-sync-store.test.ts`

**Interfaces:**
- Consumes: `foldKey`, `safeFolderName`, `skipped`, `validWirePath` (Task 1); `writeFileAtomic(path, data, { mode })` from `server/atomic.ts`.
- Produces:
  - `syncRoot(dataDir: string, env?: NodeJS.ProcessEnv): string`
  - `insideFolder(folder: string, wirePath: unknown): string`, throwing `SyncPathError`
  - `interface SyncFolder { id; kind: "pc" | "bot"; cloudPath; computerId?; computerName?; pcPath?; botId?; threadId?; createdAt? }`
  - `class CloudSyncStore` with `{ dataDir, root, now, db }`, `syncDir()`, `pcFolders()`, `botFolders()`, `folders()`, `folder(id)`, `register({ computerId, computerName, pcPath, name })`, `unregister(id)` and `close()`
  - `function* walk(root): Generator<{ path, size, mtimeMs }>`
  - `syncedFolders(dataDir): Array<{ computerName, pcPath, cloudPath }>`

- [ ] **Step 1: Write the failing test**

```ts
// server/cloud-sync-store.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run server/cloud-sync-store.test.ts`
Expected: FAIL with `Failed to load url ./cloud-sync-paths.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// server/cloud-sync-paths.ts
// Where synced files live on a Cloud home, and the one way a request's path becomes a file: inside its folder, never
// through a link.
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { validWirePath } from "../electron/cloud-sync-rules.mjs";

export class SyncPathError extends Error {}

export function syncRoot(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.OMB_SYNC_ROOT || join(dirname(dataDir), "Synced");
}

/** The absolute path of `wirePath` inside `folder`. Refuses a malformed path, and any existing part that is a link. */
export function insideFolder(folder: string, wirePath: unknown): string {
  if (!validWirePath(wirePath)) throw new SyncPathError("invalid path");
  let current = folder;
  for (const part of wirePath.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new SyncPathError("the path goes through a link");
  }
  return join(folder, ...wirePath.split("/"));
}
```

```ts
// server/cloud-sync-store.ts
// The Cloud side of folder sync's records: which PC folders sync (folders.json), what each synced folder holds with
// hashes cached by size and modified time (index.db), and the trash. Bot output folders are not stored: they are the
// conversation folders under task-workspaces that hold a file.
import { mkdirSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./atomic.ts";
import { foldKey, safeFolderName, skipped, validWirePath } from "../electron/cloud-sync-rules.mjs";
import { syncRoot } from "./cloud-sync-paths.ts";

export interface SyncFolder {
  id: string;
  kind: "pc" | "bot";
  cloudPath: string;
  computerId?: string;
  computerName?: string;
  pcPath?: string;
  botId?: string;
  threadId?: string;
  createdAt?: number;
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const pcKey = (path: string) => WINDOWS_PATH.test(path) ? path.replaceAll("\\", "/").toLowerCase() : path;

function directories(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return []; }
}

/** Regular, singly linked files under `root` as wire paths. Skips links, sync's skip list and names that cannot travel. */
export function* walk(root: string, prefix = ""): Generator<{ path: string; size: number; mtimeMs: number }> {
  let entries;
  try { entries = readdirSync(prefix ? join(root, ...prefix.split("/")) : root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (skipped(entry.name, entry.isDirectory()) || !validWirePath(path)) continue;
    if (entry.isDirectory()) { yield* walk(root, path); continue; }
    if (!entry.isFile()) continue;
    const stat = lstatSync(join(root, ...path.split("/")), { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1) continue;
    yield { path, size: stat.size, mtimeMs: stat.mtimeMs };
  }
}

function readFolders(dataDir: string): SyncFolder[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, "sync", "folders.json"), "utf8"));
    return Array.isArray(value)
      ? value.filter((folder): folder is SyncFolder => typeof folder?.id === "string" && folder.kind === "pc" && typeof folder.cloudPath === "string")
      : [];
  } catch { return []; }
}

/** For the Cloud prompt: each synced PC folder and where it is here. */
export function syncedFolders(dataDir: string): Array<{ computerName: string; pcPath: string; cloudPath: string }> {
  return readFolders(dataDir).map((folder) => ({ computerName: folder.computerName ?? "", pcPath: folder.pcPath ?? "", cloudPath: folder.cloudPath }));
}

export class CloudSyncStore {
  dataDir: string;
  root: string;
  now: () => number;
  db: DatabaseSync;

  constructor(options: { dataDir: string; root?: string; now?: () => number }) {
    this.dataDir = options.dataDir;
    this.root = options.root ?? syncRoot(options.dataDir);
    this.now = options.now ?? Date.now;
    for (const dir of [this.syncDir(), join(this.syncDir(), "uploads"), join(this.syncDir(), "trash"), this.root]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.syncDir(), "index.db"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS files(folder TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(folder, path));
      CREATE TABLE IF NOT EXISTS trash(id TEXT PRIMARY KEY, folder TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, deleted_at INTEGER NOT NULL);`);
  }

  syncDir(): string { return join(this.dataDir, "sync"); }
  close(): void { this.db.close(); }

  pcFolders(): SyncFolder[] { return readFolders(this.dataDir); }

  botFolders(): SyncFolder[] {
    const base = join(this.dataDir, "task-workspaces");
    const folders: SyncFolder[] = [];
    for (const botId of directories(base)) {
      for (const threadId of directories(join(base, botId))) {
        const cloudPath = join(base, botId, threadId);
        if (!ID.test(botId) || !ID.test(threadId) || walk(cloudPath).next().done) continue;
        folders.push({ id: `bot-${botId}-${threadId}`, kind: "bot", botId, threadId, cloudPath });
      }
    }
    return folders;
  }

  folders(): SyncFolder[] { return [...this.pcFolders(), ...this.botFolders()]; }
  folder(id: string): SyncFolder | undefined { return this.folders().find((folder) => folder.id === id); }

  register(input: { computerId: string; computerName: string; pcPath: string; name: string }): SyncFolder {
    const folders = this.pcFolders();
    const existing = folders.find((folder) => folder.computerId === input.computerId && pcKey(folder.pcPath ?? "") === pcKey(input.pcPath));
    if (existing) { mkdirSync(existing.cloudPath, { recursive: true, mode: 0o700 }); return existing; }
    const sibling = folders.find((folder) => folder.computerId === input.computerId);
    const computerDir = sibling
      ? relative(this.root, sibling.cloudPath).split(sep)[0]!
      : safeFolderName(input.computerName, new Set(directories(this.root).map(foldKey)));
    const name = safeFolderName(input.name, new Set(directories(join(this.root, computerDir)).map(foldKey)));
    const folder: SyncFolder = {
      id: randomUUID(), kind: "pc", computerId: input.computerId, computerName: input.computerName, pcPath: input.pcPath,
      cloudPath: join(this.root, computerDir, name), createdAt: this.now(),
    };
    mkdirSync(folder.cloudPath, { recursive: true, mode: 0o700 });
    this.saveFolders([...folders, folder]);
    return folder;
  }

  unregister(id: string): SyncFolder | null {
    const folders = this.pcFolders();
    const folder = folders.find((entry) => entry.id === id) ?? null;
    if (!folder) return null;
    this.saveFolders(folders.filter((entry) => entry.id !== id));
    this.db.prepare("DELETE FROM files WHERE folder = ?").run(id);
    return folder;
  }

  saveFolders(folders: SyncFolder[]): void {
    writeFileAtomic(join(this.syncDir(), "folders.json"), JSON.stringify(folders), { mode: 0o600 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run server/cloud-sync-store.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/cloud-sync-paths.ts server/cloud-sync-store.ts server/cloud-sync-store.test.ts
git commit -m "feat(sync): Cloud folder registry and safe paths for synced folders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Cloud index (hash cache) and trash records

**Files:**
- Modify: `server/cloud-sync-store.ts`
- Test: `server/cloud-sync-store.test.ts` (append)

**Interfaces:**
- Consumes: `CloudSyncStore` and `walk` (Task 3); `TRASH_DAYS` (Task 1).
- Produces:
  - `interface SyncFile { path; size; mtimeMs; sha256 }`
  - `interface TrashEntry { id; folderId; path; size; deletedAt }`
  - `sha256File(path): Promise<string>`
  - `CloudSyncStore` methods:
    - `list(folder): Promise<SyncFile[]>`
    - `current(folder, path): Promise<SyncFile | null>`
    - `remember(folder, file)` and `forget(folder, path)`
    - `bytesByKind(): { pc, bot }`
    - `toTrash(folder, path, file): TrashEntry`, `trash(): TrashEntry[]`, `trashEntry(id): { entry, file } | null`, `dropTrash(id)`, `sweepTrash()`, `trashBytes(): number`

- [ ] **Step 1: Write the failing test** (append to `server/cloud-sync-store.test.ts`; add `readFileSync, utimesSync` to the `node:fs` import)

```ts
it("lists a folder with hashes, hashing again only what changed", async () => {
  const { store } = setup();
  const folder = store.register({ computerId: PC, computerName: "Ash-PC", pcPath: "/Users/ash/PA", name: "PA" });
  mkdirSync(join(folder.cloudPath, "sub"));
  const file = join(folder.cloudPath, "sub", "a.txt");
  writeFileSync(file, "one");
  utimesSync(file, new Date(1_000), new Date(1_000));
  writeFileSync(join(folder.cloudPath, "Thumbs.db"), "litter");
  symlinkSync("/etc/hosts", join(folder.cloudPath, "link.txt"));
  const [first] = await store.list(folder);
  expect(first).toMatchObject({ path: "sub/a.txt", size: 3, sha256: "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed" });
  writeFileSync(file, "two");
  utimesSync(file, new Date(1_000), new Date(1_000));
  expect((await store.list(folder))[0]!.sha256).toBe(first!.sha256);
  utimesSync(file, new Date(5_000), new Date(5_000));
  expect((await store.list(folder))[0]!.sha256).not.toBe(first!.sha256);
  expect(store.bytesByKind()).toEqual({ pc: 3, bot: 0 });
});

it("keeps a removed file in the trash for 30 days", async () => {
  let now = 1_000;
  const home = mkdtempSync(join(tmpdir(), "omb-sync-trash-"));
  scratch.push(home);
  const store = new CloudSyncStore({ dataDir: join(home, ".openmausbot"), now: () => now });
  stores.push(store);
  const folder = store.register({ computerId: PC, computerName: "PC", pcPath: "/p", name: "P" });
  writeFileSync(join(folder.cloudPath, "a.txt"), "hello");
  await store.list(folder);
  const entry = store.toTrash(folder, "a.txt", join(folder.cloudPath, "a.txt"));
  expect(existsSync(join(folder.cloudPath, "a.txt"))).toBe(false);
  expect(store.trash()).toEqual([{ id: entry.id, folderId: folder.id, path: "a.txt", size: 5, deletedAt: 1_000 }]);
  expect(store.trashBytes()).toBe(5);
  expect(readFileSync(store.trashEntry(entry.id)!.file, "utf8")).toBe("hello");
  expect(await store.current(folder, "a.txt")).toBeNull();
  now += 29 * 86_400_000;
  store.sweepTrash();
  expect(store.trash()).toHaveLength(1);
  now += 2 * 86_400_000;
  store.sweepTrash();
  expect(store.trash()).toEqual([]);
  expect(store.trashBytes()).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run server/cloud-sync-store.test.ts`
Expected: FAIL with `store.list is not a function`.

- [ ] **Step 3: Write the implementation**

Change `server/cloud-sync-store.ts`'s imports to:

```ts
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { TRASH_DAYS, foldKey, safeFolderName, skipped, validWirePath } from "../electron/cloud-sync-rules.mjs";
```

Add next to `SyncFolder`:

```ts
export interface SyncFile { path: string; size: number; mtimeMs: number; sha256: string }
export interface TrashEntry { id: string; folderId: string; path: string; size: number; deletedAt: number }

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

type FileRow = { path: string; size: number; mtime: number; sha256: string };
type TrashRow = { id: string; folder: string; path: string; size: number; deleted_at: number };
const trashEntryOf = (row: TrashRow): TrashEntry => ({ id: row.id, folderId: row.folder, path: row.path, size: row.size, deletedAt: row.deleted_at });
```

Add these methods to `CloudSyncStore`:

```ts
  /** What a folder holds now. Rescans, and hashes only files whose size or modified time changed since last time. */
  async list(folder: SyncFolder): Promise<SyncFile[]> {
    const cached = new Map<string, SyncFile>();
    for (const row of this.db.prepare("SELECT path, size, mtime, sha256 FROM files WHERE folder = ?").all(folder.id) as FileRow[]) {
      cached.set(row.path, { path: row.path, size: row.size, mtimeMs: row.mtime, sha256: row.sha256 });
    }
    const files: SyncFile[] = [];
    for (const entry of walk(folder.cloudPath)) {
      const hit = cached.get(entry.path);
      cached.delete(entry.path);
      if (hit && hit.size === entry.size && hit.mtimeMs === entry.mtimeMs) { files.push(hit); continue; }
      let sha256: string;
      try { sha256 = await sha256File(join(folder.cloudPath, ...entry.path.split("/"))); } catch { continue; }
      const file = { ...entry, sha256 };
      this.remember(folder, file);
      files.push(file);
    }
    for (const path of cached.keys()) this.forget(folder, path);
    return files;
  }

  /** The file at `path` now, hashed through the cache; null when there is none. */
  async current(folder: SyncFolder, path: string): Promise<SyncFile | null> {
    const file = join(folder.cloudPath, ...path.split("/"));
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1) return null;
    const row = this.db.prepare("SELECT path, size, mtime, sha256 FROM files WHERE folder = ? AND path = ?").get(folder.id, path) as FileRow | undefined;
    if (row && row.size === stat.size && row.mtime === stat.mtimeMs) return { path, size: stat.size, mtimeMs: stat.mtimeMs, sha256: row.sha256 };
    const current = { path, size: stat.size, mtimeMs: stat.mtimeMs, sha256: await sha256File(file) };
    this.remember(folder, current);
    return current;
  }

  remember(folder: SyncFolder, file: SyncFile): void {
    this.db.prepare("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)").run(folder.id, file.path, file.size, file.mtimeMs, file.sha256);
  }

  forget(folder: SyncFolder, path: string): void {
    this.db.prepare("DELETE FROM files WHERE folder = ? AND path = ?").run(folder.id, path);
  }

  bytesByKind(): { pc: number; bot: number } {
    let pc = 0, bot = 0;
    for (const row of this.db.prepare("SELECT folder, SUM(size) AS bytes FROM files GROUP BY folder").all() as Array<{ folder: string; bytes: number }>) {
      if (row.folder.startsWith("bot-")) bot += row.bytes; else pc += row.bytes;
    }
    return { pc, bot };
  }

  toTrash(folder: SyncFolder, path: string, file: string): TrashEntry {
    const entry: TrashEntry = { id: randomUUID(), folderId: folder.id, path, size: lstatSync(file).size, deletedAt: this.now() };
    renameSync(file, join(this.syncDir(), "trash", entry.id));
    this.db.prepare("INSERT INTO trash VALUES (?, ?, ?, ?, ?)").run(entry.id, entry.folderId, entry.path, entry.size, entry.deletedAt);
    this.forget(folder, path);
    return entry;
  }

  trash(): TrashEntry[] {
    return (this.db.prepare("SELECT * FROM trash ORDER BY deleted_at DESC LIMIT 200").all() as TrashRow[]).map(trashEntryOf);
  }

  trashEntry(id: string): { entry: TrashEntry; file: string } | null {
    const row = this.db.prepare("SELECT * FROM trash WHERE id = ?").get(id) as TrashRow | undefined;
    return row ? { entry: trashEntryOf(row), file: join(this.syncDir(), "trash", row.id) } : null;
  }

  dropTrash(id: string): void {
    this.db.prepare("DELETE FROM trash WHERE id = ?").run(id);
    rmSync(join(this.syncDir(), "trash", id), { force: true });
  }

  sweepTrash(): void {
    const cutoff = this.now() - TRASH_DAYS * 86_400_000;
    for (const row of this.db.prepare("SELECT id FROM trash WHERE deleted_at < ?").all(cutoff) as Array<{ id: string }>) this.dropTrash(row.id);
  }

  trashBytes(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM trash").get() as { bytes: number }).bytes;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run server/cloud-sync-store.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/cloud-sync-store.ts server/cloud-sync-store.test.ts
git commit -m "feat(sync): Cloud hash cache for synced folders and a 30-day trash

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Cloud service: summary, registration, listing, uploads and commits

**Files:**
- Create: `server/cloud-sync.ts`
- Test: `server/cloud-sync.test.ts`

**Interfaces:**
- Consumes: `CloudSyncStore`, `SyncFile`, `SyncFolder`, `sha256File`, `walk` (Tasks 3–4); `insideFolder`, `SyncPathError` (Task 3); `RESERVE_BYTES`, `validWirePath` (Task 1).
- Produces:
  - `class SyncError extends Error { status: number; body: Record<string, unknown> }`
  - `createCloudSync({ dataDir, root?, now?, statfs? })` returns an object with:
    - `store`
    - `summary(): { folders, cursor, disk: { totalBytes, freeBytes, syncedBytes, botFileBytes, trashBytes, reserveBytes } }`
    - `register(body): SyncFolder` and `unregister(id, keepCloudCopy)`
    - `files(id): Promise<SyncFile[]>`, throwing `SyncError(410)` when the folder's Cloud root is gone
    - `beginUpload(id, body): { uploadId, received }`, with 507 when it does not fit
    - `writePart(uploadId, offset, body: AsyncIterable<Buffer>): Promise<{ received }>`
    - `commit(uploadId): Promise<{ sha256 }>`
    - `trash(): { entries: TrashEntry[] }`
    - `noteChange(folderId)`, and `close()`
  - `type CloudSync = ReturnType<typeof createCloudSync>`. Task 6 adds `download`, `ops` and `restore`; Task 7 adds `changes`.

- [ ] **Step 1: Write the failing test**

```ts
// server/cloud-sync.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run server/cloud-sync.test.ts`
Expected: FAIL with `Failed to load url ./cloud-sync.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// server/cloud-sync.ts
// Folder sync on a Cloud home: what the /api/sync routes do. The desktop drives every pass; this side lists, takes whole
// files in resumable parts, serves them back, and keeps what it replaces or removes in the trash.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { RESERVE_BYTES, validWirePath } from "../electron/cloud-sync-rules.mjs";
import { SyncPathError, insideFolder } from "./cloud-sync-paths.ts";
import { CloudSyncStore, sha256File, walk, type SyncFile, type SyncFolder } from "./cloud-sync-store.ts";

const PART_MAX = 64 * 1024 ** 2;
const UPLOAD_STALE_MS = 24 * 60 * 60_000;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGE_LOG = 1_000;

export class SyncError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? status));
    this.status = status;
    this.body = body;
  }
}

interface Upload { id: string; folderId: string; path: string; size: number; sha256: string; baseSha256: string | null; received: number; updatedAt: number }

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");

export function createCloudSync(options: { dataDir: string; root?: string; now?: () => number; statfs?: (path: string) => { totalBytes: number; freeBytes: number } }) {
  const store = new CloudSyncStore(options);
  const now = options.now ?? Date.now;
  const statfs = options.statfs ?? ((path: string) => { const stats = statfsSync(path); return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }; });
  const uploadsDir = join(store.syncDir(), "uploads");
  let cursor = now();
  const changes: Array<{ seq: number; folderId: string }> = [];
  const waiters = new Set<() => void>();

  const folderOf = (id: string): SyncFolder => {
    const folder = store.folder(id);
    if (!folder) throw new SyncError(404, { error: "no such synced folder" });
    if (!existsSync(folder.cloudPath)) throw new SyncError(410, { error: "this folder is missing on My Cloud" });
    return folder;
  };
  const fileOf = (folder: SyncFolder, path: unknown): string => {
    try { return insideFolder(folder.cloudPath, path); } catch (error) {
      if (error instanceof SyncPathError) throw new SyncError(400, { error: error.message });
      throw error;
    }
  };
  const noteChange = (folderId: string) => {
    changes.push({ seq: ++cursor, folderId });
    if (changes.length > CHANGE_LOG) changes.shift();
    for (const wake of [...waiters]) wake();
  };
  const disk = () => {
    const { totalBytes, freeBytes } = statfs(store.root);
    const { pc, bot } = store.bytesByKind();
    return { totalBytes, freeBytes, syncedBytes: pc, botFileBytes: bot, trashBytes: store.trashBytes(), reserveBytes: RESERVE_BYTES };
  };
  const uploadFile = (id: string, ext: "json" | "part") => join(uploadsDir, `${id}.${ext}`);
  const readUpload = (id: string): Upload => {
    if (!UUID.test(id)) throw new SyncError(404, { error: "no such upload" });
    try { return JSON.parse(readFileSync(uploadFile(id, "json"), "utf8")) as Upload; } catch { throw new SyncError(404, { error: "no such upload" }); }
  };
  const saveUpload = (upload: Upload) => writeFileAtomic(uploadFile(upload.id, "json"), JSON.stringify(upload), { mode: 0o600 });
  const dropUpload = (id: string) => { rmSync(uploadFile(id, "json"), { force: true }); rmSync(uploadFile(id, "part"), { force: true }); };
  const uploads = (): Upload[] => {
    const found: Upload[] = [];
    for (const name of readdirSync(uploadsDir)) {
      if (!name.endsWith(".json")) continue;
      try { found.push(readUpload(name.slice(0, -5))); } catch { rmSync(join(uploadsDir, name), { force: true }); }
    }
    return found;
  };

  return {
    store,
    noteChange,
    summary() {
      store.sweepTrash();
      for (const upload of uploads()) if (upload.updatedAt + UPLOAD_STALE_MS < now()) dropUpload(upload.id);
      return { folders: store.folders(), cursor, disk: disk() };
    },
    register(body: unknown): SyncFolder {
      const input = (body ?? {}) as Record<string, unknown>;
      if (!UUID.test(String(input.computerId)) || !text(input.computerName, 200) || !text(input.pcPath, 4096) || !text(input.name, 200)) {
        throw new SyncError(400, { error: "invalid folder" });
      }
      if (!posix.isAbsolute(input.pcPath) && !win32.isAbsolute(input.pcPath)) throw new SyncError(400, { error: "the folder on the computer must be an absolute path" });
      const folder = store.register({ computerId: String(input.computerId), computerName: input.computerName, pcPath: input.pcPath, name: input.name });
      noteChange(folder.id);
      return folder;
    },
    unregister(id: string, keepCloudCopy: boolean): void {
      const folder = store.unregister(id);
      if (!folder) throw new SyncError(404, { error: "no such synced folder" });
      if (!keepCloudCopy && existsSync(folder.cloudPath)) {
        for (const entry of [...walk(folder.cloudPath)]) store.toTrash(folder, entry.path, join(folder.cloudPath, ...entry.path.split("/")));
        rmSync(folder.cloudPath, { recursive: true, force: true });
      }
      noteChange(id);
    },
    async files(id: string): Promise<SyncFile[]> {
      return store.list(folderOf(id));
    },
    beginUpload(id: string, body: unknown): { uploadId: string; received: number } {
      const folder = folderOf(id);
      const input = (body ?? {}) as Record<string, unknown>;
      const base = input.baseSha256;
      if (!validWirePath(input.path) || !Number.isSafeInteger(input.size) || (input.size as number) < 0 || typeof input.sha256 !== "string" || !SHA.test(input.sha256)
        || !(base === null || (typeof base === "string" && SHA.test(base)))) throw new SyncError(400, { error: "invalid upload" });
      fileOf(folder, input.path);
      const size = input.size as number;
      const open = uploads().find((upload) => upload.folderId === folder.id && upload.path === input.path && upload.sha256 === input.sha256 && upload.size === size);
      if (open) return { uploadId: open.id, received: open.received };
      const { freeBytes } = statfs(store.root);
      if (freeBytes - size < RESERVE_BYTES) throw new SyncError(507, { error: "My Cloud is full", neededBytes: size + RESERVE_BYTES, freeBytes });
      const upload: Upload = { id: randomUUID(), folderId: folder.id, path: input.path, size, sha256: input.sha256, baseSha256: base as string | null, received: 0, updatedAt: now() };
      closeSync(openSync(uploadFile(upload.id, "part"), "w", 0o600));
      saveUpload(upload);
      return { uploadId: upload.id, received: 0 };
    },
    async writePart(uploadId: string, offset: number, body: AsyncIterable<Buffer>): Promise<{ received: number }> {
      const upload = readUpload(uploadId);
      if (offset !== upload.received) throw new SyncError(409, { error: "wrong offset", received: upload.received });
      const fd = openSync(uploadFile(uploadId, "part"), "r+");
      let written = 0;
      try {
        for await (const chunk of body) {
          if (written + chunk.length > PART_MAX || upload.received + written + chunk.length > upload.size) throw new SyncError(413, { error: "part too large" });
          writeSync(fd, chunk, 0, chunk.length, upload.received + written);
          written += chunk.length;
        }
      } finally { closeSync(fd); }
      upload.received += written;
      upload.updatedAt = now();
      saveUpload(upload);
      return { received: upload.received };
    },
    async commit(uploadId: string): Promise<{ sha256: string }> {
      const upload = readUpload(uploadId);
      if (upload.received !== upload.size) throw new SyncError(409, { error: "upload incomplete", received: upload.received });
      const part = uploadFile(uploadId, "part");
      if (await sha256File(part) !== upload.sha256) { dropUpload(uploadId); throw new SyncError(422, { error: "the file's bytes do not match its hash" }); }
      const folder = folderOf(upload.folderId);
      const target = fileOf(folder, upload.path);
      const current = await store.current(folder, upload.path);
      if ((current?.sha256 ?? null) !== upload.baseSha256) { dropUpload(uploadId); throw new SyncError(409, { error: "changed on My Cloud", current }); }
      if (current) store.toTrash(folder, upload.path, target);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      renameSync(part, target);
      dropUpload(uploadId);
      const stat = lstatSync(target);
      store.remember(folder, { path: upload.path, size: stat.size, mtimeMs: stat.mtimeMs, sha256: upload.sha256 });
      noteChange(folder.id);
      return { sha256: upload.sha256 };
    },
    trash() {
      return { entries: store.trash() };
    },
    close() {
      for (const wake of [...waiters]) wake();
      store.close();
    },
  };
}

export type CloudSync = ReturnType<typeof createCloudSync>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run server/cloud-sync.test.ts`
Expected: PASS, 6 tests. `pnpm -s lint` is silent.

- [ ] **Step 5: Commit**

```bash
git add server/cloud-sync.ts server/cloud-sync.test.ts
git commit -m "feat(sync): Cloud side takes whole files in resumable parts and refuses stale commits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Cloud service: downloads, deletes, moves, trash and restore

**Files:**
- Modify: `server/cloud-sync.ts`
- Test: `server/cloud-sync.test.ts` (append)

**Interfaces:**
- Consumes: Task 5's service internals (`folderOf`, `fileOf`, `noteChange`); `clashPath` (Task 1).
- Produces: adds `download(id, path): Promise<{ file, size, sha256 }>`; `ops(id, body): Promise<{ results: Array<{ ok: true } | { conflict: true; current: SyncFile | null }> }>`; `restore(entryId): Promise<{ folderId, path }>`.

- [ ] **Step 1: Write the failing test** (append)

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run server/cloud-sync.test.ts`
Expected: FAIL with `sync.download is not a function`.

- [ ] **Step 3: Write the implementation**

Change the rules import in `server/cloud-sync.ts` to `import { RESERVE_BYTES, clashPath, validWirePath } from "../electron/cloud-sync-rules.mjs";` add `rmdirSync` to its `node:fs` import and `sep` to its `node:path` import. Add this helper inside `createCloudSync`, before `return {`:

```ts
  const removeEmptyParents = (folder: SyncFolder, file: string) => {
    for (let dir = dirname(file); dir.startsWith(folder.cloudPath + sep); dir = dirname(dir)) {
      try { rmdirSync(dir); } catch { return; }
    }
  };
```

Then add these members to the object `createCloudSync` returns, before `trash()`:

```ts
    async download(id: string, path: unknown): Promise<{ file: string; size: number; sha256: string }> {
      const folder = folderOf(id);
      const file = fileOf(folder, path);
      const current = await store.current(folder, path as string);
      if (!current) throw new SyncError(404, { error: "no such file" });
      return { file, size: current.size, sha256: current.sha256 };
    },
    async ops(id: string, body: unknown): Promise<{ results: Array<{ ok: true } | { conflict: true; current: SyncFile | null }> }> {
      const folder = folderOf(id);
      const list = (body as { ops?: unknown } | null)?.ops;
      if (!Array.isArray(list) || list.length > 1_000) throw new SyncError(400, { error: "invalid ops" });
      const results: Array<{ ok: true } | { conflict: true; current: SyncFile | null }> = [];
      for (const op of list as Array<Record<string, unknown>>) {
        if (op?.op === "delete" && typeof op.baseSha256 === "string") {
          const file = fileOf(folder, op.path);
          const current = await store.current(folder, op.path as string);
          if (!current) { results.push({ ok: true }); continue; }
          if (current.sha256 !== op.baseSha256) { results.push({ conflict: true, current }); continue; }
          store.toTrash(folder, op.path as string, file);
          removeEmptyParents(folder, file);
          results.push({ ok: true });
        } else if (op?.op === "move" && typeof op.sha256 === "string") {
          const from = fileOf(folder, op.from), to = fileOf(folder, op.to);
          const current = await store.current(folder, op.from as string);
          if (!current || current.sha256 !== op.sha256 || existsSync(to)) { results.push({ conflict: true, current }); continue; }
          mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
          renameSync(from, to);
          store.forget(folder, op.from as string);
          const stat = lstatSync(to);
          store.remember(folder, { path: op.to as string, size: stat.size, mtimeMs: stat.mtimeMs, sha256: current.sha256 });
          removeEmptyParents(folder, from);
          results.push({ ok: true });
        } else {
          throw new SyncError(400, { error: "invalid op" });
        }
      }
      noteChange(folder.id);
      return { results };
    },
    async restore(entryId: unknown): Promise<{ folderId: string; path: string }> {
      const found = typeof entryId === "string" ? store.trashEntry(entryId) : null;
      if (!found) throw new SyncError(404, { error: "no such deleted file" });
      const folder = folderOf(found.entry.folderId);
      let path = found.entry.path;
      if (existsSync(fileOf(folder, path))) path = clashPath(path, now(), (candidate) => existsSync(fileOf(folder, candidate)), "restored");
      const target = fileOf(folder, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      renameSync(found.file, target);
      store.dropTrash(found.entry.id);
      noteChange(folder.id);
      return { folderId: folder.id, path };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run server/cloud-sync.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/cloud-sync.ts server/cloud-sync.test.ts
git commit -m "feat(sync): Cloud side serves files, deletes into the trash, moves and restores

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Cloud service: the change long poll

**Files:**
- Modify: `server/cloud-sync.ts`
- Test: `server/cloud-sync.test.ts` (append)

**Interfaces:**
- Consumes: `changes`, `waiters`, `cursor`, `noteChange` (Task 5).
- Produces: `changes(since: number, waitMs: number, signal: AbortSignal): Promise<{ cursor: number; folderIds: string[] }>`. A cursor this process did not issue answers every folder id at once. The first call starts recursive `fs.watch` on the sync root and on `DATA_DIR/task-workspaces`.

- [ ] **Step 1: Write the failing test** (append)

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run server/cloud-sync.test.ts`
Expected: FAIL with `sync.changes is not a function`.

- [ ] **Step 3: Write the implementation**

In `server/cloud-sync.ts`:
- Add `watch, type FSWatcher` to the `node:fs` import and `relative` to the `node:path` import (`sep` is there since Task 6).
- Declare `let watchers: FSWatcher[] | null = null;` beside `waiters`.
- Add this function inside `createCloudSync`, before `return {`:

```ts
  const startWatching = () => {
    if (watchers) return;
    watchers = [];
    const watchTree = (dir: string, folderFor: (path: string) => string | null) => {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const watcher = watch(dir, { recursive: true }, (_event, name) => {
          const folderId = name ? folderFor(String(name).split(sep).join("/")) : null;
          if (folderId) noteChange(folderId);
        });
        watcher.on("error", () => {});
        watchers!.push(watcher);
      } catch {}
    };
    watchTree(store.root, (path) => store.pcFolders().find((folder) => `${path}/`.startsWith(`${relative(store.root, folder.cloudPath).split(sep).join("/")}/`))?.id ?? null);
    watchTree(join(options.dataDir, "task-workspaces"), (path) => {
      const [botId, threadId] = path.split("/");
      return botId && threadId ? `bot-${botId}-${threadId}` : null;
    });
  };
```

Add to the returned object:

```ts
    async changes(since: number, waitMs: number, signal: AbortSignal): Promise<{ cursor: number; folderIds: string[] }> {
      startWatching();
      const pick = () => {
        const issued = since === cursor || changes.some((change) => change.seq === since) || (changes.length > 0 && since === changes[0]!.seq - 1);
        if (!issued) return { cursor, folderIds: store.folders().map((folder) => folder.id) };
        return { cursor, folderIds: [...new Set(changes.filter((change) => change.seq > since).map((change) => change.folderId))] };
      };
      const ready = pick();
      if (ready.folderIds.length || signal.aborted) return ready;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(Math.max(waitMs, 0), 60_000));
        waiters.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
      return pick();
    },
```

In `close()`, before `store.close()`, add `for (const watcher of watchers ?? []) watcher.close(); watchers = null;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run server/cloud-sync.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/cloud-sync.ts server/cloud-sync.test.ts
git commit -m "feat(sync): long poll that wakes when a synced folder changes on My Cloud

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The /api/sync routes

**Files:**
- Create: `server/routes/cloud-sync.ts`
- Modify: `server/routes/table.ts` (`ROUTES` lists `cloudSyncRoutes`)
- Test: `server/routes/cloud-sync.test.ts`

**Interfaces:**
- Consumes: `createCloudSync`, `SyncError` (Tasks 5–7); `PASS`, `RouteContext`, `RouteHandler`, `dispatchRoutes` from `server/routes/table.ts`; `json` and `readBody` from `server/harness/http.ts`; `cloudHomeConfigured()` from `server/cloud-home.ts`; `DATA_DIR` from `server/config.ts`.
- Produces:
  - `createCloudSyncRoutes({ dataDir, cloudHome: () => boolean, root?, statfs? }): RouteHandler & { close(): void }`
  - `cloudSyncRoutes`, listed in `ROUTES`
  - The HTTP surface:

    | Method and path | Notes |
    |---|---|
    | `GET /api/sync` | |
    | `GET /api/sync/changes?cursor=&waitMs=` | |
    | `GET /api/sync/trash` | |
    | `POST /api/sync/trash/restore` | body `{ entryId }` |
    | `POST /api/sync/folders` | |
    | `DELETE /api/sync/folders/:id?keepCloudCopy=0\|1` | |
    | `GET /api/sync/folders/:id/files` | |
    | `POST /api/sync/folders/:id/uploads` | |
    | `PUT /api/sync/uploads/:uploadId?offset=N` | raw bytes |
    | `POST /api/sync/uploads/:uploadId/commit` | |
    | `GET /api/sync/folders/:id/file?path=` | supports `Range: bytes=N-`; answers with header `x-omb-sha256` |
    | `POST /api/sync/folders/:id/ops` | |

- [ ] **Step 1: Write the failing test**

```ts
// server/routes/cloud-sync.test.ts
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createCloudSyncRoutes } from "./cloud-sync.ts";
import { dispatchRoutes } from "./table.ts";

const PC = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
let auth: RequestAuth, cloudHome: boolean, home: string, server: Server, base: string, routes: ReturnType<typeof createCloudSyncRoutes>;

beforeEach(async () => {
  auth = owner; cloudHome = true;
  home = mkdtempSync(join(tmpdir(), "omb-sync-routes-"));
  mkdirSync(join(home, ".openmausbot"));
  routes = createCloudSyncRoutes({ dataDir: join(home, ".openmausbot"), cloudHome: () => cloudHome, statfs: () => ({ totalBytes: 10 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 }) });
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (!await dispatchRoutes([routes], { req, res, url, path: url.pathname, method: req.method!, auth, json, readBody })) json(res, 404, { error: "not ours" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  routes.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined || body instanceof Uint8Array ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = text; try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, body: parsed, headers: response.headers };
};

it("is not there off a Cloud home, and only the owner's admin session may use it", async () => {
  cloudHome = false;
  expect((await call("GET", "/api/sync")).body).toEqual({ error: "not ours" });
  cloudHome = true; auth = client;
  expect((await call("GET", "/api/sync")).status).toBe(403);
});

it("registers, uploads in parts, lists, serves a range, deletes and restores", async () => {
  const registered = await call("POST", "/api/sync/folders", { computerId: PC, computerName: "Ash-PC", pcPath: "/Users/ash/PA", name: "PA" });
  expect(registered.status).toBe(200);
  const id = registered.body.folder.id as string;
  const begun = await call("POST", `/api/sync/folders/${id}/uploads`, { path: "a.txt", size: 11, sha256: sha("hello world"), baseSha256: null });
  const uploadId = begun.body.uploadId as string;
  expect((await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode("hello "))).body).toEqual({ received: 6 });
  expect((await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode("hello "))).body).toMatchObject({ received: 6 });
  await call("PUT", `/api/sync/uploads/${uploadId}?offset=6`, new TextEncoder().encode("world"));
  expect((await call("POST", `/api/sync/uploads/${uploadId}/commit`)).body).toEqual({ sha256: sha("hello world") });
  expect((await call("GET", `/api/sync/folders/${id}/files`)).body.files).toMatchObject([{ path: "a.txt", size: 11 }]);
  const ranged = await call("GET", `/api/sync/folders/${id}/file?path=a.txt`, undefined, { range: "bytes=6-" });
  expect(ranged.status).toBe(206);
  expect(ranged.body).toBe("world");
  expect(ranged.headers.get("x-omb-sha256")).toBe(sha("hello world"));
  expect((await call("POST", `/api/sync/folders/${id}/ops`, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("hello world") }] })).body).toEqual({ results: [{ ok: true }] });
  const [entry] = (await call("GET", "/api/sync/trash")).body.entries;
  expect((await call("POST", "/api/sync/trash/restore", { entryId: entry.id })).body).toEqual({ folderId: id, path: "a.txt" });
  expect((await call("DELETE", `/api/sync/folders/${id}?keepCloudCopy=1`)).status).toBe(204);
  expect((await call("GET", "/api/sync")).body.folders).toEqual([]);
});

it("answers a stale commit with what is there now", async () => {
  const id = (await call("POST", "/api/sync/folders", { computerId: PC, computerName: "PC", pcPath: "/p", name: "P" })).body.folder.id;
  const upload = async (text: string, baseSha256: string | null) => {
    const { uploadId } = (await call("POST", `/api/sync/folders/${id}/uploads`, { path: "a.txt", size: text.length, sha256: sha(text), baseSha256 })).body;
    await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode(text));
    return call("POST", `/api/sync/uploads/${uploadId}/commit`);
  };
  await upload("v1", null);
  const stale = await upload("v2", null);
  expect(stale.status).toBe(409);
  expect(stale.body.current).toMatchObject({ sha256: sha("v1") });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run server/routes/cloud-sync.test.ts`
Expected: FAIL with `Failed to load url ./cloud-sync.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// server/routes/cloud-sync.ts
// /api/sync: folder sync with the owner's desktop, on a Cloud home only. Listed in ROUTES (table.ts) with no wiring
// from index.ts: the service is built from the data folder on first use.
import { createReadStream } from "node:fs";
import { cloudHomeConfigured } from "../cloud-home.ts";
import { DATA_DIR } from "../config.ts";
import { SyncError, createCloudSync, type CloudSync } from "../cloud-sync.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const FOLDER = String.raw`([\w-]{1,200})`;
const UPLOAD = String.raw`([0-9a-f-]{36})`;

export function createCloudSyncRoutes(options: {
  dataDir: string;
  cloudHome: () => boolean;
  root?: string;
  statfs?: (path: string) => { totalBytes: number; freeBytes: number };
}): RouteHandler & { close(): void } {
  let sync: CloudSync | null = null;
  const service = () => sync ??= createCloudSync({ dataDir: options.dataDir, root: options.root, statfs: options.statfs });
  const handler = async ({ req, res, url, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== "/api/sync" && !path.startsWith("/api/sync/")) return PASS;
    if (!options.cloudHome()) return PASS;
    if (auth.kind !== "session" || !auth.scopes.includes("admin")) { json(res, 403, { error: "Only your own desktop can sync with My Cloud." }); return; }
    res.setHeader("cache-control", "no-store");
    const s = service();
    const match = (pattern: string) => new RegExp(`^${pattern}$`).exec(path);
    let m: RegExpExecArray | null;
    try {
      if (method === "GET" && path === "/api/sync") { json(res, 200, s.summary()); return; }
      if (method === "GET" && path === "/api/sync/changes") {
        const abort = new AbortController();
        req.on("close", () => abort.abort());
        json(res, 200, await s.changes(Number(url.searchParams.get("cursor") ?? 0), Number(url.searchParams.get("waitMs") ?? 60_000), abort.signal));
        return;
      }
      if (method === "GET" && path === "/api/sync/trash") { json(res, 200, s.trash()); return; }
      if (method === "POST" && path === "/api/sync/trash/restore") { json(res, 200, await s.restore((await readBody(req, 10_000))?.entryId)); return; }
      if (method === "POST" && path === "/api/sync/folders") { json(res, 200, { folder: s.register(await readBody(req, 100_000)) }); return; }
      if (method === "DELETE" && (m = match(`/api/sync/folders/${FOLDER}`))) {
        s.unregister(m[1]!, url.searchParams.get("keepCloudCopy") !== "0");
        res.writeHead(204).end();
        return;
      }
      if (method === "GET" && (m = match(`/api/sync/folders/${FOLDER}/files`))) { json(res, 200, { files: await s.files(m[1]!) }); return; }
      if (method === "POST" && (m = match(`/api/sync/folders/${FOLDER}/uploads`))) { json(res, 200, s.beginUpload(m[1]!, await readBody(req, 100_000))); return; }
      if (method === "PUT" && (m = match(`/api/sync/uploads/${UPLOAD}`))) {
        json(res, 200, await s.writePart(m[1]!, Number(url.searchParams.get("offset")), req as AsyncIterable<Buffer>));
        return;
      }
      if (method === "POST" && (m = match(`/api/sync/uploads/${UPLOAD}/commit`))) { json(res, 200, await s.commit(m[1]!)); return; }
      if (method === "GET" && (m = match(`/api/sync/folders/${FOLDER}/file`))) {
        const file = await s.download(m[1]!, url.searchParams.get("path"));
        const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ""));
        const start = range ? Math.min(Number(range[1]), file.size) : 0;
        res.writeHead(range ? 206 : 200, {
          "content-type": "application/octet-stream", "content-length": String(file.size - start), "x-omb-sha256": file.sha256,
          ...(range ? { "content-range": `bytes ${start}-${Math.max(file.size - 1, start)}/${file.size}` } : {}),
        });
        if (file.size === start) { res.end(); return; }
        createReadStream(file.file, { start }).pipe(res);
        return;
      }
      if (method === "POST" && (m = match(`/api/sync/folders/${FOLDER}/ops`))) { json(res, 200, await s.ops(m[1]!, await readBody(req, 4_000_000))); return; }
      json(res, 404, { error: `no route: ${method} ${path}` });
    } catch (error) {
      if (error instanceof SyncError) { json(res, error.status, error.body); return; }
      throw error;
    }
  };
  return Object.assign(handler, { close: () => { sync?.close(); sync = null; } });
}

export const cloudSyncRoutes = createCloudSyncRoutes({ dataDir: DATA_DIR, cloudHome: () => cloudHomeConfigured() });
```

In `server/routes/table.ts`, add `import { cloudSyncRoutes } from "./cloud-sync.ts";` after the type imports. Then change `export const ROUTES: RouteHandler[] = [];` to:

```ts
/** Modules with no wiring from index.ts are listed here; index.ts pushes the rest. */
export const ROUTES: RouteHandler[] = [cloudSyncRoutes];
```

Check that nothing assumes `ROUTES` starts empty: `grep -rn "ROUTES" server --include=*.test.ts`. If a test asserts its length, update it to count `cloudSyncRoutes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run server/routes/cloud-sync.test.ts scripts/testing/index-route-ratchet.test.ts`
Expected: PASS (3 + the ratchet's tests).

- [ ] **Step 5: Commit**

```bash
git add server/routes/cloud-sync.ts server/routes/cloud-sync.test.ts server/routes/table.ts
git commit -m "feat(sync): /api/sync routes for the owner's desktop on a Cloud home

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Bots learn where synced folders are; backups leave sync's records out

**Files:**
- Modify: `server/system-prompt.ts:87-92` (`cloudHomePrompt`)
- Modify: `server/index.ts` (one merged import, one new import, three `cloudHomePrompt(...)` call sites; net zero lines)
- Modify: `server/workspace-backup.ts:29-37` (`EXCLUDED` gains `"sync"`)
- Test: `server/system-prompt.test.ts` (append), `server/workspace-backup.test.ts` (append)

**Interfaces:**
- Consumes: `syncedFolders(dataDir)` (Task 3).
- Produces: `cloudHomePrompt(sharedComputerTools: boolean, synced?: ReadonlyArray<{ computerName: string; pcPath: string; cloudPath: string }>): string`.

- [ ] **Step 1: Write the failing tests**

Append to `server/system-prompt.test.ts`, importing `cloudHomePrompt` if it is not already imported:

```ts
it("tells Cloud bots which computer folders are synced here, and to use the synced copy", () => {
  expect(cloudHomePrompt(true)).not.toContain("synced");
  const text = cloudHomePrompt(true, [{ computerName: "Ash-PC", pcPath: "C:\\Users\\Ash\\Documents\\PA", cloudPath: "/data/Synced/Ash-PC/PA" }]);
  expect(text).toContain("Folders synced from the person's computer: C:\\Users\\Ash\\Documents\\PA on Ash-PC → /data/Synced/Ash-PC/PA.");
  expect(text).toContain("A path on that computer inside one of these means its synced copy here");
  const many = Array.from({ length: 23 }, (_, i) => ({ computerName: "PC", pcPath: `/f${i}`, cloudPath: `/data/Synced/PC/f${i}` }));
  expect(cloudHomePrompt(false, many)).toContain("and 3 more");
});
```

Append to `server/workspace-backup.test.ts`, inside the `describe` block:

```ts
  it("leaves Sync with My Cloud's own records out of a backup", async () => {
    const source = directory();
    mkdirSync(join(source, "sync", "trash"), { recursive: true });
    writeFileSync(join(source, "sync", "folders.json"), "[]");
    writeFileSync(join(source, "notes.md"), "kept");
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    const manifest = readJson(join(target, ".backups", staged.id, "staged", "manifest.json"));
    expect(manifest.entries.some((entry: { path: string }) => entry.path === "sync" || entry.path.startsWith("sync/"))).toBe(false);
    expect(manifest.entries.some((entry: { path: string }) => entry.path === "notes.md")).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s vitest run server/system-prompt.test.ts server/workspace-backup.test.ts`
Expected: FAIL. The prompt test has no "Folders synced" text yet, and the backup manifest still lists `sync/folders.json`.

- [ ] **Step 3: Write the implementation**

In `server/system-prompt.ts`, replace `cloudHomePrompt` with:

```ts
export function cloudHomePrompt(sharedComputerTools: boolean, synced: ReadonlyArray<{ computerName: string; pcPath: string; cloudPath: string }> = []): string {
  return ` You run on ${CLOUD_HOME_PLACE}.` + (sharedComputerTools
    ? " If they ask for something on their own Mac or PC, check list_shared_computers: a computer they lend to My Cloud is reachable through shared_computer, within the folders and apps it allows. If none is lent and online, say so in one sentence: they can turn on Let My Cloud use this computer under Settings → MausBot Cloud in the desktop app on that computer."
    : " You cannot see or use their Mac or PC, its screen or its files from here. If they ask for something on it, say so in one sentence.")
    + " Offer what works here: the built-in browser and their cloud computer, a desktop in the cloud. Call it their cloud computer, as the app does. Never ask them to set up this computer or a Local VM; neither exists here."
    + syncedFoldersPrompt(synced);
}

function syncedFoldersPrompt(synced: ReadonlyArray<{ computerName: string; pcPath: string; cloudPath: string }>): string {
  if (!synced.length) return "";
  const shown = synced.slice(0, 20).map((folder) => `${folder.pcPath} on ${folder.computerName} → ${folder.cloudPath}`).join("; ");
  return ` Folders synced from the person's computer: ${shown}${synced.length > 20 ? `; and ${synced.length - 20} more` : ""}.`
    + " A path on that computer inside one of these means its synced copy here; when a folder is also lent, use the synced copy.";
}
```

In `server/index.ts`:
1. Delete line 197, `import { entitled } from "./enterprise.ts";`. Add `entitled, ` at the start of the brace list on the other `./enterprise.ts` import (line ~503): `import { entitled, createWorkspaceAccess, describeEdition, … } from "./enterprise.ts";`.
2. Add `import { syncedFolders } from "./cloud-sync-store.ts";` directly after the `./workspace-backup.ts` import.
3. At each of the three `cloudHomePrompt(` call sites (`grep -n "cloudHomePrompt(" server/index.ts`), pass `syncedFolders(DATA_DIR)` as the second argument, e.g. `cloudHomePrompt(agentsMounted && lendingEnabled(), syncedFolders(DATA_DIR))`.
4. Run `wc -l server/index.ts`: it must print `17972`.

In `server/workspace-backup.ts`, add `"sync",` to the `EXCLUDED` set, after `"cloud-owner.json",`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -s vitest run server/system-prompt.test.ts server/workspace-backup.test.ts scripts/testing/file-size-ratchet.test.ts scripts/testing/index-route-ratchet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/system-prompt.ts server/system-prompt.test.ts server/index.ts server/workspace-backup.ts server/workspace-backup.test.ts
git commit -m "feat(sync): Cloud bots are told which computer folders are synced; backups skip sync records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Desktop sync record

**Files:**
- Create: `electron/cloud-sync-state.mjs`
- Test: `electron/cloud-sync-state.node-test.mjs`

**Interfaces:**
- Produces: `openSyncState(file)` returns:
  - Base rows: `base(folder): Map<path, { sha256, size, mtimeMs }>`, `setBase(folder, path, { sha256, size, mtimeMs })`, `dropBase(folder, path)`
  - PC places: `place(folder): string | null`, `setPlace(folder, local)`, `places(): Array<{ folder, local }>`
  - Failures: `failed(folder, path, error): number` (the new count), `cleared(folder, path)`, `failures(): Array<{ folderId, path, error }>` (those with count ≥ 3)
  - Meta: `meta(key): string | null`, `setMeta(key, value)`
  - `reset()` and `close()`

- [ ] **Step 1: Write the failing test**

```js
// electron/cloud-sync-state.node-test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSyncState } from "./cloud-sync-state.mjs";

test("keeps the base, PC places, failures and flags across a reopen, and forgets them on reset", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omb-sync-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "cloud-sync", "state.db");
  let state = openSyncState(file);
  state.setBase("f1", "a.txt", { sha256: "s", size: 3, mtimeMs: 1.5 });
  state.setPlace("bot-b-t", "/Users/ash/Documents/MausBot/Owl/Plan");
  assert.equal(state.failed("f1", "x.xlsx", "EBUSY"), 1);
  assert.equal(state.failed("f1", "x.xlsx", "EBUSY"), 2);
  assert.deepEqual(state.failures(), []);
  assert.equal(state.failed("f1", "x.xlsx", "EBUSY"), 3);
  state.setMeta("relinked:f1", "1");
  state.close();
  state = openSyncState(file);
  assert.deepEqual(state.base("f1"), new Map([["a.txt", { sha256: "s", size: 3, mtimeMs: 1.5 }]]));
  assert.equal(state.place("bot-b-t"), "/Users/ash/Documents/MausBot/Owl/Plan");
  assert.deepEqual(state.failures(), [{ folderId: "f1", path: "x.xlsx", error: "EBUSY" }]);
  state.cleared("f1", "x.xlsx");
  assert.deepEqual(state.failures(), []);
  assert.equal(state.meta("relinked:f1"), "1");
  state.dropBase("f1", "a.txt");
  assert.equal(state.base("f1").size, 0);
  state.setBase("f1", "b.txt", { sha256: "t", size: 1, mtimeMs: 2 });
  state.reset();
  assert.equal(state.base("f1").size, 0);
  assert.equal(state.place("bot-b-t"), null);
  assert.equal(state.meta("relinked:f1"), null);
  state.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/cloud-sync-state.node-test.mjs`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the implementation**

```js
// electron/cloud-sync-state.mjs
// The desktop's record for Sync with My Cloud, one SQLite file in user data: each folder's base (every file as it was
// when last in step on both sides), where each bot output folder landed on this PC, per-file failures, and flags.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openSyncState(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS base(folder TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, PRIMARY KEY(folder, path));
    CREATE TABLE IF NOT EXISTS places(folder TEXT PRIMARY KEY, local TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS failures(folder TEXT NOT NULL, path TEXT NOT NULL, count INTEGER NOT NULL, error TEXT NOT NULL, PRIMARY KEY(folder, path));
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return {
    base(folder) {
      return new Map(db.prepare("SELECT path, sha256, size, mtime FROM base WHERE folder = ?").all(folder).map((row) => [row.path, { sha256: row.sha256, size: row.size, mtimeMs: row.mtime }]));
    },
    setBase(folder, path, row) { db.prepare("INSERT OR REPLACE INTO base VALUES (?, ?, ?, ?, ?)").run(folder, path, row.sha256, row.size, row.mtimeMs); },
    dropBase(folder, path) { db.prepare("DELETE FROM base WHERE folder = ? AND path = ?").run(folder, path); },
    place(folder) { return db.prepare("SELECT local FROM places WHERE folder = ?").get(folder)?.local ?? null; },
    setPlace(folder, local) { db.prepare("INSERT OR REPLACE INTO places VALUES (?, ?)").run(folder, local); },
    places() { return db.prepare("SELECT folder, local FROM places").all().map((row) => ({ folder: row.folder, local: row.local })); },
    failed(folder, path, error) {
      db.prepare("INSERT INTO failures VALUES (?, ?, 1, ?) ON CONFLICT(folder, path) DO UPDATE SET count = count + 1, error = excluded.error").run(folder, path, error);
      return db.prepare("SELECT count FROM failures WHERE folder = ? AND path = ?").get(folder, path).count;
    },
    cleared(folder, path) { db.prepare("DELETE FROM failures WHERE folder = ? AND path = ?").run(folder, path); },
    failures() { return db.prepare("SELECT folder, path, error FROM failures WHERE count >= 3 ORDER BY folder, path").all().map((row) => ({ folderId: row.folder, path: row.path, error: row.error })); },
    meta(key) { return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null; },
    setMeta(key, value) { db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run(key, value); },
    reset() { db.exec("DELETE FROM base; DELETE FROM places; DELETE FROM failures; DELETE FROM meta;"); },
    close() { db.close(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/cloud-sync-state.node-test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/cloud-sync-state.mjs electron/cloud-sync-state.node-test.mjs
git commit -m "feat(sync): the desktop's sync record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Reading and watching a PC folder

**Files:**
- Create: `electron/cloud-sync-scan.mjs`
- Test: `electron/cloud-sync-scan.node-test.mjs`

**Interfaces:**
- Consumes: `QUIET_MS`, `skipped`, `validWirePath` (Task 1).
- Produces:
  - `sha256File(file): Promise<string>`
  - `scanPc(root, base, { now?, hash? }) → Promise<{ entries: Map<path, { sha256, size, mtimeMs } | { unsettled: true }>, temps: Array<{ file, mtimeMs }> }>`
  - `caseInsensitive(root, platform?): boolean`
  - `watchFolder(root, onChange, { debounceMs?, watchImpl? }) → () => void`

- [ ] **Step 1: Write the failing test**

```js
// electron/cloud-sync-scan.node-test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { caseInsensitive, scanPc, sha256File, watchFolder } from "./cloud-sync-scan.mjs";

const LATER = () => Date.now() + 60_000;
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "omb-sync-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("lists files as wire paths with hashes, skipping links, litter and sync's own downloads", async (t) => {
  const dir = folder(t);
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "a.txt"), "one");
  writeFileSync(join(dir, "Thumbs.db"), "x");
  writeFileSync(join(dir, ".a.txt.omb-sync-1a2b3c4d"), "half");
  symlinkSync(join(dir, "sub", "a.txt"), join(dir, "link.txt"));
  const { entries, temps } = await scanPc(dir, new Map(), { now: LATER });
  assert.deepEqual([...entries.keys()], ["sub/a.txt"]);
  assert.equal(entries.get("sub/a.txt").sha256, await sha256File(join(dir, "sub", "a.txt")));
  assert.deepEqual(temps.map((temp) => temp.file), [join(dir, ".a.txt.omb-sync-1a2b3c4d")]);
});

test("reuses the base's hash when size and modified time match, and hashes again when they do not", async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, "a.txt"), "one");
  utimesSync(join(dir, "a.txt"), new Date(1_000), new Date(1_000));
  const base = new Map([["a.txt", { sha256: "cached", size: 3, mtimeMs: 1_000 }]]);
  assert.equal((await scanPc(dir, base, { now: LATER })).entries.get("a.txt").sha256, "cached");
  utimesSync(join(dir, "a.txt"), new Date(2_000), new Date(2_000));
  assert.notEqual((await scanPc(dir, base, { now: LATER })).entries.get("a.txt").sha256, "cached");
});

test("a file saved in the last two seconds, or open in Office, waits", async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, "fresh.txt"), "now");
  writeFileSync(join(dir, "Report.docx"), "doc");
  writeFileSync(join(dir, "~$port.docx"), "lock");
  utimesSync(join(dir, "Report.docx"), new Date(1_000), new Date(1_000));
  const { entries } = await scanPc(dir, new Map(), { now: () => Date.now() });
  assert.deepEqual(entries.get("fresh.txt"), { unsettled: true });
  assert.deepEqual(entries.get("Report.docx"), { unsettled: true });
});

test("Windows folders are always case-insensitive", () => {
  assert.equal(caseInsensitive("C:\\Users\\Ash\\PA", "win32"), true);
});

test("a burst of changes is reported once, after it goes quiet", async () => {
  let fire;
  const calls = [];
  const close = watchFolder("/x", () => calls.push(Date.now()), { debounceMs: 20, watchImpl: (_root, _options, listener) => { fire = listener; return { close() {}, on() {} }; } });
  fire(); fire(); fire();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1);
  close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/cloud-sync-scan.node-test.mjs`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the implementation**

```js
// electron/cloud-sync-scan.mjs
// Reads a PC folder for Sync with My Cloud: every regular file as a wire path with its size, modified time and sha256,
// hashing only what changed since the base. A file still being written, or open in Office, is unsettled and waits.
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { QUIET_MS, skipped, validWirePath } from "./cloud-sync-rules.mjs";

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

function* walkPc(root, wire = "", real = []) {
  let entries;
  try { entries = readdirSync(join(root, ...real), { withFileTypes: true }); } catch { return; }
  const names = entries.map((entry) => entry.name);
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = join(root, ...real, entry.name);
    if (/\.omb-sync-[0-9a-f]+$/.test(entry.name)) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isFile()) yield { temp: true, file, mtimeMs: stat.mtimeMs };
      continue;
    }
    const name = entry.name.normalize("NFC");
    const path = wire ? `${wire}/${name}` : name;
    if (skipped(entry.name, entry.isDirectory()) || !validWirePath(path)) continue;
    if (entry.isDirectory()) { yield* walkPc(root, path, [...real, entry.name]); continue; }
    if (!entry.isFile()) continue;
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1) continue;
    const locked = names.some((other) => other.startsWith("~$") && other.length > 2 && entry.name.endsWith(other.slice(2)));
    yield { path, file, size: stat.size, mtimeMs: stat.mtimeMs, locked };
  }
}

export async function scanPc(root, base, { now = Date.now, hash = sha256File } = {}) {
  const entries = new Map();
  const temps = [];
  for (const item of walkPc(root)) {
    if (item.temp) { temps.push({ file: item.file, mtimeMs: item.mtimeMs }); continue; }
    const known = base.get(item.path);
    if (known && known.size === item.size && known.mtimeMs === item.mtimeMs) {
      entries.set(item.path, { sha256: known.sha256, size: item.size, mtimeMs: item.mtimeMs });
      continue;
    }
    if (item.locked || now() - item.mtimeMs < QUIET_MS) { entries.set(item.path, { unsettled: true }); continue; }
    let sha256;
    try { sha256 = await hash(item.file); } catch { entries.set(item.path, { unsettled: true }); continue; }
    const after = lstatSync(item.file, { throwIfNoEntry: false });
    if (!after || after.size !== item.size || after.mtimeMs !== item.mtimeMs) { entries.set(item.path, { unsettled: true }); continue; }
    entries.set(item.path, { sha256, size: item.size, mtimeMs: item.mtimeMs });
  }
  return { entries, temps };
}

/** True when the folder's file system treats "A.txt" and "a.txt" as one file. */
export function caseInsensitive(root, platform = process.platform) {
  if (platform === "win32") return true;
  const flipped = root.replace(/[A-Za-z](?=[^/]*$)/, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()));
  if (flipped === root) return platform === "darwin";
  try {
    const a = statSync(root), b = statSync(flipped);
    return a.ino === b.ino && a.dev === b.dev;
  } catch { return false; }
}

export function watchFolder(root, onChange, { debounceMs = 1_000, watchImpl = watch } = {}) {
  let timer = null;
  let watcher;
  try {
    watcher = watchImpl(root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
      timer.unref?.();
    });
    watcher.on?.("error", () => {});
  } catch { return () => {}; }
  return () => { clearTimeout(timer); watcher.close(); };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/cloud-sync-scan.node-test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/cloud-sync-scan.mjs electron/cloud-sync-scan.node-test.mjs
git commit -m "feat(sync): read and watch a PC folder, hashing only what changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The desktop's client for /api/sync

**Files:**
- Create: `electron/cloud-sync-client.mjs`
- Test: `electron/cloud-sync-client.node-test.mjs`

**Interfaces:**
- Consumes: `CHUNK_BYTES`, `MIN_CHUNK_BYTES` (Task 1).
- Produces:
  - Error classes: `class SyncAuthError extends Error`; `class SyncHttpError extends Error { status; body }`
  - `createSyncClient({ origin, fetch })` returns an object with:
    - `summary()`, `register(input) → folder`, `unregister(id, keepCloudCopy)`, `files(id) → SyncFile[]`
    - `changes(cursor, waitMs, signal)`, `ops(id, ops) → results`
    - `trash() → entries`, `restore(entryId) → { folderId, path }`
    - `bots() → { bots, groups }` (Cloud `GET /api/bots?messages=0`)
    - `setBotFolder(id, cwd)` and `setRoomFolder(id, cwd)` (Cloud `PATCH /api/bots/:id` and `PATCH /api/groups/:id`)
    - `upload({ folderId, path, file, size, sha256, baseSha256 }) → { ok: true } | { conflict: true, current } | { full: true, neededBytes, freeBytes }`
    - `download(folderId, path, temporary) → { sha256 }`, which resumes a partial `temporary` with `Range`

- [ ] **Step 1: Write the failing test**

```js
// electron/cloud-sync-client.node-test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SyncAuthError, createSyncClient } from "./cloud-sync-client.mjs";

const ORIGIN = "https://omb-u-1a2b3c4d5e6f.fly.dev";
const reply = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function dir(t) { const path = mkdtempSync(join(tmpdir(), "omb-sync-client-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }

test("sends the Cloud origin and the window's sign-in, and turns 401 into a sign-in error", async () => {
  const seen = [];
  const client = createSyncClient({ origin: ORIGIN, fetch: async (url, init) => { seen.push([url, init]); return reply(401, { error: "no" }); } });
  await assert.rejects(client.summary(), SyncAuthError);
  assert.equal(seen[0][0], `${ORIGIN}/api/sync`);
  assert.equal(seen[0][1].headers.origin, ORIGIN);
  assert.equal(seen[0][1].credentials, "include");
});

test("an upload resumes where My Cloud says it got to, halves parts a proxy refuses, and commits", async (t) => {
  const file = join(dir(t), "a.bin");
  writeFileSync(file, Buffer.alloc(40, 7));
  const puts = [];
  let received = 0;
  const client = createSyncClient({ origin: ORIGIN, chunkBytes: 32, minChunkBytes: 8, fetch: async (url, init) => {
    if (url.endsWith("/uploads")) return reply(200, { uploadId: "11111111-1111-4111-8111-111111111111", received: 8 });
    if (init.method === "PUT") {
      const offset = Number(new URL(url).searchParams.get("offset"));
      puts.push([offset, init.body.length]);
      if (init.body.length > 16) return reply(413, "too big");
      if (offset !== received + 8) return reply(409, { received: received + 8 });
      received += init.body.length;
      return reply(200, { received: received + 8 });
    }
    if (url.endsWith("/commit")) return reply(200, { sha256: "s" });
    throw new Error(url);
  } });
  assert.deepEqual(await client.upload({ folderId: "f", path: "a.bin", file, size: 40, sha256: "s", baseSha256: null }), { ok: true });
  assert.deepEqual(puts, [[8, 32], [8, 16], [24, 16]]);
});

test("an upload answers a full Cloud and a lost race plainly", async (t) => {
  const file = join(dir(t), "a.bin");
  writeFileSync(file, "x");
  const full = createSyncClient({ origin: ORIGIN, fetch: async () => reply(507, { neededBytes: 9, freeBytes: 1 }) });
  assert.deepEqual(await full.upload({ folderId: "f", path: "a", file, size: 1, sha256: "s", baseSha256: null }), { full: true, neededBytes: 9, freeBytes: 1 });
  const raced = createSyncClient({ origin: ORIGIN, fetch: async (url, init) => url.endsWith("/uploads") ? reply(200, { uploadId: "u", received: 1 }) : init.method === "POST" ? reply(409, { current: { sha256: "other" } }) : reply(200, {}) });
  assert.deepEqual(await raced.upload({ folderId: "f", path: "a", file, size: 1, sha256: "s", baseSha256: null }), { conflict: true, current: { sha256: "other" } });
});

test("a download resumes a partial file with a range", async (t) => {
  const temporary = join(dir(t), ".a.txt.omb-sync-1a2b3c4d");
  writeFileSync(temporary, "hello ");
  let range;
  const client = createSyncClient({ origin: ORIGIN, fetch: async (_url, init) => { range = init.headers.range; return new Response("world", { status: 206, headers: { "x-omb-sha256": "s" } }); } });
  assert.deepEqual(await client.download("f", "a.txt", temporary), { sha256: "s" });
  assert.equal(range, "bytes=6-");
  assert.equal(readFileSync(temporary, "utf8"), "hello world");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/cloud-sync-client.node-test.mjs`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the implementation**

```js
// electron/cloud-sync-client.mjs
// The desktop's calls to My Cloud's /api/sync, with the Cloud sign-in the app window already holds (main passes
// session.defaultSession.fetch). Uploads go in resumable parts; downloads resume a partial file.
import { closeSync, createWriteStream, openSync, readSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CHUNK_BYTES, MIN_CHUNK_BYTES } from "./cloud-sync-rules.mjs";

export class SyncAuthError extends Error {}
export class SyncHttpError extends Error {
  constructor(status, body) {
    super(body?.error ?? `My Cloud answered ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function createSyncClient({ origin, fetch: fetchImpl, chunkBytes = CHUNK_BYTES, minChunkBytes = MIN_CHUNK_BYTES }) {
  let chunk = chunkBytes;
  const call = async (method, path, { body, raw, headers = {}, signal, timeoutMs = 60_000 } = {}) => {
    const response = await fetchImpl(`${origin}${path}`, {
      method, credentials: "include", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : raw ? { "content-type": "application/octet-stream" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : raw ? { body: raw } : {}),
    });
    if (response.status === 401 || response.status === 403) throw new SyncAuthError("Sign in to My Cloud again.");
    return response;
  };
  const json = async (method, path, options) => {
    const response = await call(method, path, options);
    if (response.status === 204) return null;
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new SyncHttpError(response.status, body);
    return body;
  };
  const id = (value) => encodeURIComponent(value);
  return {
    summary: () => json("GET", "/api/sync"),
    register: (input) => json("POST", "/api/sync/folders", { body: input }).then((result) => result.folder),
    unregister: (folderId, keepCloudCopy) => json("DELETE", `/api/sync/folders/${id(folderId)}?keepCloudCopy=${keepCloudCopy ? 1 : 0}`),
    files: (folderId) => json("GET", `/api/sync/folders/${id(folderId)}/files`).then((result) => result.files),
    changes: (cursor, waitMs, signal) => json("GET", `/api/sync/changes?cursor=${cursor}&waitMs=${waitMs}`, { signal, timeoutMs: waitMs + 15_000 }),
    ops: (folderId, ops) => json("POST", `/api/sync/folders/${id(folderId)}/ops`, { body: { ops } }).then((result) => result.results),
    trash: () => json("GET", "/api/sync/trash").then((result) => result.entries),
    restore: (entryId) => json("POST", "/api/sync/trash/restore", { body: { entryId } }),
    bots: () => json("GET", "/api/bots?messages=0").then((result) => ({ bots: result?.bots ?? [], groups: result?.groups ?? [] })),
    setBotFolder: (botId, cwd) => json("PATCH", `/api/bots/${id(botId)}`, { body: { cwd } }),
    setRoomFolder: (roomId, cwd) => json("PATCH", `/api/groups/${id(roomId)}`, { body: { cwd } }),
    async upload({ folderId, path, file, size, sha256, baseSha256 }) {
      let begun;
      try {
        begun = await json("POST", `/api/sync/folders/${id(folderId)}/uploads`, { body: { path, size, sha256, baseSha256 } });
      } catch (error) {
        if (error.status === 507) return { full: true, neededBytes: error.body?.neededBytes, freeBytes: error.body?.freeBytes };
        throw error;
      }
      let received = begun.received;
      const fd = openSync(file, "r");
      try {
        while (received < size) {
          const length = Math.min(chunk, size - received);
          const buffer = Buffer.alloc(length);
          if (readSync(fd, buffer, 0, length, received) !== length) throw new Error("The file changed while it was being sent.");
          const response = await call("PUT", `/api/sync/uploads/${begun.uploadId}?offset=${received}`, { raw: buffer, timeoutMs: 120_000 });
          if (response.status === 413 && chunk > minChunkBytes) { chunk = Math.max(minChunkBytes, Math.floor(chunk / 2)); continue; }
          const body = await response.json().catch(() => null);
          if (response.status === 409 && Number.isSafeInteger(body?.received)) { received = body.received; continue; }
          if (!response.ok) throw new SyncHttpError(response.status, body);
          received = body.received;
        }
      } finally { closeSync(fd); }
      try {
        await json("POST", `/api/sync/uploads/${begun.uploadId}/commit`);
        return { ok: true };
      } catch (error) {
        if (error.status === 409 && error.body && "current" in error.body) return { conflict: true, current: error.body.current };
        throw error;
      }
    },
    async download(folderId, path, temporary) {
      const have = statSync(temporary, { throwIfNoEntry: false })?.size ?? 0;
      const response = await call("GET", `/api/sync/folders/${id(folderId)}/file?path=${encodeURIComponent(path)}`, { headers: have ? { range: `bytes=${have}-` } : {}, timeoutMs: 600_000 });
      if (!response.ok) throw new SyncHttpError(response.status, await response.json().catch(() => null));
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: response.status === 206 ? "a" : "w", mode: 0o600 }));
      return { sha256: response.headers.get("x-omb-sha256") };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/cloud-sync-client.node-test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/cloud-sync-client.mjs electron/cloud-sync-client.node-test.mjs
git commit -m "feat(sync): desktop client for My Cloud's /api/sync with resumable transfers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: One folder's pass (the engine)

**Files:**
- Create: `electron/cloud-sync-engine.mjs`
- Create: `electron/fixtures/cloud-sync-fake-cloud.mjs`
- Test: `electron/cloud-sync-engine.node-test.mjs`

**Interfaces:**
- Consumes: `planFolder` (Task 2); `scanPc`, `sha256File`, `caseInsensitive` (Task 11); the client surface (Task 12); `openSyncState` (Task 10); `RESERVE_BYTES`, `clashPath` (Task 1).
- Produces:
  - `newReport() → { waiting, clashes, held, problems, notices, missing, uploaded, downloaded }`
  - `passStopper(error): boolean`
  - `syncFolder({ client, state, folder, local, platform?, now?, trashItem, grow?, freeBytes?, report })`
  - Fixture: `fakeCloud({ freeBytes? })` returns `{ client, folders, missing, calls, put(folderId, path, text), get(folderId, path), setBots(value) }`, plus `sha(text)`.

- [ ] **Step 1: Write the fake Cloud**

```js
// electron/fixtures/cloud-sync-fake-cloud.mjs
// An in-memory My Cloud with createSyncClient's surface, for the sync engine and service tests.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const GB = 1024 ** 3;

export function fakeCloud({ freeBytes = 100 * GB } = {}) {
  const folders = new Map();
  const calls = [];
  const missing = new Set();
  let bots = { bots: [], groups: [] };
  const state = { freeBytes };
  const files = (id) => folders.get(id).files;
  const info = (path, bytes) => ({ path, size: bytes.length, mtimeMs: 1, sha256: sha(bytes) });
  const client = {
    summary: async () => ({ folders: [...folders.values()].map((entry) => entry.folder), cursor: 1, disk: { totalBytes: 10 * GB, freeBytes: state.freeBytes, syncedBytes: 0, botFileBytes: 0, trashBytes: 0, reserveBytes: GB } }),
    register: async (input) => {
      calls.push(["register", input.pcPath]);
      const existing = [...folders.values()].find((entry) => entry.folder.pcPath === input.pcPath && entry.folder.computerId === input.computerId);
      if (existing) return existing.folder;
      const folder = { id: `pc-${folders.size + 1}`, kind: "pc", computerId: input.computerId, computerName: input.computerName, pcPath: input.pcPath, cloudPath: `/data/Synced/PC/${input.name}` };
      folders.set(folder.id, { folder, files: new Map() });
      return folder;
    },
    unregister: async (id, keep) => { calls.push(["unregister", id, keep]); folders.delete(id); },
    files: async (id) => {
      if (missing.has(id)) throw Object.assign(new Error("missing"), { status: 410 });
      return [...files(id)].map(([path, bytes]) => info(path, bytes));
    },
    upload: async ({ folderId, path, file, size, sha256, baseSha256 }) => {
      calls.push(["upload", path]);
      if (state.freeBytes - size < GB) return { full: true, neededBytes: size + GB, freeBytes: state.freeBytes };
      const current = files(folderId).get(path);
      if ((current ? sha(current) : null) !== baseSha256) return { conflict: true, current: current ? info(path, current) : null };
      const bytes = readFileSync(file);
      if (sha(bytes) !== sha256) throw new Error("hash mismatch");
      files(folderId).set(path, bytes);
      state.freeBytes -= size;
      return { ok: true };
    },
    download: async (folderId, path, temporary) => {
      calls.push(["download", path]);
      const bytes = files(folderId).get(path);
      writeFileSync(temporary, bytes);
      return { sha256: sha(bytes) };
    },
    ops: async (folderId, ops) => ops.map((op) => {
      const list = files(folderId);
      if (op.op === "delete") {
        calls.push(["delete", op.path]);
        const current = list.get(op.path);
        if (current && sha(current) !== op.baseSha256) return { conflict: true, current: info(op.path, current) };
        list.delete(op.path);
        return { ok: true };
      }
      calls.push(["move", `${op.from}->${op.to}`]);
      const current = list.get(op.from);
      if (!current || sha(current) !== op.sha256 || list.has(op.to)) return { conflict: true, current: null };
      list.delete(op.from);
      list.set(op.to, current);
      return { ok: true };
    }),
    // Like the real long poll, answers only when told to stop: a loop over it must not spin.
    changes: (_cursor, _waitMs, signal) => new Promise((resolve) => {
      if (signal?.aborted) return resolve({ cursor: 1, folderIds: [] });
      signal?.addEventListener("abort", () => resolve({ cursor: 1, folderIds: [] }), { once: true });
    }),
    trash: async () => [],
    restore: async () => ({}),
    bots: async () => bots,
    setBotFolder: async (id, cwd) => { calls.push(["setBotFolder", id, cwd]); },
    setRoomFolder: async (id, cwd) => { calls.push(["setRoomFolder", id, cwd]); },
  };
  return {
    client, folders, missing, calls, state,
    addFolder(folder) { folders.set(folder.id, { folder, files: new Map() }); return folder; },
    put(folderId, path, text) { files(folderId).set(path, Buffer.from(text)); },
    get(folderId, path) { return files(folderId).get(path)?.toString(); },
    setBots(value) { bots = value; },
  };
}
```

- [ ] **Step 2: Write the failing test**

```js
// electron/cloud-sync-engine.node-test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test electron/cloud-sync-engine.node-test.mjs`
Expected: FAIL with `Cannot find module '.../cloud-sync-engine.mjs'`.

- [ ] **Step 4: Write the implementation**

```js
// electron/cloud-sync-engine.mjs
// One folder's pass of Sync with My Cloud: read both sides, plan against the base, carry out each action, and record a
// new base only once both sides hold the same bytes. A per-file failure is retried next pass; a signed-out or offline
// Cloud stops the whole pass.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RESERVE_BYTES, clashPath } from "./cloud-sync-rules.mjs";
import { planFolder } from "./cloud-sync-plan.mjs";
import { caseInsensitive, scanPc, sha256File } from "./cloud-sync-scan.mjs";
import { SyncAuthError } from "./cloud-sync-client.mjs";

const TEMP_TAG = ".omb-sync-";
const TEMP_STALE_MS = 24 * 60 * 60_000;
const AGENT_CONFIG = /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.claude\/.+)$/;
const CONCURRENCY = 2;

export function newReport() {
  return { waiting: [], clashes: [], held: [], problems: [], notices: [], missing: [], uploaded: 0, downloaded: 0 };
}

/** True when the whole pass should stop (signed out, offline), not just this file. */
export function passStopper(error) {
  return error instanceof SyncAuthError || error?.name === "AbortError" || error?.name === "TimeoutError"
    || (error?.name === "TypeError" && /fetch/i.test(String(error.message)));
}

const defaultFree = (dir) => { const stats = fs.statfsSync(dir); return stats.bavail * stats.bsize; };

export async function syncFolder({ client, state, folder, local, platform = process.platform, now = Date.now, trashItem, grow = async () => false, freeBytes = defaultFree, report }) {
  let listed;
  try { listed = await client.files(folder.id); } catch (error) {
    if (error?.status === 410) { report.missing.push(folder.id); return; }
    throw error;
  }
  if (folder.kind === "pc" && !fs.lstatSync(local, { throwIfNoEntry: false })?.isDirectory()) {
    report.problems.push({ folderId: folder.id, path: "", error: "This folder is no longer on this computer." });
    return;
  }
  fs.mkdirSync(local, { recursive: true });
  const base = state.base(folder.id);
  const { entries: pc, temps } = await scanPc(local, base, { now });
  for (const temp of temps) if (now() - temp.mtimeMs > TEMP_STALE_MS) fs.rmSync(temp.file, { force: true });
  const cloud = new Map(listed.map((file) => [file.path, file]));
  const { actions, held } = planFolder({ base, pc, cloud, windows: platform === "win32", caseInsensitive: caseInsensitive(local, platform), now: now() });
  report.held.push(...held.map((item) => ({ folderId: folder.id, ...item })));
  const ctx = { client, state, folder, local, pc, cloud, now, trashItem, grow, freeBytes, report, grew: false };
  // Smallest uploads last and in size order, so a file that does not fit cannot hold back the small ones.
  const uploads = actions.filter((action) => action.type === "upload").sort((a, b) => a.size - b.size);
  await inPool([...actions.filter((action) => action.type !== "upload"), ...uploads], CONCURRENCY, async (action) => {
    const key = action.path ?? action.to;
    try {
      await apply(ctx, action);
      state.cleared(folder.id, key);
    } catch (error) {
      if (passStopper(error)) throw error;
      const message = String(error?.message ?? error);
      if (state.failed(folder.id, key, message) >= 3) report.problems.push({ folderId: folder.id, path: key, error: message });
    }
  });
}

async function inPool(items, size, work) {
  let next = 0;
  let stop = null;
  const runner = async () => {
    while (next < items.length && !stop) {
      const item = items[next++];
      try { await work(item); } catch (error) { stop ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runner));
  if (stop) throw stop;
}

const localFile = (ctx, wire) => path.join(ctx.local, ...wire.split("/"));

function removeEmptyDirs(root, file) {
  for (let dir = path.dirname(file); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    try { fs.rmdirSync(dir); } catch { return; }
  }
}

async function apply(ctx, action) {
  const { state, folder, pc } = ctx;
  switch (action.type) {
    case "upload":
      if (await upload(ctx, action) === "ok") state.setBase(folder.id, action.path, { sha256: action.sha256, size: action.size, mtimeMs: action.mtimeMs });
      return;
    case "download":
      return download(ctx, action.path, action.size, pc.get(action.path) ?? null);
    case "record":
      state.setBase(folder.id, action.path, { sha256: action.sha256, size: action.size, mtimeMs: action.mtimeMs });
      return;
    case "forget":
      state.dropBase(folder.id, action.path);
      return;
    case "deleteCloud": {
      const [result] = await ctx.client.ops(folder.id, [{ op: "delete", path: action.path, baseSha256: action.baseSha256 }]);
      if (result?.ok) state.dropBase(folder.id, action.path);
      return;
    }
    case "deletePc": {
      const seen = pc.get(action.path);
      if (!seen || seen.unsettled || seen.sha256 !== action.sha256) return;
      const file = localFile(ctx, action.path);
      await ctx.trashItem(file);
      removeEmptyDirs(ctx.local, file);
      state.dropBase(folder.id, action.path);
      return;
    }
    case "clash":
      return clash(ctx, action);
    case "moveCloud": {
      const [result] = await ctx.client.ops(folder.id, [{ op: "move", from: action.from, to: action.to, sha256: action.sha256 }]);
      if (result?.ok) {
        state.dropBase(folder.id, action.from);
        state.setBase(folder.id, action.to, { sha256: action.sha256, size: action.size, mtimeMs: action.mtimeMs });
        return;
      }
      await apply(ctx, { type: "upload", path: action.to, sha256: action.sha256, size: action.size, mtimeMs: action.mtimeMs, baseSha256: null });
      await apply(ctx, { type: "deleteCloud", path: action.from, baseSha256: action.sha256 });
      return;
    }
    case "movePc": {
      const from = localFile(ctx, action.from), to = localFile(ctx, action.to);
      if (pc.get(action.from)?.sha256 === action.sha256 && !fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        removeEmptyDirs(ctx.local, from);
        const stat = fs.statSync(to);
        state.dropBase(folder.id, action.from);
        state.setBase(folder.id, action.to, { sha256: action.sha256, size: stat.size, mtimeMs: stat.mtimeMs });
        return;
      }
      await download(ctx, action.to, action.size, pc.get(action.to) ?? null);
      return;
    }
    default:
      throw new Error(`Unknown sync action ${action.type}`);
  }
}

async function upload(ctx, { path: wire, sha256, size, baseSha256 }) {
  const { client, folder, report } = ctx;
  const result = await client.upload({ folderId: folder.id, path: wire, file: localFile(ctx, wire), size, sha256, baseSha256 });
  if (result.ok) { report.uploaded++; return "ok"; }
  if (result.conflict) {
    const current = result.current;
    if (current?.sha256 === sha256) return "ok";
    if (!current) return upload(ctx, { path: wire, sha256, size, baseSha256: null });
    const taken = (candidate) => ctx.pc.has(candidate) || ctx.cloud.has(candidate) || fs.existsSync(localFile(ctx, candidate));
    await clash(ctx, { path: wire, clashPath: clashPath(wire, ctx.now(), taken), pcSha256: sha256, pcSize: size, cloudSha256: current.sha256, cloudSize: current.size });
    return "clash";
  }
  if (result.full) {
    if (!ctx.grew) {
      ctx.grew = true;
      if (await ctx.grow(result.neededBytes)) return upload(ctx, { path: wire, sha256, size, baseSha256 });
    }
    report.waiting.push({ folderId: folder.id, path: wire, size });
    return "waiting";
  }
  throw new Error("My Cloud gave an answer this app does not understand.");
}

async function download(ctx, wire, size, expected) {
  const { client, folder, state, report } = ctx;
  const target = localFile(ctx, wire);
  if (ctx.freeBytes(ctx.local) - size < RESERVE_BYTES) { report.waiting.push({ folderId: folder.id, path: wire, size, toThisComputer: true }); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tag = createHash("sha256").update(`${folder.id}\n${wire}`).digest("hex").slice(0, 8);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}${TEMP_TAG}${tag}`);
  const sent = await client.download(folder.id, wire, temporary);
  const got = await sha256File(temporary);
  if (sent.sha256 && got !== sent.sha256) { fs.rmSync(temporary, { force: true }); throw new Error("The download was damaged; it will be fetched again."); }
  const now = fs.lstatSync(target, { throwIfNoEntry: false });
  const unchanged = expected ? Boolean(now?.isFile() && now.size === expected.size && now.mtimeMs === expected.mtimeMs) : !now;
  if (!unchanged) { fs.rmSync(temporary, { force: true }); return; }
  fs.renameSync(temporary, target);
  const stat = fs.statSync(target);
  state.setBase(folder.id, wire, { sha256: got, size: stat.size, mtimeMs: stat.mtimeMs });
  report.downloaded++;
  if (AGENT_CONFIG.test(wire)) report.notices.push({ folderId: folder.id, path: wire });
}

async function clash(ctx, action) {
  const from = localFile(ctx, action.path), to = localFile(ctx, action.clashPath);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  const stat = fs.statSync(to);
  if (await upload(ctx, { path: action.clashPath, sha256: action.pcSha256, size: stat.size, baseSha256: null }) === "ok") {
    ctx.state.setBase(ctx.folder.id, action.clashPath, { sha256: action.pcSha256, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  await download(ctx, action.path, action.cloudSize, null);
  ctx.report.clashes.push({ folderId: ctx.folder.id, path: action.path, clashPath: action.clashPath });
}
```

Node's `fs` adds Windows' long-path prefix on its own (`path.toNamespacedPath`), so paths longer than 260 characters need nothing more here.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test electron/cloud-sync-engine.node-test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add electron/cloud-sync-engine.mjs electron/fixtures/cloud-sync-fake-cloud.mjs electron/cloud-sync-engine.node-test.mjs
git commit -m "feat(sync): one folder's pass, keeping both copies on a clash and never deleting without a base

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The desktop sync service

**Files:**
- Create: `electron/cloud-sync.mjs`
- Create: `electron/cloud-sync.d.mts`
- Test: `electron/cloud-sync.node-test.mjs`

**Interfaces:**
- Consumes: `syncFolder`, `newReport`, `passStopper` (Task 13); `openSyncState` (Task 10); `watchFolder` (Task 11); `createSyncClient`, `SyncAuthError` (Task 12); `safeFolderName`, `foldKey` (Task 1).
- Produces:
  - `linkedFolders({ bots, groups, localDataDir, homeDir, platform? }) → { links: Array<{ pcPath, bots: string[], rooms: string[] }>, refused: Array<{ pcPath, reason: "too-broad" }> }`
  - `createCloudSyncService({ settingsFile, stateFile, documentsDir, localDataDir, homeDir?, platform?, hostname?, cloudOrigin, fetch, localBots, growDisk, planDisk, trashItem, createClient?, watch?, freeBytes?, now?, onChange? })` returns:
    - `start()`, `state(): CloudSyncStatus`, `setEnabled(on, { keepCloudCopy? }): Promise<CloudSyncStatus>`
    - `linkFolder(pcPath): Promise<{ cloudPath }>`
    - `trash()`, `restore(entryId)`, `localPath(folderId, path): string | null`
    - `wake()`, `close()`, and `pass(only?)` (exported for tests)
  - Types in `electron/cloud-sync.d.mts`: `CloudSyncStatus`, `CloudSyncTrashEntry`, `CloudSyncBridge` (the renderer's `window.ogb.cloudAccount.sync`).

- [ ] **Step 1: Write the failing test**

```js
// electron/cloud-sync.node-test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test electron/cloud-sync.node-test.mjs`
Expected: FAIL with `Cannot find module '.../cloud-sync.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// electron/cloud-sync.mjs
// Sync with My Cloud, the desktop service. While the switch is on and the app runs, it keeps every folder a local bot
// or room works in, and every bot's output folder on My Cloud, the same on both sides. It drives every pass over the
// Cloud sign-in the window holds; My Cloud only answers /api/sync. A new Cloud (another account) starts from no base.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldKey, safeFolderName } from "./cloud-sync-rules.mjs";
import { SyncAuthError, createSyncClient } from "./cloud-sync-client.mjs";
import { newReport, passStopper, syncFolder } from "./cloud-sync-engine.mjs";
import { openSyncState } from "./cloud-sync-state.mjs";
import { watchFolder } from "./cloud-sync-scan.mjs";

const FULL_PASS_MS = 5 * 60_000;
const LONG_POLL_MS = 60_000;
const BACKOFF_MS = [1_000, 3_000, 8_000, 15_000, 30_000];
const GB = 1024 ** 3;
const OFF = { enabled: false, phase: "off", lastSyncedAt: null, disk: null, folders: [], waiting: [], clashes: [], held: [], problems: [], notices: [], missing: [] };

/** Absolute folders local bots, their tasks and rooms work in, outside the data folder; a nested one folds into its outer. */
export function linkedFolders({ bots = [], groups = [], localDataDir, homeDir, platform = process.platform }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const key = (value) => {
    const slashed = value.replaceAll("\\", "/").replace(/\/+$/, "");
    return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
  };
  const within = (child, parent) => key(child) === key(parent) || key(child).startsWith(`${key(parent)}/`);
  const users = new Map();
  const add = (folder, kind, id) => {
    if (typeof folder !== "string" || !p.isAbsolute(folder)) return;
    const entry = users.get(key(folder)) ?? { pcPath: folder, bots: new Set(), rooms: new Set() };
    entry[kind].add(id);
    users.set(key(folder), entry);
  };
  for (const bot of bots) {
    add(bot.cwd, "bots", bot.id);
    for (const task of bot.tasks ?? []) add(task.cwd, "bots", bot.id);
  }
  for (const group of groups) add(group.cwd, "rooms", group.id);
  const links = [];
  const refused = [];
  for (const entry of [...users.values()].sort((a, b) => key(a.pcPath).length - key(b.pcPath).length)) {
    if (within(entry.pcPath, localDataDir)) continue;
    if (entry.pcPath === p.parse(entry.pcPath).root || within(homeDir, entry.pcPath)) { refused.push({ pcPath: entry.pcPath, reason: "too-broad" }); continue; }
    const outer = links.find((link) => within(entry.pcPath, link.pcPath));
    if (outer) {
      for (const id of entry.bots) outer.bots.add(id);
      for (const id of entry.rooms) outer.rooms.add(id);
      continue;
    }
    links.push(entry);
  }
  return { links: links.map((link) => ({ pcPath: link.pcPath, bots: [...link.bots], rooms: [...link.rooms] })), refused };
}

function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : { version: 1, enabled: false };
  } catch { return { version: 1, enabled: false }; }
}

function writeSettings(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export function createCloudSyncService({
  settingsFile, stateFile, documentsDir, localDataDir, homeDir = os.homedir(), platform = process.platform, hostname = os.hostname(),
  cloudOrigin, fetch: fetchImpl, localBots, growDisk, planDisk, trashItem,
  createClient = createSyncClient, watch = watchFolder, freeBytes, now = Date.now, onChange = () => {},
}) {
  let settings = readSettings(settingsFile);
  const state = openSyncState(stateFile);
  let status = { ...OFF, enabled: settings.enabled === true };
  let closed = false, interval = null, poller = null, cursor = 0, chain = Promise.resolve(), pending = null;
  const watchers = new Map();
  const pcKey = (value) => (platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value);

  const save = (next) => { settings = next; writeSettings(settingsFile, next); };
  const publish = (next) => { status = next; onChange(api.state()); };
  const client = () => {
    const origin = cloudOrigin();
    return origin ? createClient({ origin, fetch: fetchImpl }) : null;
  };

  async function linkFolders(cloud, folders) {
    const { links, refused } = linkedFolders({ ...(await localBots()), localDataDir, homeDir, platform });
    const mine = folders.filter((folder) => folder.kind === "pc" && folder.computerId === settings.computerId);
    let listed = null;
    for (const link of links) {
      if (!fs.lstatSync(link.pcPath, { throwIfNoEntry: false })?.isDirectory()) continue;
      let folder = mine.find((entry) => pcKey(entry.pcPath) === pcKey(link.pcPath));
      if (!folder) {
        folder = await cloud.register({ computerId: settings.computerId, computerName: hostname, pcPath: link.pcPath, name: path.basename(link.pcPath) || "Folder" });
        mine.push(folder);
      }
      if (state.meta(`relinked:${folder.id}`)) continue;
      listed ??= await cloud.bots();
      for (const id of link.bots) {
        const bot = listed.bots.find((entry) => entry.id === id);
        if (bot && (!bot.cwd || pcKey(bot.cwd) === pcKey(link.pcPath))) await cloud.setBotFolder(id, folder.cloudPath);
      }
      for (const id of link.rooms) {
        const room = listed.groups.find((entry) => entry.id === id);
        if (room && (!room.cwd || pcKey(room.cwd) === pcKey(link.pcPath))) await cloud.setRoomFolder(id, folder.cloudPath);
      }
      state.setMeta(`relinked:${folder.id}`, "1");
    }
    return refused;
  }

  const takenIn = (dir) => {
    const taken = new Set();
    try { for (const name of fs.readdirSync(dir)) taken.add(foldKey(name)); } catch {}
    for (const { local } of state.places()) if (path.dirname(local) === dir) taken.add(foldKey(path.basename(local)));
    return taken;
  };

  async function botPlaces(cloud, folders) {
    const places = new Map();
    let listed = null;
    const root = path.join(documentsDir, "MausBot");
    for (const folder of folders.filter((entry) => entry.kind === "bot")) {
      let local = state.place(folder.id);
      if (!local) {
        listed ??= await cloud.bots();
        const bot = listed.bots.find((entry) => entry.id === folder.botId);
        const task = bot?.tasks?.find((entry) => entry.threadId === folder.threadId);
        let botDir = state.meta(`botdir:${folder.botId}`);
        if (!botDir) {
          botDir = path.join(root, safeFolderName(bot?.name ?? folder.botId, takenIn(root)));
          state.setMeta(`botdir:${folder.botId}`, botDir);
        }
        local = path.join(botDir, safeFolderName(task?.title || folder.threadId, takenIn(botDir)));
        state.setPlace(folder.id, local);
      }
      places.set(folder.id, local);
    }
    return places;
  }

  function watchAll(folders, localOf) {
    const ids = new Set(folders.map((folder) => folder.id));
    for (const [id, close] of watchers) if (!ids.has(id)) { close(); watchers.delete(id); }
    for (const folder of folders) {
      if (watchers.has(folder.id)) continue;
      const local = localOf(folder);
      if (local && fs.existsSync(local)) watchers.set(folder.id, watch(local, () => void pass(new Set([folder.id]))));
    }
  }

  const merge = (previous, next, only) => (only ? [...previous.filter((entry) => !only.has(entry.folderId)), ...next] : next);

  /** Passes run one at a time. A call while one waits joins it (its folders added, or all of them) and gets its promise. */
  function pass(only = null) {
    if (!settings.enabled || closed) return Promise.resolve();
    if (pending) {
      pending.only = pending.only && only ? new Set([...pending.only, ...only]) : null;
      return pending.promise;
    }
    const entry = { only, promise: null };
    entry.promise = chain.then(() => {
      if (pending === entry) pending = null;
      return runPass(entry.only);
    });
    pending = entry;
    chain = entry.promise.catch(() => {});
    return entry.promise;
  }

  async function runPass(only) {
    if (!settings.enabled || closed) return;
    const report = newReport();
    try {
      const origin = cloudOrigin();
      if (!origin) { publish({ ...status, phase: "signed-out" }); return; }
      if (settings.origin !== origin) { state.reset(); save({ ...settings, origin }); }
      const cloud = createClient({ origin, fetch: fetchImpl });
      publish({ ...status, phase: "syncing" });
      const refused = await linkFolders(cloud, (await cloud.summary()).folders);
      const { folders, disk } = await cloud.summary();
      const mine = folders.filter((folder) => folder.kind === "bot" || folder.computerId === settings.computerId);
      const places = await botPlaces(cloud, mine);
      const localOf = (folder) => (folder.kind === "pc" ? folder.pcPath : places.get(folder.id));
      let grew = false;
      const grow = async (neededBytes) => {
        if (grew) return false;
        grew = true;
        const plan = planDisk();
        if (!plan || plan.volumeBytes >= plan.maxBytes) return false;
        const sizeGb = Math.min(plan.maxBytes / GB, Math.ceil(plan.volumeBytes / GB) + 10 * Math.max(1, Math.ceil(neededBytes / (10 * GB))));
        const result = await growDisk(sizeGb).catch(() => null);
        return Boolean(result?.disk);
      };
      for (const folder of mine) {
        if (only && !only.has(folder.id)) continue;
        await syncFolder({ client: cloud, state, folder, local: localOf(folder), platform, now, trashItem, grow, ...(freeBytes ? { freeBytes } : {}), report });
      }
      watchAll(mine, localOf);
      const plan = planDisk();
      const usedBytes = disk.totalBytes - disk.freeBytes;
      const planMaxBytes = plan?.maxBytes ?? disk.totalBytes;
      const waiting = merge(status.waiting, report.waiting, only);
      publish({
        enabled: true,
        phase: waiting.length ? "waiting" : "synced",
        lastSyncedAt: now(),
        disk: { ...disk, usedBytes, planMaxBytes, warn: usedBytes >= 0.8 * planMaxBytes },
        folders: mine.map((folder) => ({ id: folder.id, kind: folder.kind, local: localOf(folder), cloudPath: folder.cloudPath })),
        waiting,
        clashes: [...report.clashes, ...status.clashes].slice(0, 50),
        held: merge(status.held, report.held, only),
        problems: [
          ...refused.map((entry) => ({ folderId: "", path: entry.pcPath, error: "This folder is too broad to sync. Link a folder inside your home folder instead." })),
          ...merge(status.problems.filter((entry) => entry.folderId), report.problems, only),
        ],
        notices: [...report.notices, ...status.notices].slice(0, 20),
        missing: only ? [...status.missing.filter((id) => !only.has(id)), ...report.missing] : report.missing,
      });
    } catch (error) {
      publish({ ...status, phase: error instanceof SyncAuthError ? "signed-out" : "offline" });
      if (!passStopper(error) && !(error instanceof SyncAuthError)) console.error(`[cloud-sync] pass stopped: ${error?.message ?? error}`);
    }
  }

  async function pollLoop(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const cloud = client();
        if (!cloud) { await sleep(30_000, signal); continue; }
        const result = await cloud.changes(cursor, LONG_POLL_MS, signal);
        const recovered = attempt > 0;
        attempt = 0;
        const known = cursor !== 0;
        cursor = result.cursor;
        // Back online after failures: anything may have changed meanwhile, so look at every folder.
        if (recovered) void pass();
        else if (known && result.folderIds.length) void pass(new Set(result.folderIds));
      } catch {
        if (signal.aborted) return;
        await sleep(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)], signal);
      }
    }
  }

  function start() {
    if (!settings.enabled || closed || interval) return;
    interval = setInterval(() => void pass(), FULL_PASS_MS);
    interval.unref?.();
    poller = new AbortController();
    void pollLoop(poller.signal);
    void pass();
  }

  function stop() {
    clearInterval(interval);
    interval = null;
    poller?.abort();
    poller = null;
    for (const close of watchers.values()) close();
    watchers.clear();
  }

  const api = {
    start,
    pass,
    state: () => ({ ...status, enabled: settings.enabled === true }),
    async setEnabled(on, { keepCloudCopy = true } = {}) {
      if (on) {
        save({ ...settings, version: 1, enabled: true, computerId: settings.computerId ?? randomUUID() });
        publish({ ...status, enabled: true, phase: "syncing" });
        start();
        return api.state();
      }
      stop();
      const cloud = client();
      if (!keepCloudCopy && cloud) {
        const { folders } = await cloud.summary();
        const listed = await cloud.bots();
        for (const folder of folders.filter((entry) => entry.kind === "pc" && entry.computerId === settings.computerId)) {
          for (const bot of listed.bots.filter((entry) => entry.cwd === folder.cloudPath)) await cloud.setBotFolder(bot.id, null);
          for (const room of listed.groups.filter((entry) => entry.cwd === folder.cloudPath)) await cloud.setRoomFolder(room.id, null);
          await cloud.unregister(folder.id, false);
        }
      }
      state.reset();
      save({ ...settings, enabled: false });
      publish({ ...OFF });
      return api.state();
    },
    async linkFolder(pcPath) {
      if (!settings.enabled) throw new Error("Turn on Sync with My Cloud first.");
      if (!fs.lstatSync(pcPath, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Choose a folder.");
      const { links, refused } = linkedFolders({ bots: [{ id: "chosen", cwd: pcPath }], localDataDir, homeDir, platform });
      if (refused.length) throw new Error("This folder is too broad to sync. Choose a folder inside your home folder.");
      if (!links.length) throw new Error("MausBot's own data folder does not sync this way.");
      const cloud = client();
      if (!cloud) throw new Error("Open My Cloud from Settings → MausBot Cloud first.");
      const folder = await cloud.register({ computerId: settings.computerId, computerName: hostname, pcPath, name: path.basename(pcPath) || "Folder" });
      state.setMeta(`relinked:${folder.id}`, "1");
      void pass(new Set([folder.id]));
      return { cloudPath: folder.cloudPath };
    },
    async trash() {
      const cloud = client();
      return cloud ? cloud.trash() : [];
    },
    async restore(entryId) {
      const cloud = client();
      if (!cloud) throw new Error("Open My Cloud from Settings → MausBot Cloud first.");
      const restored = await cloud.restore(entryId);
      void pass(restored?.folderId ? new Set([restored.folderId]) : null);
      return api.state();
    },
    localPath(folderId, wire) {
      const folder = status.folders.find((entry) => entry.id === folderId);
      return folder?.local ? path.join(folder.local, ...String(wire).split("/").filter(Boolean)) : null;
    },
    wake: () => void pass(),
    close() {
      closed = true;
      stop();
      state.close();
    },
  };
  return api;
}
```

```ts
// electron/cloud-sync.d.mts
export interface CloudSyncDisk { totalBytes: number; freeBytes: number; syncedBytes: number; botFileBytes: number; trashBytes: number; reserveBytes: number; usedBytes: number; planMaxBytes: number; warn: boolean }
export interface CloudSyncStatus {
  enabled: boolean;
  openAtLogin?: boolean;
  phase: "off" | "syncing" | "synced" | "waiting" | "offline" | "signed-out";
  lastSyncedAt: number | null;
  disk: CloudSyncDisk | null;
  folders: Array<{ id: string; kind: "pc" | "bot"; local: string; cloudPath: string }>;
  waiting: Array<{ folderId: string; path: string; size: number; toThisComputer?: boolean }>;
  clashes: Array<{ folderId: string; path: string; clashPath: string }>;
  held: Array<{ folderId: string; path: string; reason: "windows-name" | "case-clash" }>;
  problems: Array<{ folderId: string; path: string; error: string }>;
  notices: Array<{ folderId: string; path: string }>;
  missing: string[];
}
export interface CloudSyncTrashEntry { id: string; folderId: string; path: string; size: number; deletedAt: number }
export interface CloudSyncBridge {
  state(): Promise<CloudSyncStatus>;
  set(input: { enabled?: boolean; keepCloudCopy?: boolean; openAtLogin?: boolean }): Promise<CloudSyncStatus>;
  trash(): Promise<CloudSyncTrashEntry[]>;
  restore(entryId: string): Promise<CloudSyncStatus>;
  open(input: { folderId: string; path: string }): Promise<void>;
  upgrade(): Promise<void>;
  onState(callback: (state: CloudSyncStatus) => void): () => void;
}
export declare function linkedFolders(input: { bots?: Array<{ id: string; cwd?: string; tasks?: Array<{ cwd?: string }> }>; groups?: Array<{ id: string; cwd?: string }>; localDataDir: string; homeDir: string; platform?: NodeJS.Platform }): { links: Array<{ pcPath: string; bots: string[]; rooms: string[] }>; refused: Array<{ pcPath: string; reason: "too-broad" }> };
export declare function createCloudSyncService(options: Record<string, unknown>): {
  start(): void;
  pass(only?: Set<string> | null): Promise<void>;
  state(): CloudSyncStatus;
  setEnabled(on: boolean, options?: { keepCloudCopy?: boolean }): Promise<CloudSyncStatus>;
  linkFolder(pcPath: string): Promise<{ cloudPath: string }>;
  trash(): Promise<CloudSyncTrashEntry[]>;
  restore(entryId: string): Promise<CloudSyncStatus>;
  localPath(folderId: string, path: string): string | null;
  wake(): void;
  close(): void;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test electron/cloud-sync.node-test.mjs electron/cloud-sync-engine.node-test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/cloud-sync.mjs electron/cloud-sync.d.mts electron/cloud-sync.node-test.mjs
git commit -m "feat(sync): desktop service links bots' folders, names bot output folders and runs passes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Wire sync into the desktop app (room in main.mjs, IPC, tray, preload)

**Files:**
- Modify: `electron/diagnostics.mjs` (gains `appendDesktopCrashRecord`)
- Modify: `electron/main.mjs`: remove `recordDesktopCrash` (lines 562–608), and add one import, one install block, one `start` and one `close`
- Create: `electron/cloud-sync-indicator.mjs`
- Create: `electron/cloud-sync-main.mjs`
- Modify: `electron/preload.cjs`: add `cloudAccount.sync`, a top-level `cloudSync`, and `"cloudSync"` in `REMOTE_SAFE`
- Modify: `electron/cloud-account.d.mts` (`CloudAccountBridge.sync?`), `src/types/ogb.d.ts` (`cloudSync?`)
- Modify: `scripts/testing/file-size-ratchet.test.ts` (lower `electron/main.mjs` to its new count)
- Test: `electron/diagnostics.test.mjs` (append), `electron/cloud-sync-main.node-test.mjs`, `electron/cloud-sync-preload.node-test.mjs`

**Interfaces:**
- Consumes: `createCloudSyncService` (Task 14). From main.mjs: `myCloud()`, `ensureCloudAccount()`, `cloudAccount`, `cloudPlanDisk`, `localWorkspaceOnly`, `cloudPageSender`, `openLendingSettings`, `desktopServerHeaders`, `SERVER_PORT`, `desktopMutationToken`, `desktopDataDir()`, `APP_ICON`, `slog`.
- Produces:
  - `appendDesktopCrashRecord(file, maxBytes, record)`
  - `installCloudSync(deps) → { start(), close() }`
  - `createCloudSyncIndicator({ Tray, Menu, nativeImage, iconPath, onOpen }) → { update(state), destroy() }`
  - IPC channels (local Settings only): `sync:state`, `sync:set`, `sync:trash`, `sync:restore`, `sync:open`, `sync:upgrade`
  - IPC channel callable from the My Cloud page: `cloud-sync:link-folder`
  - Push channel to the window: `sync:state-changed`

- [ ] **Step 1: Write the failing tests**

Append to `electron/diagnostics.test.mjs` (vitest), importing `appendDesktopCrashRecord`:

```js
it("appends a crash line, truncates a full log, and refuses a hard-linked one", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-crash-"));
  const file = join(dir, "logs", "desktop-crashes.log");
  appendDesktopCrashRecord(file, 64, "first crash");
  expect(readFileSync(file, "utf8")).toMatch(/^\[.+\] first crash\n$/);
  appendDesktopCrashRecord(file, 10, "second crash");
  expect(readFileSync(file, "utf8")).toMatch(/^\[.+\] second crash\n$/);
  linkSync(file, join(dir, "other"));
  appendDesktopCrashRecord(file, 1_000, "third crash");
  expect(readFileSync(file, "utf8")).not.toContain("third crash");
  rmSync(dir, { recursive: true, force: true });
});
```

(Add `linkSync, mkdtempSync, readFileSync, rmSync` from `node:fs`, `tmpdir` from `node:os` and `join` from `node:path` to its imports if missing.)

```js
// electron/cloud-sync-main.node-test.mjs
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
```

```js
// electron/cloud-sync-preload.node-test.mjs
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s vitest run electron/diagnostics.test.mjs && node --test electron/cloud-sync-main.node-test.mjs electron/cloud-sync-preload.node-test.mjs`
Expected: FAIL. `appendDesktopCrashRecord` is not exported, `cloud-sync-main.mjs` is missing, and `bridge.cloudSync` is undefined.

- [ ] **Step 3: Move the crash writer out of main.mjs**

In `electron/diagnostics.mjs`, add the following (import `fs` and `path` if they are not already imported):

```js
/** One line in the desktop crash log: refuses a link or a hard-linked target, starts over past maxBytes, owner-only. */
export function appendDesktopCrashRecord(file, maxBytes, record) {
  if (!record) return;
  let handle = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    let before = null;
    try {
      before = fs.lstatSync(file);
      if (!before.isFile() || before.nlink !== 1) return;
      handle = fs.openSync(file, flags);
    } catch (error) {
      if (error?.code !== "ENOENT") return;
      // O_EXCL makes first creation race-safe on Windows, which has no O_NOFOLLOW.
      try { handle = fs.openSync(file, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); } catch { return; }
    }
    const stats = fs.fstatSync(handle);
    if (!stats.isFile() || stats.nlink !== 1) return;
    if (before && (before.dev !== stats.dev || before.ino !== stats.ino)) return;
    if (stats.size >= maxBytes) fs.ftruncateSync(handle, 0);
    if (process.platform !== "win32") fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, `[${new Date().toISOString()}] ${record}\n`, "utf8");
  } catch {
  } finally {
    if (handle !== null) { try { fs.closeSync(handle); } catch {} }
  }
}
```

In `electron/main.mjs`:
1. Delete the whole `function recordDesktopCrash(event) { … }` (from `function recordDesktopCrash` to its closing brace before the `// uncaughtExceptionMonitor` comment).
2. In `installDesktopCrashListeners({ … })`, change `record: recordDesktopCrash,` to `record: (event) => appendDesktopCrashRecord(DESKTOP_CRASH_LOG, DESKTOP_CRASH_LOG_MAX_BYTES, formatDesktopCrashRecord(event)),`.
3. Add `appendDesktopCrashRecord,` to the `./diagnostics.mjs` import list.

Run `pnpm -s vitest run electron/diagnostics.test.mjs`. Expected: PASS.

- [ ] **Step 4: Write the tray item and the install module**

```js
// electron/cloud-sync-indicator.mjs
// The tray item while Sync with My Cloud is on: one status line and a way to its settings.
const LINES = {
  syncing: "Syncing with My Cloud…",
  synced: "Synced with My Cloud",
  waiting: "Waiting: My Cloud is full",
  offline: "Offline: sync resumes when My Cloud can be reached",
  "signed-out": "Sign in to My Cloud again to keep syncing",
};

export function createCloudSyncIndicator({ Tray, Menu, nativeImage, iconPath, onOpen }) {
  let tray = null;
  let shown = "";
  return {
    update(state) {
      const line = state?.enabled ? (state.disk?.warn && state.phase === "synced" ? "My Cloud is 80% full" : LINES[state.phase] ?? "") : "";
      if (line === shown && (tray !== null) === Boolean(line)) return;
      shown = line;
      if (!line) { if (tray && !tray.isDestroyed?.()) tray.destroy?.(); tray = null; return; }
      if (!tray || tray.isDestroyed?.()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on?.("click", () => tray?.popUpContextMenu?.());
      }
      tray.setToolTip?.(`OpenMausBot: ${line}`);
      tray.setContextMenu?.(Menu.buildFromTemplate([{ label: line, enabled: false }, { type: "separator" }, { label: "Sync settings…", click: () => onOpen() }]));
    },
    destroy() { if (tray && !tray.isDestroyed?.()) tray.destroy?.(); tray = null; shown = ""; },
  };
}
```

```js
// electron/cloud-sync-main.mjs
// Wires Sync with My Cloud into the desktop app: the service with Electron's pieces, its Settings channels (this
// computer's own window only), Choose on this PC for the My Cloud page, the tray item and Open MausBot when I log in.
import path from "node:path";
import { createCloudSyncService } from "./cloud-sync.mjs";
import { createCloudSyncIndicator } from "./cloud-sync-indicator.mjs";

export function installCloudSync({
  app, ipcMain, dialog, shell, powerMonitor, Tray, Menu, nativeImage, iconPath, fetch,
  localWorkspaceOnly, cloudPageSender, send, cloudOrigin, localBots, cloudAccount, planDisk, localDataDir, openSettings,
}) {
  const dir = path.join(app.getPath("userData"), "cloud-sync");
  const indicator = createCloudSyncIndicator({ Tray, Menu, nativeImage, iconPath, onOpen: openSettings });
  const openAtLogin = () => app.getLoginItemSettings().openAtLogin === true;
  const setOpenAtLogin = (on) => app.setLoginItemSettings({ openAtLogin: on });
  const service = createCloudSyncService({
    settingsFile: path.join(dir, "settings.json"), stateFile: path.join(dir, "state.db"),
    documentsDir: app.getPath("documents"), localDataDir, cloudOrigin, fetch, localBots,
    growDisk: (sizeGb) => cloudAccount().growDisk(sizeGb), planDisk, trashItem: (file) => shell.trashItem(file),
    onChange: (state) => { send("sync:state-changed", { ...state, openAtLogin: openAtLogin() }); indicator.update(state); },
  });
  const snapshot = () => ({ ...service.state(), openAtLogin: openAtLogin() });
  ipcMain.handle("sync:state", localWorkspaceOnly("sync:state", () => snapshot()));
  ipcMain.handle("sync:set", localWorkspaceOnly("sync:set", async (_event, input) => {
    if (!input || typeof input !== "object") throw new Error("Invalid sync settings.");
    if (typeof input.openAtLogin === "boolean") setOpenAtLogin(input.openAtLogin);
    if (typeof input.enabled === "boolean") {
      if (input.enabled && !service.state().enabled) setOpenAtLogin(true);
      await service.setEnabled(input.enabled, { keepCloudCopy: input.keepCloudCopy !== false });
    }
    return snapshot();
  }));
  ipcMain.handle("sync:trash", localWorkspaceOnly("sync:trash", () => service.trash()));
  ipcMain.handle("sync:restore", localWorkspaceOnly("sync:restore", async (_event, entryId) => {
    if (typeof entryId !== "string" || !/^[0-9a-f-]{36}$/.test(entryId)) throw new Error("Invalid deleted file.");
    await service.restore(entryId);
    return snapshot();
  }));
  ipcMain.handle("sync:open", localWorkspaceOnly("sync:open", (_event, input) => {
    const file = service.localPath(String(input?.folderId ?? ""), String(input?.path ?? ""));
    if (file) shell.showItemInFolder(file);
  }));
  ipcMain.handle("sync:upgrade", localWorkspaceOnly("sync:upgrade", async () => { await cloudAccount().openDashboard(); }));
  ipcMain.handle("cloud-sync:link-folder", cloudPageSender("cloud-sync:link-folder", async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return service.linkFolder(picked.filePaths[0]);
  }));
  powerMonitor.on("resume", () => service.wake());
  return { start: () => service.start(), close: () => { service.close(); indicator.destroy(); } };
}
```

- [ ] **Step 5: Wire it into main.mjs**

1. Add `import { installCloudSync } from "./cloud-sync-main.mjs";` after the `./cloud-home.mjs` import.
2. Directly after the last `ipcMain.handle("lending:` handler (`grep -n 'ipcMain.handle("lending:stop"' electron/main.mjs`), add:

```js
const cloudSync = installCloudSync({
  app, ipcMain, dialog, shell, powerMonitor, Tray, Menu, nativeImage, iconPath: APP_ICON,
  fetch: (...args) => session.defaultSession.fetch(...args), localWorkspaceOnly, cloudPageSender, localDataDir: desktopDataDir(),
  send: (channel, value) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value); },
  cloudOrigin: () => myCloud(), cloudAccount: () => ensureCloudAccount(), planDisk: () => cloudPlanDisk(cloudAccount?.state()),
  localBots: async () => (await fetch(`http://127.0.0.1:${SERVER_PORT}/api/bots?messages=0`, { headers: desktopServerHeaders({ accept: "application/json" }, { packaged: app.isPackaged, token: desktopMutationToken }) })).json(),
  openSettings: () => void openLendingSettings().catch(error => slog(`sync settings: ${error?.message ?? error}`)),
});
```

3. On the line after `sharingController().start({ maintainer: allowed });`, add `cloudSync.start();`.
4. On the line after `computerSharing?.close();` in `before-quit`, add `cloudSync.close();`.
5. Confirm that `cloudPageSender` and `localWorkspaceOnly` are defined above the install block (`grep -n "const cloudPageSender\|function localWorkspaceOnly\|const localWorkspaceOnly" electron/main.mjs`). If either is defined later, move the install block after it.
6. Run `wc -l electron/main.mjs` and set `"electron/main.mjs": <that number>,` in `scripts/testing/file-size-ratchet.test.ts`.

- [ ] **Step 6: Expose the bridges**

In `electron/preload.cjs`, inside the `cloudAccount: process.argv.includes("--omb-company-desktop=1") ? {` object, add after the `lending: { … },` block:

```js
    sync: {
      state: () => ipcRenderer.invoke("sync:state"),
      set: input => ipcRenderer.invoke("sync:set", input),
      trash: () => ipcRenderer.invoke("sync:trash"),
      restore: entryId => ipcRenderer.invoke("sync:restore", entryId),
      open: input => ipcRenderer.invoke("sync:open", input),
      upgrade: () => ipcRenderer.invoke("sync:upgrade"),
      onState: cb => {
        const handler = (_event, state) => cb(state);
        ipcRenderer.on("sync:state-changed", handler);
        return () => ipcRenderer.removeListener("sync:state-changed", handler);
      },
    },
```

After the `cloudLending: …` entry, add:

```js
  // Choose on this PC from a bot's settings on My Cloud: the person picks in a native dialog; the page never reads paths.
  cloudSync: process.argv.includes("--omb-company-desktop=1") ? {
    linkFolder: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-sync:link-folder") : Promise.reject(new Error("Choose the button to pick a folder.")),
  } : undefined,
```

Then add `"cloudSync"` to the `REMOTE_SAFE` set.

In `electron/cloud-account.d.mts`, add `sync?: import("./cloud-sync.mjs").CloudSyncBridge;` beside `lending?:`. In `src/types/ogb.d.ts`, add after `cloudLending?:`:

```ts
      /** Choose on this PC: links a folder on this computer to My Cloud and answers its Cloud copy, or null if cancelled. */
      cloudSync?: { linkFolder(): Promise<{ cloudPath: string } | null> };
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm -s vitest run electron/diagnostics.test.mjs scripts/testing/file-size-ratchet.test.ts && node --test electron/cloud-sync-main.node-test.mjs electron/cloud-sync-preload.node-test.mjs electron/preload.node-test.mjs electron/company-backup-preload.node-test.mjs && pnpm -s exec tsc -b`
Expected: PASS, and `tsc` silent.

- [ ] **Step 8: Commit**

```bash
git add electron/diagnostics.mjs electron/diagnostics.test.mjs electron/main.mjs electron/cloud-sync-indicator.mjs electron/cloud-sync-main.mjs electron/cloud-sync-main.node-test.mjs electron/preload.cjs electron/cloud-sync-preload.node-test.mjs electron/cloud-account.d.mts src/types/ogb.d.ts scripts/testing/file-size-ratchet.test.ts
git commit -m "feat(sync): wire Sync with My Cloud into the desktop app

Moves the crash-log writer into diagnostics.mjs to make room in main.mjs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Settings → MausBot Cloud → Sync with My Cloud

**Files:**
- Create: `src/components/CloudSync.tsx`
- Modify: `src/components/CloudAccountSettings.tsx`: `cloudHomeCard` takes `sync`, renders `<CloudSync bridge={sync} />` after `<CloudLending …/>`, and the call at line ~276 passes `sync: bridge.sync`
- Modify: `src/locales/en.json` (new `cloudSync.*` keys)
- Test: `src/components/CloudSync.test.ts`

**Interfaces:**
- Consumes: `CloudSyncBridge`, `CloudSyncStatus`, `CloudSyncTrashEntry` (Task 14 `.d.mts`); `Switch` from `./SettingsPrimitives`; `t` from `@/lib/i18n`.
- Produces: `CloudSync({ bridge })`, `syncStatusKey(state): LocaleKey | null`, `formatSyncBytes(bytes): string`.

- [ ] **Step 1: Add the strings** to `src/locales/en.json`, in alphabetical position beside the other `cloud…` keys:

```json
  "cloudSync.title": "Sync with My Cloud",
  "cloudSync.help": "Keeps the folders your bots use, and what your bots make on My Cloud, the same here and there, so your bots can work on your files while this computer is off.",
  "cloudSync.everyBot": "Every bot on My Cloud can read and change synced files, including ones started by webhooks or routines.",
  "cloudSync.openAtLogin": "Open MausBot when I log in",
  "cloudSync.status.syncing": "Syncing…",
  "cloudSync.status.synced": "Up to date",
  "cloudSync.status.waiting": "Some files are waiting: My Cloud is full",
  "cloudSync.status.offline": "Offline. Sync resumes when My Cloud can be reached.",
  "cloudSync.status.signedOut": "Sign in to My Cloud again to keep syncing.",
  "cloudSync.meter": "{used} of {total} used",
  "cloudSync.breakdown": "Synced folders {synced} · bot files {bots} · recently deleted {trash}",
  "cloudSync.almostFull": "My Cloud is 80% full.",
  "cloudSync.waiting": "{count} files ({size}) are waiting: My Cloud is full.",
  "cloudSync.upgrade": "Get more space",
  "cloudSync.clashes": "Changed in both places, so both copies were kept",
  "cloudSync.held": "Can't be copied to this computer",
  "cloudSync.heldName": "its name isn't allowed here",
  "cloudSync.heldCase": "another file has the same name in different capitals",
  "cloudSync.problems": "Couldn't sync",
  "cloudSync.notice": "A bot on My Cloud changed {path}",
  "cloudSync.missing": "A synced folder is missing on My Cloud. The files on this computer were left as they are.",
  "cloudSync.show": "Show",
  "cloudSync.recentlyDeleted": "Recently deleted",
  "cloudSync.restore": "Restore",
  "cloudSync.offTitle": "Turn off Sync with My Cloud?",
  "cloudSync.offKeep": "Keep the copies on My Cloud",
  "cloudSync.offDelete": "Delete them from My Cloud",
  "cloudSync.offHelp": "Nothing on this computer is deleted.",
  "cloudSync.cancel": "Cancel",
  "cloudSync.failed": "That didn't work: {error}",
```

- [ ] **Step 2: Write the failing test**

```ts
// src/components/CloudSync.test.ts
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
  off.nodes.find((node) => node.props["aria-label"] === "Sync with My Cloud")!.props.onClick!();
  await flush();
  expect(bridge.set).toHaveBeenCalledWith({ enabled: true });
  const on = render();
  on.nodes.find((node) => node.props["aria-label"] === "Sync with My Cloud")!.props.onClick!();
  const asking = render();
  expect(asking.html).toContain("Turn off Sync with My Cloud?");
  asking.nodes.find((node) => node.props["data-sync"] === "off-delete")!.props.onClick!();
  await flush();
  expect(bridge.set).toHaveBeenLastCalledWith({ enabled: false, keepCloudCopy: false });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -s vitest run src/components/CloudSync.test.ts`
Expected: FAIL with `Failed to resolve import "./CloudSync"`.

- [ ] **Step 4: Write the implementation**

```tsx
// src/components/CloudSync.tsx
import { useEffect, useRef, useState } from "react";
import type { CloudSyncBridge, CloudSyncStatus, CloudSyncTrashEntry } from "../../electron/cloud-sync.mjs";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { Switch } from "./SettingsPrimitives";

const PHASES: Record<Exclude<CloudSyncStatus["phase"], "off">, LocaleKey> = {
  syncing: "cloudSync.status.syncing",
  synced: "cloudSync.status.synced",
  waiting: "cloudSync.status.waiting",
  offline: "cloudSync.status.offline",
  "signed-out": "cloudSync.status.signedOut",
};

export function syncStatusKey(state: CloudSyncStatus | null): LocaleKey | null {
  if (!state?.enabled || state.phase === "off") return null;
  return PHASES[state.phase];
}

export function formatSyncBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Security: main decides which Cloud and which folders; this page only shows state and passes the person's choices. */
export function CloudSync({ bridge }: { bridge: CloudSyncBridge }) {
  const [state, setState] = useState<CloudSyncStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [deleted, setDeleted] = useState<CloudSyncTrashEntry[]>([]);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void bridge.state().then((next) => { if (mounted.current) setState(next); }).catch(() => {});
    void bridge.trash().then((entries) => { if (mounted.current) setDeleted(entries); }).catch(() => {});
    const off = bridge.onState((next) => { if (mounted.current) setState(next); });
    return () => { mounted.current = false; off(); };
  }, [bridge]);
  const perform = async (action: () => Promise<CloudSyncStatus>) => {
    if (working) return;
    setWorking(true);
    setFailed(null);
    try { const next = await action(); if (mounted.current) setState(next); }
    catch (error) { if (mounted.current) setFailed(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setWorking(false); }
  };
  const on = state?.enabled === true;
  const status = syncStatusKey(state);
  const disk = state?.disk ?? null;
  const waitingBytes = (state?.waiting ?? []).reduce((sum, item) => sum + item.size, 0);
  return <section className="flex w-full flex-col gap-2 border-t border-line pt-3" aria-label={t("cloudSync.title")}>
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-[14px] text-ink">{t("cloudSync.title")}</span>
        <p className="text-[12px] text-ink-secondary">{t("cloudSync.help")}</p>
        <p className="text-[12px] text-ink-secondary">{t("cloudSync.everyBot")}</p>
      </div>
      <Switch checked={on} disabled={working || state === null} aria-label={t("cloudSync.title")}
        onClick={() => { if (on) setAsking(true); else void perform(() => bridge.set({ enabled: true })); }} />
    </div>
    {asking && <div role="group" className="flex flex-col gap-2 rounded-lg bg-control p-3">
      <span className="text-[13px] text-ink">{t("cloudSync.offTitle")}</span>
      <span className="text-[12px] text-ink-secondary">{t("cloudSync.offHelp")}</span>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-button" data-sync="off-keep" onClick={() => { setAsking(false); void perform(() => bridge.set({ enabled: false, keepCloudCopy: true })); }}>{t("cloudSync.offKeep")}</button>
        <button type="button" className="ui-button" data-sync="off-delete" onClick={() => { setAsking(false); void perform(() => bridge.set({ enabled: false, keepCloudCopy: false })); }}>{t("cloudSync.offDelete")}</button>
        <button type="button" className="ui-button" data-sync="off-cancel" onClick={() => setAsking(false)}>{t("cloudSync.cancel")}</button>
      </div>
    </div>}
    {status && <p role="status" className="text-[13px] text-ink-secondary">{t(status)}</p>}
    {failed && <p role="alert" className="text-[13px] text-danger">{t("cloudSync.failed", { error: failed })}</p>}
    {on && <>
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={state?.openAtLogin === true} disabled={working} onChange={(event) => void perform(() => bridge.set({ openAtLogin: event.target.checked }))} />
        {t("cloudSync.openAtLogin")}
      </label>
      {disk && <div className="flex flex-col gap-1">
        <span className="text-[13px] text-ink">{t("cloudSync.meter", { used: formatSyncBytes(disk.usedBytes), total: formatSyncBytes(disk.planMaxBytes) })}</span>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-control" aria-hidden="true">
          <div className={disk.warn ? "h-full bg-warning" : "h-full bg-accent"} style={{ width: `${Math.min(100, Math.round((disk.usedBytes / disk.planMaxBytes) * 100))}%` }} />
        </div>
        <span className="text-[12px] text-ink-secondary">{t("cloudSync.breakdown", { synced: formatSyncBytes(disk.syncedBytes), bots: formatSyncBytes(disk.botFileBytes), trash: formatSyncBytes(disk.trashBytes) })}</span>
        {disk.warn && <span className="text-[12px] text-warning">{t("cloudSync.almostFull")}</span>}
      </div>}
      {(state?.waiting.length ?? 0) > 0 && <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink">{t("cloudSync.waiting", { count: state!.waiting.length, size: formatSyncBytes(waitingBytes) })}</span>
        <button type="button" className="ui-button" data-sync="upgrade" onClick={() => void bridge.upgrade()}>{t("cloudSync.upgrade")}</button>
      </div>}
      {(state?.missing.length ?? 0) > 0 && <p className="text-[13px] text-ink">{t("cloudSync.missing")}</p>}
      {fileList(t("cloudSync.clashes"), (state?.clashes ?? []).map((item) => ({ folderId: item.folderId, path: item.clashPath, note: item.path })), bridge)}
      {fileList(t("cloudSync.held"), (state?.held ?? []).map((item) => ({ folderId: item.folderId, path: item.path, note: t(item.reason === "windows-name" ? "cloudSync.heldName" : "cloudSync.heldCase") })), bridge, false)}
      {fileList(t("cloudSync.problems"), (state?.problems ?? []).map((item) => ({ folderId: item.folderId, path: item.path, note: item.error })), bridge)}
      {(state?.notices ?? []).map((notice) => <p key={`${notice.folderId}/${notice.path}`} className="text-[12px] text-ink-secondary">{t("cloudSync.notice", { path: notice.path })}</p>)}
      {deleted.length > 0 && <div className="flex flex-col gap-1">
        <span className="text-[13px] text-ink">{t("cloudSync.recentlyDeleted")}</span>
        {deleted.slice(0, 20).map((entry) => <div key={entry.id} className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
          <span className="truncate font-mono">{entry.path}</span>
          <button type="button" className="ui-button" onClick={() => void perform(async () => { const next = await bridge.restore(entry.id); setDeleted(deleted.filter((item) => item.id !== entry.id)); return next; })}>{t("cloudSync.restore")}</button>
        </div>)}
      </div>}
    </>}
  </section>;
}

function fileList(title: string, items: Array<{ folderId: string; path: string; note: string }>, bridge: CloudSyncBridge, showable = true) {
  if (!items.length) return null;
  return <div className="flex flex-col gap-1">
    <span className="text-[13px] text-ink">{title}</span>
    {items.slice(0, 20).map((item) => <div key={`${item.folderId}/${item.path}`} className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
      <span className="truncate"><span className="font-mono">{item.path}</span>: {item.note}</span>
      {showable && item.folderId && <button type="button" className="ui-button" onClick={() => void bridge.open({ folderId: item.folderId, path: item.path })}>{t("cloudSync.show")}</button>}
    </div>)}
  </div>;
}
```

If `bg-warning`, `text-warning` or `bg-accent` are not theme tokens in this app (`grep -n "warning\|accent" src/index.css | head`), use the closest existing tokens. Lending's Settings uses `text-danger`; keep to existing tokens, so every skin keeps working.

In `src/components/CloudAccountSettings.tsx`:
1. Add `import { CloudSync } from "./CloudSync";` beside the `CloudLending` import.
2. Add `sync` to `cloudHomeCard`'s parameters and its type: `sync?: CloudAccountBridge["sync"]`.
3. Render `{sync && <CloudSync bridge={sync} />}` after `{lending && <CloudLending bridge={lending} />}`.
4. Pass `sync: bridge.sync` beside `lending: bridge.lending` in the `cloudHomeCard({ … })` call.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -s vitest run src/components/CloudSync.test.ts src/locales && pnpm -s i18n:check && pnpm -s exec tsc -b && pnpm -s lint`
Expected: PASS. All checks silent.

- [ ] **Step 6: Commit**

```bash
git add src/components/CloudSync.tsx src/components/CloudSync.test.ts src/components/CloudAccountSettings.tsx src/locales/en.json
git commit -m "feat(sync): Settings switch, disk meter, waiting files with Upgrade, and recently deleted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Choose on this PC, and the Move to Cloud step

**Files:**
- Create: `src/components/bot-settings/link-pc-folder.ts`
- Modify: `src/components/bot-settings/AccessSection.tsx` (`WorkingFolder`: a "Choose on this PC" button when `window.ogb?.cloudSync` exists)
- Create: `src/components/cloud-move-sync.ts`
- Modify: `src/components/CloudMove.tsx` (a "Keep the folders bots use in sync with My Cloud" checkbox; turns sync on when a move to My Cloud finishes)
- Modify: `src/locales/en.json` (`cloudMove.keepInSync`)
- Test: `src/components/bot-settings/link-pc-folder.test.ts`, `src/components/cloud-move-sync.test.ts`

**Interfaces:**
- Consumes: `window.ogb.cloudSync.linkFolder()` and `window.ogb.cloudAccount.sync.set()` (Task 15).
- Produces:
  - `linkPcFolder(bridge, save): Promise<string | null>`, which answers the error text, or null
  - `syncAfterMove(previousPhase, nextPhase, destinationKind, wanted): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/bot-settings/link-pc-folder.test.ts
import { expect, it, vi } from "vitest";
import { linkPcFolder } from "./link-pc-folder";

it("saves the Cloud copy of the folder the person picked", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  expect(await linkPcFolder({ linkFolder: vi.fn().mockResolvedValue({ cloudPath: "/data/Synced/Ash-PC/PA" }) }, save)).toBeNull();
  expect(save).toHaveBeenCalledWith("/data/Synced/Ash-PC/PA");
});

it("does nothing when the picker is cancelled, and answers why linking failed", async () => {
  const save = vi.fn();
  expect(await linkPcFolder({ linkFolder: vi.fn().mockResolvedValue(null) }, save)).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(await linkPcFolder({ linkFolder: vi.fn().mockRejectedValue(new Error("Turn on Sync with My Cloud first.")) }, save)).toBe("Turn on Sync with My Cloud first.");
});
```

```ts
// src/components/cloud-move-sync.test.ts
import { expect, it } from "vitest";
import { syncAfterMove } from "./cloud-move-sync";

it("turns sync on once, when a wanted move to My Cloud finishes", () => {
  expect(syncAfterMove("restoring", "done", "cloud", true)).toBe(true);
  expect(syncAfterMove("done", "done", "cloud", true)).toBe(false);
  expect(syncAfterMove("restoring", "done", "cloud", false)).toBe(false);
  expect(syncAfterMove("restoring", "done", "server", true)).toBe(false);
  expect(syncAfterMove("uploading", "failed", "cloud", true)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -s vitest run src/components/bot-settings/link-pc-folder.test.ts src/components/cloud-move-sync.test.ts`
Expected: FAIL with `Failed to resolve import`.

- [ ] **Step 3: Write the implementation**

```ts
// src/components/bot-settings/link-pc-folder.ts
/** Choose on this PC: main shows the picker and links the folder; the bot then works in its Cloud copy. */
export async function linkPcFolder(bridge: { linkFolder(): Promise<{ cloudPath: string } | null> }, save: (cwd: string) => Promise<void>): Promise<string | null> {
  try {
    const linked = await bridge.linkFolder();
    if (linked) await save(linked.cloudPath);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
```

```ts
// src/components/cloud-move-sync.ts
/** True once, at the moment a move to My Cloud the person wanted kept in sync finishes. */
export function syncAfterMove(previousPhase: string | undefined, nextPhase: string, destinationKind: string | undefined, wanted: boolean): boolean {
  return wanted && destinationKind === "cloud" && nextPhase === "done" && previousPhase !== "done";
}
```

In `AccessSection.tsx` `WorkingFolder`:
1. Add `import { linkPcFolder } from "./link-pc-folder";`.
2. Below `const canPick = …`, add `const cloudSync = window.ogb?.cloudSync;`.
3. In the form, after the Save button, add:

```tsx
          {cloudSync && !canPick && (
            <button type="button" disabled={saving} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              onClick={() => void linkPcFolder(cloudSync, (cwd) => save(cwd)).then((problem) => { if (problem) setError(problem); })}>
              Choose on this PC
            </button>
          )}
```

`save` already handles `setSaving` and the server's refusal. `canPick` is the local-desktop folder picker, so the button shows only on the My Cloud page inside the desktop app.

In `src/locales/en.json`, add `"cloudMove.keepInSync": "Keep the folders bots use in sync with My Cloud",`.

In `CloudMove.tsx`:
1. Add `import { syncAfterMove } from "./cloud-move-sync";`.
2. In the component that owns `bridge.onState(next => …)` (the `useEffect` around lines 147–160), add `const [keepInSync, setKeepInSync] = useState(true);` and `const lastPhase = useRef<string | undefined>(undefined);` with the other hooks.
3. Inside the `onState` callback, before `setLive(next)`, add:

```ts
      if (syncAfterMove(lastPhase.current, next.phase, next.destination?.kind, keepInSync)) void window.ogb?.cloudAccount?.sync?.set({ enabled: true }).catch(() => {});
      lastPhase.current = next.phase;
```

4. Where the idle view renders the start button (`moveButton(view, move, onStart)` with `idle`), render the checkbox before the button when the destination is My Cloud:

```tsx
      {idle && state.destination?.kind !== "server" && window.ogb?.cloudAccount?.sync && <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={keepInSync} onChange={(event) => setKeepInSync(event.target.checked)} />
        {t("cloudMove.keepInSync")}
      </label>}
```

Keep the checkbox in the same component as `keepInSync`. If the button is rendered in a child component, pass `keepInSync`/`setKeepInSync` down as props instead of adding a second state. `CloudMove.tsx` is not on the size ratchet.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -s vitest run src/components/bot-settings src/components/cloud-move-sync.test.ts src/components/CloudMove.test.ts && pnpm -s i18n:check && pnpm -s exec tsc -b && pnpm -s lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/bot-settings/link-pc-folder.ts src/components/bot-settings/link-pc-folder.test.ts src/components/bot-settings/AccessSection.tsx src/components/cloud-move-sync.ts src/components/cloud-move-sync.test.ts src/components/CloudMove.tsx src/locales/en.json
git commit -m "feat(sync): Choose on this PC in a bot's folder setting, and keep folders in sync after Move to Cloud

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: End to end against a real Cloud home

**Files:**
- Create: `server/cloud-sync.e2e.test.ts`

**Interfaces:**
- Consumes: the real server booted as a Cloud home (the harness from `server/cloud-home-server.test.ts`: `beforeAll` spawn, `ownerPairing`, offline `fetch` prelude); `createCloudSyncService` (Task 14).

- [ ] **Step 1: Write the test**

Copy `server/cloud-home-server.test.ts`'s harness into the new file: the constants `SERVER_DIR`, `HOST`, `secret`, `included`; `api()`; `beforeAll` (fake Claude CLI, `config.json`, web stand-in, spawn with the Cloud env); `ownerPairing()`; `afterAll`. Make these changes:
- Leave out the `OMB_HOSTED_*` gateway settings. They are not needed here.
- Add `OMB_SYNC_ROOT: join(home, "Synced")` to the child's env.

Then add:

```ts
import { createCloudSyncService } from "../electron/cloud-sync.mjs";

const PC_ORIGIN = `https://${HOST}`;
// The desktop's fetch, but over the test's loopback edge: the owner's pairing token stands in for the window's cookie.
const desktopFetch = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(url.replace(PC_ORIGIN, base), { ...init, headers: { ...(init.headers ?? {}), host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", authorization: `Bearer ${ownerToken}` } });

function desktop(pcHome: string, bots: unknown[] = []) {
  return createCloudSyncService({
    settingsFile: join(pcHome, "user", "settings.json"), stateFile: join(pcHome, "user", "state.db"),
    documentsDir: join(pcHome, "Documents"), localDataDir: join(pcHome, ".openmausbot"), homeDir: pcHome, platform: process.platform, hostname: "Ash-PC",
    cloudOrigin: () => PC_ORIGIN, fetch: desktopFetch as typeof fetch, localBots: async () => ({ bots, groups: [] }),
    growDisk: async () => null, planDisk: () => null, trashItem: async (file: string) => rmSync(file), watch: () => () => {},
    now: () => Date.now() + 60_000,
  });
}

it("syncs a linked PC folder both ways, keeps both on a clash, trashes and restores, and points the Cloud bot at the copy", async () => {
  const pcHome = mkdtempSync(join(tmpdir(), "omb-sync-pc-"));
  const project = join(pcHome, "Clients", "Acme");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "brief.md"), "the brief");
  const created = await api("POST", "/api/bots", { body: { name: "Sync fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const botId = created.body.bot.id as string;
  const service = desktop(pcHome, [{ id: botId, name: "Sync fixture", cwd: project, tasks: [] }]);
  try {
    await service.setEnabled(true);
    await service.pass();
    const synced = join(home, "Synced", "Ash-PC", "Acme");
    expect(readFileSync(join(synced, "brief.md"), "utf8")).toBe("the brief");
    const bots = await api("GET", "/api/bots?messages=0");
    expect(bots.body.bots.find((bot: { id: string }) => bot.id === botId).cwd).toBe(synced);

    writeFileSync(join(synced, "from-a-bot.md"), "made on My Cloud");
    await service.pass();
    expect(readFileSync(join(project, "from-a-bot.md"), "utf8")).toBe("made on My Cloud");

    writeFileSync(join(project, "brief.md"), "PC edit");
    utimesSync(join(project, "brief.md"), new Date(Date.now() - 10_000), new Date(Date.now() - 5_000));
    writeFileSync(join(synced, "brief.md"), "bot edit");
    await service.pass();
    expect(readFileSync(join(project, "brief.md"), "utf8")).toBe("bot edit");
    const clash = readdirSync(project).find((name) => name.startsWith("brief (PC copy, "))!;
    expect(readFileSync(join(project, clash), "utf8")).toBe("PC edit");
    expect(readFileSync(join(synced, clash), "utf8")).toBe("PC edit");

    rmSync(join(project, "from-a-bot.md"));
    await service.pass();
    expect(existsSync(join(synced, "from-a-bot.md"))).toBe(false);
    const [entry] = await service.trash();
    expect(entry.path).toBe("from-a-bot.md");
    await service.restore(entry.id);
    await service.pass();
    expect(readFileSync(join(project, "from-a-bot.md"), "utf8")).toBe("made on My Cloud");
  } finally {
    service.close();
    rmSync(pcHome, { recursive: true, force: true });
  }
}, 60_000);

it("brings a bot's conversation folder down to Documents/MausBot", async () => {
  const pcHome = mkdtempSync(join(tmpdir(), "omb-sync-pc-"));
  const created = await api("POST", "/api/bots", { body: { name: "Report Owl", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } });
  const bot = created.body.bot as { id: string; threadId: string };
  const output = join(home, ".openmausbot", "task-workspaces", bot.id, bot.threadId);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "report.md"), "# Q3");
  const service = desktop(pcHome);
  try {
    await service.setEnabled(true);
    await service.pass();
    const owl = join(pcHome, "Documents", "MausBot", "Report Owl");
    const [conversation] = readdirSync(owl);
    expect(readFileSync(join(owl, conversation!, "report.md"), "utf8")).toBe("# Q3");
  } finally {
    service.close();
    rmSync(pcHome, { recursive: true, force: true });
  }
}, 60_000);
```

(Add `existsSync, readdirSync, utimesSync` to the `node:fs` import.)

- [ ] **Step 2: Run it**

Run: `pnpm -s vitest run server/cloud-sync.e2e.test.ts`
Expected: PASS, 2 tests. A failure here is a real integration bug in Tasks 5–14. Fix the code there, not this test. Two likely causes:
- the origin check refusing the desktop's requests: compare the headers with lending's (`electron/computer-sharing.mjs` `request`);
- the bot `cwd` PATCH refusing a folder: registration must create the Cloud copy first.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm -s exec tsc -b && pnpm -s lint && pnpm -s i18n:check && pnpm test`
Expected: all four steps of `pnpm test` pass: vitest, broker, `node --test electron/*.node-test.mjs`, and the packaged-server smoke test. That last one is the only check that exercises the esbuild bundle, so it proves the server bundles `electron/cloud-sync-rules.mjs`. Report any failure by name, including ones this branch did not cause.

- [ ] **Step 4: Commit**

```bash
git add server/cloud-sync.e2e.test.ts
git commit -m "test(sync): end to end against a real Cloud home

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
