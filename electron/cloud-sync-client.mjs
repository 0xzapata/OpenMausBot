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
