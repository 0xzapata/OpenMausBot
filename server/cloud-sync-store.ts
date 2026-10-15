// The Cloud side of folder sync's records: which PC folders sync (folders.json), what each synced folder holds with
// hashes cached by size and modified time (index.db), and the trash. Bot output folders are not stored: they are the
// conversation folders under task-workspaces that hold a file.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
