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
  // Uploads last and smallest first, so a file that does not fit cannot hold back the small ones.
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
