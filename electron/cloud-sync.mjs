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
