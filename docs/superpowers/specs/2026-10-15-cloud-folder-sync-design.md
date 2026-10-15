# Cloud Folder Sync

## Summary

A Cloud bot runs around the clock, but it can only work with files on the Cloud. Today that is the MausBot data
folder copied once by Move to Cloud, plus chat attachments. The folders bots worked in on the person's PC (a client
folder, `Documents\PA`) stay behind: the move clears those working folders, and lending ("Let My Cloud use this
computer") reaches them only while the PC is on, and only for turns the owner started, so delegated work never can.

Add **Sync with My Cloud**: one switch in the desktop app that keeps every folder a bot is linked to on the PC, and
every bot's output folder on the Cloud, the same on both sides. The desktop drives it over the Cloud connection it
already has. Synced files live on the Cloud's own disk and count against the plan, so a person who syncs more needs a
bigger plan; when files no longer fit, they wait and the app offers the upgrade.

## Decisions (Omkar, 2026-10-15)

- Built-in, through MausBot Cloud only. No OneDrive, Google Drive or other third-party storage.
- One opt-in switch. When on, everything bots use syncs: no per-folder picking in v1.
- Scope is files: the PC folders bots are linked to, and bots' own output folders. Bots, memory and chats are not
  copied; they live on the Cloud, which the desktop opens as My Cloud.
- A clash keeps both copies.
- When files do not fit: what fits keeps syncing, the rest waits, and the person sees a disk meter and an Upgrade
  button. The button opens a self-serve plan change, which is **project 2** (Admin repo, its own spec).
- Our own sync engine (approach A), not Syncthing or rclone.

## Goals

- A file saved into a linked PC folder is on the Cloud within a minute while the desktop app runs, and a Cloud bot
  works on it there with the PC off.
- A file a Cloud bot saves appears on the PC within a minute of the PC being on.
- No edit is ever lost: clashes keep both copies; deletes go to a trash on the Cloud (30 days) and to the PC's
  Recycle Bin / Trash.
- The person always sees how much of their Cloud disk is used, gets a warning at 80% of the plan's limit, and an
  upgrade path when it is full.
- Works on the Windows and macOS desktop apps against a Linux Cloud home.

## Non-goals (v1)

- Per-folder choice, exclusion rules the person edits, or selective sync.
- Copying only the changed parts of a file (delta transfer). Files travel whole.
- Empty folders, file permissions, attributes, timestamps other than modified time, extended attributes.
- Phones. iOS and Android do not browse or sync files.
- The Linux desktop app.
- Version history beyond the 30-day trash.
- Syncing Cloud-only project folders (a bot `cwd` on the Cloud outside `task-workspaces` and the synced root).
- Sharing a synced folder with another account or another person's Cloud.

## What syncs

### PC folders bots are linked to

Every absolute folder outside the PC's MausBot data folder that the **local** desktop server names as a working
folder:

- `bot.cwd`, each task's `cwd` and `pinnedCwd` in `bots.json`;
- each room's `cwd` in `groups.json`.

The desktop reads these from its local server, so they are the PC's real paths. One PC folder linked by several bots,
tasks or rooms syncs once. A folder inside another linked folder is not a second folder: it syncs as part of the
outer one. The home folder, any folder above it and a volume root are refused, with the same rule as lending
(`validateSharedFolders`, `electron/computer-sharing.mjs`); a refused link is listed in Settings with the reason.

New links: a bot's **Project folder** setting gains **Choose on this PC** when the page runs inside the desktop app. It
opens the native folder picker, adds the folder to sync, and sets the bot's `cwd` to the Cloud copy. With the switch
off, it offers to turn it on first.

### Bots' output folders

Each conversation folder `DATA_DIR/task-workspaces/<botId>/<threadId>/` on the Cloud that holds at least one file
syncs to the PC as `<Documents>/MausBot/<Bot name>/<Conversation title>/` (`app.getPath("documents")`). The names
are made safe for the PC (see Name rules), a duplicate gets ` (2)`, and they are fixed when the folder first syncs:
renaming the bot or conversation later does not rename the PC folder. Memory (`DATA_DIR/workspaces/<botId>`) does not
sync.

### Never synced

- Directories: `node_modules`, `.git`, `.venv`, `venv`, `__pycache__`, `.mypy_cache`, `.pytest_cache`, `.next`,
  `.turbo`, `.cache`.
- Files: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `~$*` (Office lock files), `*.tmp`, `*.crdownload`, `*.part`,
  `.~lock.*#`.
- Symbolic links, junctions, and files with more than one hard link, on either side.
- A Cloud file whose name the PC cannot hold (Name rules). It stays on the Cloud and is listed.

The skip list and the name rules live in one plain JavaScript module, `electron/cloud-sync-rules.mjs` with a `.d.mts`.
The desktop package ships only `electron/**`, and the server imports the module from there (its bundle inlines it).

## Layout on the Cloud

| What | Where |
|---|---|
| Synced PC folders | `<sync root>/<PC name>/<folder name>/`; the sync root is `OMB_SYNC_ROOT`, default `join(dirname(DATA_DIR), "Synced")`, which is `/data/Synced` on a Cloud home |
| Folder registry | `DATA_DIR/sync/folders.json` |
| File index and change journal | `DATA_DIR/sync/index.db` (`node:sqlite`) |
| Uploads in progress | `DATA_DIR/sync/uploads/<uploadId>.part`, dropped after 24 h |
| Trash | `DATA_DIR/sync/trash/<entryId>`, with its row in `index.db`, swept after 30 days |

`<PC name>` is `os.hostname()` made safe, with ` (2)` on a clash between computers. The synced root is outside
`DATA_DIR`, so a workspace backup or a later move does not carry it; `sync/` inside `DATA_DIR` is added to the
workspace backup's exclusions (`server/workspace-backup.ts`).

PC folders are registered and stored: `{ id, kind: "pc", computerId, computerName, pcPath, cloudPath, createdAt }`.
`computerId` is a random UUID the desktop keeps in its user data, never the hostname. Bot output folders are not
stored: `GET /api/sync` derives them from `task-workspaces/*/*` folders that hold a file, as
`{ id: "bot-<botId>-<threadId>", kind: "bot", botId, threadId, cloudPath }`, so a new conversation's folder appears
without a registration step. The desktop names the PC folder from the bot's name and the conversation's title, which
it reads from the Cloud's `GET /api/bots`.

## Components

| Unit | Side | Does |
|---|---|---|
| `electron/cloud-sync-rules.mjs` | both | skip list, name rules, NFC and case folding, the clash file name |
| `electron/cloud-sync-plan.mjs` | desktop | pure three-way planner: base, PC and Cloud listings in, actions out |
| `electron/cloud-sync-scan.mjs` | desktop | walks a PC folder, stats, hashes what changed, watches for changes |
| `electron/cloud-sync-state.mjs` | desktop | `userData/cloud-sync/state.db`: base rows, folder map, waiting files, clashes, issues |
| `electron/cloud-sync.mjs` | desktop | the service: `createCloudSync({...})` → `{ start, close, state, setEnabled, linkFolder }`; runs the loop, transfers, status |
| `server/cloud-sync.ts` | Cloud | registry, index, journal, uploads, commits, ops, trash, disk numbers |
| `server/routes/cloud-sync.ts` | Cloud | the `/api/sync/*` routes |
| `src/components/CloudSync.tsx` | desktop UI | the switch, meter, status, problem lists, Recently deleted |

Each unit is tested alone; the planner has no I/O.

## Protocol

All routes are served only on a Cloud home, only to a session with admin scope, with the same CSRF origin check as
the lending routes. The desktop calls them with `session.defaultSession.fetch`, `credentials: "include"` and the
Cloud origin header, the way `electron/computer-sharing.mjs` does. Paths on the wire are relative, `/`-separated and
NFC-normalized; the server refuses `..`, NUL, absolute paths and any path that resolves through a link.

| Route | Answer |
|---|---|
| `GET /api/sync` | `{ folders, cursor, disk: { totalBytes, freeBytes, syncedBytes, botFileBytes, trashBytes, reserveBytes } }` |
| `POST /api/sync/folders` `{ computerId, computerName, pcPath, name }` | `{ folder }`; idempotent on `computerId` + `pcPath` (case-folded for a Windows path) |
| `DELETE /api/sync/folders/:id` `{ keepCloudCopy }` | `204`; with `keepCloudCopy: false` the copy goes to the trash and linked `cwd`s are cleared |
| `GET /api/sync/folders/:id/files` | `{ files: [{ path, size, mtimeMs, sha256 }] }`, after the server rescans what changed |
| `GET /api/sync/changes?cursor=N&waitMs=60000` | long poll: `{ cursor, folderIds }` as soon as anything changes, else at `waitMs` |
| `POST /api/sync/folders/:id/uploads` `{ path, size, sha256, baseSha256 }` | `{ uploadId, received }`, or `507 { neededBytes, freeBytes }` |
| `PUT /api/sync/uploads/:uploadId?offset=N` | raw bytes, at most 16 MB a part; `409 { received }` on a wrong offset |
| `POST /api/sync/uploads/:uploadId/commit` | `{ sha256 }`; `409 { current }` when the file changed since `baseSha256`; `422` when the bytes do not hash to `sha256` |
| `GET /api/sync/folders/:id/file?path=` | the bytes, `Range` supported, with `x-omb-sha256` |
| `POST /api/sync/folders/:id/ops` `{ ops: [{ op: "delete", path, baseSha256 } \| { op: "move", from, to, sha256 }] }` | `{ results: [{ ok: true } \| { conflict: true, current }] }` |
| `GET /api/sync/trash` / `POST /api/sync/trash/restore` `{ entryId }` | Recently deleted, newest first; restore puts the file back (as a clash copy if the path is taken) |

The upload protocol is Move to Cloud's (`server/cloud-move.ts`): resumable by offset, a repeated part is a no-op,
proxies that refuse 16 MB get halved parts down to 512 KB, retries at 1/3/8/15/30 s. Unlike the move, many uploads
can be open at once (one per file), and a commit writes to a temporary file in the target folder and renames it into
place. A commit or a `delete` op that replaces or removes a file moves the old version to the trash first.

## Deciding what to do

The desktop keeps, per folder, a **base** row for every file as it was when last in step on both sides:
`{ path, sha256, pcSize, pcMtimeMs }`. Each pass compares base, PC and Cloud:

| PC since base | Cloud since base | Action |
|---|---|---|
| changed or new | same or absent in base | upload (`baseSha256` = base's) |
| same | changed or new | download |
| changed | changed, different bytes | **clash**: keep both |
| changed | changed, same bytes | record the new base, move nothing |
| deleted | same | delete on the Cloud, into the trash |
| same | deleted | delete on the PC, into the Recycle Bin / Trash (`shell.trashItem`) |
| deleted | changed | download the Cloud version (an edit beats a delete) |
| changed | deleted | upload the PC version (an edit beats a delete) |
| deleted | deleted | drop the base row |

"Changed" on the PC means size or modified time differs from the base, confirmed by hashing; a file whose size or
modified time moves while it is hashed, or that changed in the last 2 s, waits for the next pass. A file with an
Office lock file (`~$name`) beside it waits until the lock is gone.

**Clash.** The Cloud's version keeps the name on both sides, so bots that refer to the path keep working. The PC's
version is uploaded as `<name> (PC copy, 15 Oct 2026)<ext>` (then `… 15 Oct 2026 2`), renamed to the same on the PC,
and listed under Clashes with Open folder.

**A commit that lost a race** (`409 { current }`) becomes a clash by the same rule. A Cloud write never replaces a
version the desktop has not seen.

**Renames.** In one pass, a deleted path and a new path with the same `sha256` in the same folder become one `move`
op instead of a delete and a fresh upload or download.

**First sync** of a folder has no base: files only on one side are copied to the other; files on both with the same
bytes become base rows; files on both with different bytes are clashes. A first sync never deletes.

**Directories** are created as files need them and removed when sync has emptied them. An empty folder the person
creates is not synced (non-goal).

### Name rules

- On the wire and in the index, names are NFC.
- Toward a Windows PC, a Cloud name is held back (listed as "can't sync to this PC") when it has `<>:"\|?*` or a
  control character, ends in a dot or a space, or is a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
  `LPT1`–`LPT9`, with or without an extension). Long paths are written with the `\\?\` prefix.
- On a case-insensitive PC (Windows; macOS by default, checked once per folder), Cloud paths equal under case folding
  and NFC: the first in byte order syncs, the others are held back and listed.
- A PC name is always valid on the Linux Cloud except one with NUL, which cannot occur.

## Noticing changes

- **PC:** `fs.watch(folder, { recursive: true })` (Windows and macOS) triggers a pass for that folder after 1 s of quiet;
  a full rescan runs every 5 minutes, at start, on wake (`powerMonitor` `resume`) and when the network returns.
- **Cloud:** the server watches the sync root and the bot output folders with `fs.watch` (recursive on Linux in Node
  24), bumps a change cursor in `index.db`, and answers the open `GET /api/sync/changes`. The desktop's 5-minute full
  pass lists every Cloud folder too, so a change the watcher missed is still found. Hashes are cached in `index.db` by size and modified
  time, so a listing only hashes what changed.
- Two transfers run at a time; hashing is streamed.

## Disk, waiting files and upgrade

- `GET /api/sync` reports the volume's `totalBytes`/`freeBytes` (`statfs` on the sync root) and what sync accounts for.
  The plan's limit is `cloud.disk.maxGb` from the Admin summary the desktop already reads (`electron/cloud-home.mjs`).
- **Reserve:** an upload that would leave less than 1 GiB free is refused with `507`, so bots and the app keep working.
- On `507`, if the plan's disk can still grow, the desktop asks the Admin to grow it in 10 GB steps, through the call
  Move to Cloud uses (`POST /api/cloud/desktop/disk`, within its rate limits), then retries.
- If it cannot grow, the file **waits**. Files that fit keep syncing. Status: "12 files (1.8 GB) are waiting: My Cloud
  is full", with an **Upgrade** button ("Get more space"; naming the next plan's disk waits for project 2's plan
  catalog). Waiting files go up by themselves when space appears.
- At 80% of the plan's limit the meter turns amber and the tray/menu says "My Cloud is 80% full".
- **Upgrade** opens project 2's plan change. Until project 2 ships, it opens the Cloud page in the browser ("Change
  plan: email us" today).
- Downloads wait while the PC has less than 1 GiB free, with a notice.

## What bots see

- A bot or room linked to a PC folder works in the Cloud copy: the desktop sets its `cwd` to the `cloudPath` with the
  existing `PATCH /api/bots/:id` / `PATCH /api/groups/:id` (`validateBotCwd`), when the switch turns on (Move included)
  and from Choose on this PC. Registering a folder creates its Cloud copy at once, so the folder exists when the `cwd`
  is checked. A task already pinned to a folder keeps it; new tasks use the bot's.
- `cloudHomePrompt` (`server/system-prompt.ts`) gains one line from the registry: "Folders synced from Ash-PC:
  `C:\Users\Ash\Documents\PA` → `/data/Synced/Ash-PC/PA`; … A path on that computer inside one of these means the synced
  copy." At most 20 folders are listed, then a count. Instruction text is never rewritten, so turning sync off leaves
  nothing broken.
- Lending is unchanged. For a folder that is both lent and synced, the prompt tells bots to use the synced copy.

## Move to Cloud

The move gains one step, **Keep your folders in sync with My Cloud?** (Yes / Not now). With Yes, after the restore
the desktop registers the linked folders it read from the local server, runs their first sync, then sets the Cloud
bots' and rooms' `cwd`s to the copies. Bot ids survive a restore, so the links match. If they do not fit, the move still finishes;
sync waits with the upgrade prompt.

A Cloud moved earlier (Ash's) does the same when the switch is turned on later, from the same local data.

## Desktop lifecycle and UI

- `createCloudSync` starts in the `app.whenReady` chain when the switch is on and stops in `before-quit`, like
  lending. It pauses while the Cloud is signed out or unpaired and resumes when the Cloud account refreshes.
- It runs while the app runs, with no window open: the Windows tray already keeps the app alive; on macOS a tray item
  shows while sync is on, like the lending indicator.
- Turning sync on also turns on **Open MausBot when I log in** (`app.setLoginItemSettings`), with its own checkbox to
  turn it off. The app opens as it does when started by hand; starting hidden is a follow-up (`createWindow` has no
  hidden start today).
- **Settings → MausBot Cloud → Sync with My Cloud** (`CloudSync.tsx`): the switch, with copy that says every Cloud
  bot can use synced files; the meter; the folder list with each folder's state; Waiting, Clashes and Can't sync
  lists with Open folder; Recently deleted with Restore.
- Tray/menu line: "Synced, 2 min ago" / "Syncing 3 files" / "Waiting: My Cloud is full" / "Offline" /
  "Sign in to My Cloud again".
- The bridge for Choose on this PC is `cloudSync` in `electron/preload.cjs`, added to `REMOTE_SAFE`: the person chooses
  in a native dialog, and the page never reads PC paths or files.
- **Turning sync off** stops it and asks: keep the Cloud copies (default; linked bots keep working) or delete them
  (to the trash; their `cwd`s are cleared and those bots go back to their own folders). Nothing on the PC is deleted
  by turning sync off.

## Security

- Synced files are on the Cloud's disk, where **every** Cloud bot can read and change them, including turns started by
  webhooks, guests or routines someone else wrote. Lending's owner-only rule (`server/cloud-lending.ts`) does not apply
  to files at rest. The switch's copy says so before it turns on.
- Agent configuration a Cloud bot changes in a synced folder (`CLAUDE.md`, `AGENTS.md`, `.claude/**`, the files
  `server/lending-memory.ts` fingerprints) is downloaded but shown in a notice ("A Cloud bot changed CLAUDE.md in PA"),
  because coding tools on the PC load those files.
- Only the owner's admin session reaches `/api/sync/*`. Neither side follows links. The Cloud volume is encrypted at
  rest (`ensureVolume`, `encrypted: true`), and transfers are HTTPS.
- Sync counts in the Cloud health report (synced bytes, waiting files, clashes; never names or paths) are a follow-up:
  the Admin's health schema has to accept them first.

## Errors and recovery

- Network failure: retry at 1/3/8/15/30 s, then every 5 minutes; status "Offline".
- `401`/`403`: stop and show "Sign in to My Cloud again".
- A file locked or refused on the PC (`EBUSY`, `EPERM`): retried on the next pass; listed after three failures.
- A crash mid-pass is safe: uploads resume by offset, commits are atomic renames, the PC side writes to a temporary
  file in the folder and renames, and the base is updated only after both sides agree.
- `state.db` lost or damaged: the next pass is a first sync, which never deletes.

## Size ratchets

`server/index.ts` (17,972) and `electron/main.mjs` (3,557) are at their ceilings. The routes need no wiring from
`index.ts`: `server/routes/table.ts` lists them in `ROUTES`. `index.ts` changes only to pass the synced-folder line to
`cloudHomePrompt` (its two `./enterprise.ts` imports merge to pay for the import). `main.mjs` makes room by moving
`recordDesktopCrash` into `electron/diagnostics.mjs`.

## Testing

1. **Planner** (`electron/cloud-sync-plan.node-test.mjs`): every row of the table, renames, first sync never
   deleting, a lost race becoming a clash, clash names, the 2 s and lock-file waits, Windows-forbidden and case-only
   names.
2. **Cloud** (`server/cloud-sync.test.ts`): registry idempotence, path refusal (traversal, links), upload resume and
   repeated parts, commit `409` and `422`, `507` with the 1 GiB reserve, trash and its 30-day sweep, restore as a clash
   copy, the change long poll.
3. **End to end** (`server/cloud-sync.e2e.test.ts`): a real Cloud-home server (as `server/cloud-home-server.test.ts`)
   and the desktop service on two temporary folders: edits both ways, a clash keeping both, delete → trash → restore,
   an interrupted upload resuming, a full disk making files wait and then sync once space frees, bots relinked after a
   move.
4. **Windows:** the PC-side tests also run on the Windows CI job (Recycle Bin, `\\?\` long paths, name rules, case
   folding).

## Project 2: self-serve plan change (Admin repo, separate spec)

Today a subscriber cannot change plan in the product ("Change plan: email us"; Dodo plan changes are off). Project 2
adds an in-app plan change (Dodo subscription update, proration) and raises the Cloud's disk ceiling at once, instead
of in the nightly update window. This spec's Upgrade button targets it and falls back to the Cloud page until it
ships.
