// The conversation reads and uploads, moved out of server/index.ts's inline
// routes into the route table (server/routes/README.md): the GET /api/bots
// snapshot, a thread's message pages and one message's image or file, image
// and document uploads, serving an attachment, search across every
// transcript, the transcript export, and a conversation's job (jobs.ts). The
// table runs after the auth gate; scope rules stay keyed by path in
// server/request-auth.ts.
import type { WireBot, WireGroup, WireTask } from "../../shared/wire.ts";
import {
  ATTACHMENTS_DIR, extensionForMime, FILE_MAX_BYTES, IMAGE_MAX_BYTES, parseAudioRange, readAttachment, saveFile, saveImageUpload,
  validateAttachmentUploadId, type SavedAttachment,
} from "../attachments.ts";
import { deliveredCopy } from "../bot-attachment.ts";
import { memberBot, memberGroup, type Viewer, type VisibleSet } from "../bot-visibility.ts";
import type { ComputerControl } from "../computer-control.ts";
import type { AppConfig } from "../config.ts";
import type { Coordinator } from "../coordinator.ts";
import type { ModelSelection } from "../contracts.ts";
import type { WorkspaceAccess } from "../enterprise.ts";
import type { GroupUsageReader } from "../group-thread-usage.ts";
import { searchMessagesAsync } from "../message-db.ts";
import {
  listMessageFolder, messageAttachmentName, messageFileDisposition, messageFileDownloadName, messageFolderEntryName,
  messageImageTargetAt, messageReferencesFile, openMessageFile, openMessageFolderEntry, referencedFileName,
} from "../message-file.ts";
import { resolveRequestAuth, type RequestAuth, type ResolveOptions } from "../request-auth.ts";
import type { queuedSteerSnapshot } from "../steer-queue.ts";
import type { BotRecord, GroupRecord, Message, Store, TaskRecord } from "../store.ts";
import { createJobRoutes } from "./jobs.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

/** A transcript page as index.ts's messagePage builds it: the whole thread,
 * or a bounded tail with `hasMore`. */
export type MessagePage = { messages: Array<Message | Record<string, unknown>>; hasMore?: boolean; activeLeafId: string | null };

export interface ThreadRouteDeps {
  store: Pick<Store,
    | "activeLeaf" | "activePath" | "bot" | "botByThread" | "bots" | "groupByThread" | "groupTaskByThread" | "groups" | "messagesFor"
    | "onChange" | "sections" | "taskByThread" | "tasks">;
  /** The job runtime, for a conversation's job (jobs.ts). */
  coordinator: Pick<Coordinator, "job">;
  groupThreadIsWorking(groupId: string, threadId: string): boolean;
  cfg: Pick<AppConfig, "profile">;
  sessions: ResolveOptions["sessions"];
  groupUsageReader: Pick<GroupUsageReader, "refresh">;
  hostedWorkspace: boolean;
  sessionCookie: string;
  loopback: { trust: ResolveOptions["loopbackTrust"] };
  lendingEnabled(): boolean;
  /** The slots index.ts fills at boot or on first use, after the routes are
   * built (server/host/README.md, rule 5): read once per request. */
  workspaceAccess(): WorkspaceAccess | null;
  desktopMutationToken(): string | undefined;
  companionMutationToken(): string | undefined;
  cliOwnerToken(): string | undefined;
  /** How many messages a page carries when the client names no size. */
  defaultPage: number;
  pageSize(raw: string | null): number | null | undefined;
  messagePage(threadId: string, limit: number | undefined, before?: string | null): MessagePage;
  messageWindow(threadId: string, messageId: string, limit: number): { messages: Array<Message | Record<string, unknown>>; hasMore: boolean } | null;
  publicBotQueuedMessages(): ReturnType<typeof queuedSteerSnapshot>;
  publicGroupState(record: GroupRecord): WireGroup;
  wireBot(bot: BotRecord): WireBot;
  wireTask(task: TaskRecord, botModel: ModelSelection): WireTask;
  botComputerControlSnapshot(botId: string): ReturnType<ComputerControl["snapshot"]>;
  messageFileRootsForThread(senderId: string, threadId: string): string[];
  viewerFor(auth: RequestAuth): Viewer;
  visibleTo(viewer: Viewer): VisibleSet;
}

export function createThreadRoutes(deps: ThreadRouteDeps): RouteHandler {
  const {
    store, cfg, sessions, groupUsageReader, lendingEnabled,
    hostedWorkspace: HOSTED_WORKSPACE, sessionCookie: SESSION_COOKIE, loopback: LOOPBACK, defaultPage: DEFAULT_PAGE,
    pageSize, messagePage, messageWindow, publicBotQueuedMessages, publicGroupState, wireBot, wireTask,
    botComputerControlSnapshot, messageFileRootsForThread, viewerFor, visibleTo,
  } = deps;
  const jobs = createJobRoutes({ store, coordinator: deps.coordinator, groupThreadIsWorking: deps.groupThreadIsWorking, viewerFor, visibleTo, sessions });
  // The image, file and export routes answer with `return res.end(…)`, so the
  // body's result is whatever Node hands back; the table only asks whether
  // it was PASS.
  const handle = async ({ req, res, url, path, method, auth, json, readBody }: RouteContext): Promise<unknown> => {
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    // Bot visibility as index.ts's preamble computed it for this request,
    // and the late-bound slots, read now so the routes see one value each.
    const visible = visibleTo(viewerFor(auth));
    const workspaceAccess = deps.workspaceAccess();
    const desktopMutationToken = deps.desktopMutationToken();
    const companionMutationToken = deps.companionMutationToken();
    const cliOwnerToken = deps.cliOwnerToken();
    if (method === "GET" && path === "/api/bots") {
      try { groupUsageReader.refresh(); } catch { /* accounting must not block a snapshot */ }
      const limit = pageSize(url.searchParams.get("messages"));
      if (limit === null) return json(res, 400, { error: "messages must be a non-negative whole number" });
      // wireBot(), not publicBot(): this snapshot answers with the page it
      // was asked for, not the default one. tasks stays explicit, as in
      // publicBot(): wireBot() omits the key entirely for a bot record
      // carrying no tasks, where clients expect [].
      // A member on a workspace with a restricted bot gets only what they may
      // see (bot-visibility.ts); for everyone else these filters keep all.
      const shownBots = store.bots.filter((bot) => visible.bot(bot.id));
      const queued = publicBotQueuedMessages();
      return json(res, 200, {
        bots: shownBots.map((bot) => memberBot({
          ...wireBot(bot),
          tasks: store.tasks(bot.id).map((task) => wireTask(task, bot.modelSelection)),
          ...messagePage(bot.threadId, limit),
        }, visible)),
        botQueuedMessages: visible.everything ? queued : Object.fromEntries(Object.entries(queued).filter(([threadId]) => visible.thread(threadId))),
        sections: visible.sections(store.sections),
        groups: store.groups.filter((g) => visible.group(g.id)).map((g) => {
          const room = { ...publicGroupState(g), ...messagePage(g.threadId, limit) };
          return visible.everything ? room : memberGroup(room);
        }),
        computerControl: Object.fromEntries(
          shownBots.map((bot) => {
            const snapshot = botComputerControlSnapshot(bot.id);
            return [bot.id, { held: snapshot.held, helpReason: snapshot.helpReason, ...(snapshot.help ? { help: snapshot.help } : {}) }];
          }),
        ),
      });
    }

    // scrollback: the page before a message the client already holds
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
    if (m && method === "GET") {
      const threadId = m[1];
      if (!store.botByThread(threadId) && !store.groupByThread(threadId)) {
        return json(res, 404, { error: "no such conversation" });
      }
      const limit = pageSize(url.searchParams.get("limit"));
      if (limit === null) return json(res, 400, { error: "limit must be a non-negative whole number" });
      const before = url.searchParams.get("before");
      const around = url.searchParams.get("around");
      if (before && around) return json(res, 400, { error: "before and around cannot be combined" });
      if (around) {
        const window = messageWindow(threadId, around, limit ?? DEFAULT_PAGE);
        if (!window) return json(res, 404, { error: "no such message" });
        return json(res, 200, { ...window, activeLeafId: store.activeLeaf(threadId) });
      }
      // An unknown cursor must not silently answer with the newest page —
      // the client would paginate in a circle and never reach the top.
      if (before && !store.messagesFor(threadId).some((msg) => msg.id === before)) {
        return json(res, 404, { error: "no such message" });
      }
      return json(res, 200, { ...messagePage(threadId, limit ?? DEFAULT_PAGE, before), activeLeafId: store.activeLeaf(threadId) });
    }

    // the pixels of one screen message, fetched only when something shows it
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/image$/);
    if (m && method === "GET") {
      // Same guard as the page route above, and for the same reason twice
      // over: an unknown id should 404 deliberately rather than by accident,
      // and `messagesFor` materialises and caches a ThreadState for whatever
      // it is handed. Without this, a client asking for images on ids that
      // do not exist grows the thread map for as long as it keeps asking.
      if (!store.botByThread(m[1]) && !store.groupByThread(m[1])) {
        return json(res, 404, { error: "no such conversation" });
      }
      const message = store.messagesFor(m[1]).find((msg) => msg.id === m![2]);
      if (!message?.png) return json(res, 404, { error: "no image on that message" });
      const bytes = Buffer.from(message.png, "base64");
      res.writeHead(200, {
        "content-type": message.mime ?? "image/png",
        "content-length": String(bytes.byteLength),
        // a settled message's image never changes
        "cache-control": "private, max-age=31536000, immutable",
      });
      return res.end(bytes);
    }

    // Download one local file only when this exact stored message grants it:
    // a bot must render a Markdown link or carry a generated-image attachment,
    // while a user message must carry the standalone composer tag. The bot
    // branch derives conversation/workspace roots; the user branch is limited
    // to OpenMausBot's private attachment directory. This is deliberately not
    // a general path reader.
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/file$/);
    const streamsMessageImage = Boolean(
      m && method === "GET" && url.searchParams.get("preview") === "1",
    );
    if (m && (method === "POST" || streamsMessageImage)) {
      if (method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const threadId = m[1]!;
      const directBot = store.botByThread(threadId);
      const group = directBot ? undefined : store.groupByThread(threadId);
      if (!directBot && !group) return json(res, 404, { error: "no such conversation" });

      const message = store.messagesFor(threadId).find((candidate) => candidate.id === m![2]);
      if (!message) return json(res, 404, { error: "no such message" });
      if (message.kind !== "text" || (!message.text && !message.attachments?.length)) {
        return json(res, 403, { error: "that message does not share this file" });
      }
      const messageText = message.text ?? "";
      const body = method === "POST" ? await readBody(req) : null;
      const rawReference = streamsMessageImage ? url.searchParams.get("ref") : null;
      if (streamsMessageImage && (!rawReference || !/^\d+$/.test(rawReference))) {
        return json(res, 400, { error: "ref must identify a rendered image" });
      }
      const href = method === "POST"
        ? (typeof body.path === "string" ? body.path : "")
        : messageImageTargetAt(messageText, Number(rawReference));
      if (!href) return json(res, 400, { error: "path is required" });

      let roots: string[];
      let downloadName: string | undefined;
      // A file the bot attached with attach_file lives in the private
      // attachment store; the message itself is the grant, exactly as a
      // user's attachment tag is for their own uploads.
      const botAttachment = message.role === "bot"
        ? message.attachments?.find((attachment) => attachment.path === href)
        : undefined;
      if (message.role === "user") {
        downloadName = messageAttachmentName(messageText, href) ?? undefined;
        if (!downloadName) {
          return json(res, 403, { error: "that message does not share this file" });
        }
        roots = [ATTACHMENTS_DIR];
      } else if (botAttachment) {
        // Files and images alike: the stored message is the grant, so the
        // mobile clients can fetch an attached image through this route too.
        downloadName = botAttachment.kind === "file" ? botAttachment.name : undefined;
        roots = [ATTACHMENTS_DIR];
      } else {
        if (!messageReferencesFile(messageText, href)) {
          return json(res, 403, { error: "that bot message does not link to this file" });
        }
        const senderId = directBot?.id ?? message.from?.botId;
        // The persisted bot-role message is the author record. Membership is
        // intentionally not consulted: removing a bot must not break files it
        // already shared in channel history.
        if (!senderId) {
          return json(res, 403, { error: "the file's bot author could not be verified" });
        }
        roots = messageFileRootsForThread(senderId, threadId);
      }

      // A link to a folder answers with its files; each one is then fetched
      // by plain name under the same message grant and file checks.
      const folderEntry = method === "POST" && body.entry !== undefined
        ? messageFolderEntryName(body.entry)
        : undefined;
      if (folderEntry === null) return json(res, 400, { error: "entry must be one file name" });
      let file: Awaited<ReturnType<typeof openMessageFile>>;
      try {
        file = folderEntry
          ? await openMessageFolderEntry(href, folderEntry, roots)
          : await openMessageFile(href, roots);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const status = (error as { status?: unknown } | null)?.status;
        // A reply's file outside the conversation's folders, or gone, that
        // its bot delivered with attach_file this turn: the stored copy is
        // what the reply shows and saves, as a chat link's would be.
        const name = message.role === "bot" && !botAttachment && !folderEntry && (code === "outside_workspace" || status === 404)
          ? referencedFileName(href)
          : null;
        const copy = name ? deliveredCopy(store.messagesFor(threadId), message, name) : null;
        if (copy) {
          file = await openMessageFile(copy.path, [ATTACHMENTS_DIR]);
          downloadName = copy.name;
        } else {
          // Only a client that asks for listings gets one; older clients keep the 400.
          if (body?.listFolder !== true || folderEntry || code !== "directory") throw error;
          const listing = await listMessageFolder(href, roots);
          res.setHeader("x-openmausbot-folder", "1");
          res.setHeader("cache-control", "private, no-store");
          return json(res, 200, listing);
        }
      }
      if ((streamsMessageImage || botAttachment?.kind === "image") && !file.mime.startsWith("image/")) {
        await file.handle.close();
        return json(res, 415, { error: "only images can be previewed here" });
      }
      res.writeHead(200, {
        "content-type": file.mime,
        "content-length": String(file.bytes),
        ...(streamsMessageImage
          ? { "content-disposition": "inline" }
          : { "content-disposition": messageFileDisposition(messageFileDownloadName(downloadName, file.name)) }),
        "cache-control": streamsMessageImage ? "private, max-age=3600" : "private, no-store",
        "cdn-cache-control": "no-store",
        "cloudflare-cdn-cache-control": "no-store",
        pragma: "no-cache",
        vary: "Authorization",
        "x-content-type-options": "nosniff",
        ...(streamsMessageImage
          ? {
              "cross-origin-resource-policy": "same-origin",
              "referrer-policy": "no-referrer",
            }
          : {}),
      });
      if (file.bytes === 0) {
        await file.handle.close();
        return res.end();
      }
      const stream = file.handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }

    // ── image attachments ────────────────────────────────────────────────
    // Pasted/dropped images are stored as files and referenced by path in
    // the prompt (<attached-image path="…"/>); this pair of routes is the
    // save + serve. The POST takes raw bytes (base64 JSON would double the
    // payload), so it needs its own reader rather than readBody. A share
    // extension can add a UUID uploadId; retrying that UUID returns the same
    // committed path instead of creating an orphan duplicate.
    if (method === "POST" && path === "/api/attachments") {
      let uploadId: string | undefined;
      try {
        uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
      } catch (error) {
        req.resume();
        throw error;
      }
      const rawType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"];
      const mime = rawType?.split(";")[0]?.trim().toLowerCase();
      if (!mime || !extensionForMime(mime)) {
        return json(res, 400, { error: "content-type must be an image type" });
      }
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        return json(res, 400, { error: "content-length must be a non-negative integer" });
      }
      if (declaredLength !== undefined && declaredLength > IMAGE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `image exceeds ${IMAGE_MAX_BYTES} bytes` });
      }
      const saved = await new Promise<SavedAttachment>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        const fail = (status: number, msg: string) => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error(msg), { status }));
        };
        req.on("data", (chunk: Buffer) => {
          if (settled) return;
          received += chunk.byteLength;
          if (received > IMAGE_MAX_BYTES) return fail(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
          chunks.push(chunk);
        });
        req.on("end", async () => {
          if (settled) return;
          settled = true;
          try {
            resolve(await saveImageUpload(Buffer.concat(chunks), mime, uploadId));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
        req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
      });
      return json(res, 201, saved);
    }

    // ── shared files ────────────────────────────────────────────────────
    // Companion apps and the desktop composer send documents as raw bytes
    // over the same authenticated connection as messages. saveFile writes each
    // incoming chunk directly to disk, atomically commits it, and removes
    // partial uploads on error. Its optional UUID uploadId is stable across
    // route retries, while the aggregate store quota rejects rather than
    // silently deleting files that old prompts may still reference.
    if (method === "POST" && path === "/api/files") {
      let uploadId: string | undefined;
      try {
        uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
      } catch (error) {
        req.resume();
        throw error;
      }
      const name = url.searchParams.get("name");
      if (!name) {
        req.resume();
        return json(res, 400, { error: "name is required" });
      }
      const rawType = Array.isArray(req.headers["content-type"])
        ? req.headers["content-type"][0]
        : req.headers["content-type"];
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        return json(res, 400, { error: "content-length must be a non-negative integer" });
      }
      if (declaredLength !== undefined && declaredLength > FILE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `file exceeds ${FILE_MAX_BYTES} bytes` });
      }
      try {
        // Returning from this iterator must not destroy the request socket:
        // the caller still needs to receive the useful 4xx response when the
        // streamed byte count crosses the limit.
        const chunks = req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
        const saved = await saveFile(chunks, name, rawType ?? "", { uploadId, expectedBytes: declaredLength });
        return json(res, 201, saved);
      } catch (error) {
        req.resume();
        throw error;
      }
    }

    // serving is name-locked to the attachments dir — readAttachment
    // refuses anything that is not a bare generated filename
    m = path.match(/^\/api\/attachments\/([\w.-]+)$/);
    if (m && method === "GET") {
      const attachment = readAttachment(m[1]!);
      if (!attachment) return json(res, 404, { error: "no such attachment" });
      const size = attachment.bytes.byteLength;
      // Who may see an attachment is decided per request — the dispatcher
      // 404s hidden ones above — so the browser must never reuse one
      // member's copy after a switch to another identity in the same profile.
      const headers = {
        "content-type": attachment.mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      };
      // Range serving is audio-only (#1745): a player scrubbing a voice note
      // asks for byte windows, and images/documents keep the full response
      // the app has always relied on. A header we do not understand reads
      // as absent — the full 200 is always a correct answer to a GET.
      if (attachment.mime.startsWith("audio/")) {
        const rawRange = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
        const range = parseAudioRange(rawRange, size);
        if (range.kind === "unsatisfiable") {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
          return res.end();
        }
        if (range.kind === "range") {
          res.writeHead(206, {
            ...headers,
            "content-length": String(range.end - range.start + 1),
            "content-range": `bytes ${range.start}-${range.end}/${size}`,
          });
          return res.end(attachment.bytes.subarray(range.start, range.end + 1));
        }
      }
      res.writeHead(200, { ...headers, "content-length": String(size) });
      return res.end(attachment.bytes);
    }

    // ── search across every transcript ──────────────────────────────────
    // Literal substring scans run in a bounded read-only worker so a large
    // history cannot stall unrelated turns. Hits resolve to the owning bot/room;
    // rows belonging to deleted conversations resolve to nothing and drop.
    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 0, 1), 100) : 40;
      const threadId = url.searchParams.get("threadId")?.trim() || undefined;
      if (threadId && ((!store.botByThread(threadId) && !store.groupByThread(threadId)) || !visible.thread(threadId))) {
        return json(res, 404, { error: "no such conversation" });
      }
      // whether each hit sits on its thread's visible branch — a click on
      // one that does not has to switch versions first (and only then)
      const activePaths = new Map<string, Set<string>>();
      const onActivePath = (threadId: string, messageId: string) => {
        let ids = activePaths.get(threadId);
        if (!ids) activePaths.set(threadId, (ids = new Set(store.activePath(threadId).map((m) => m.id))));
        return ids.has(messageId);
      };
      // A member who may not see every bot: look further, then keep only
      // hits in conversations they can open.
      const found = await searchMessagesAsync(q, visible.everything ? limit : Math.min(limit * 10, 1_000), threadId);
      // A scan may outlive a revocation or audience edit. Authorize again
      // after the await, and resolve visibility from current store state.
      if (HOSTED_WORKSPACE && auth.kind === "session") {
        const failure = workspaceAccess ? await workspaceAccess.authorize(req, auth)
          : { status: 503, error: "Workspace sign-in is unavailable." };
        if (failure) return json(res, failure.status, { error: failure.error });
      }
      const current = resolveRequestAuth(req, {
        sessions, cookieName: SESSION_COOKIE, streamPath: "/api/events", url,
        loopbackMutationToken: desktopMutationToken, companionMutationToken,
        features: { sharedComputers: lendingEnabled() }, loopbackTrust: LOOPBACK.trust, cliOwnerToken,
      });
      if (!current.auth) return json(res, current.status, { error: current.error });
      const currentVisible = visibleTo(viewerFor(current.auth));
      if (threadId && !currentVisible.thread(threadId)) return json(res, 404, { error: "no such conversation" });
      const hits = found
        .filter((hit) => currentVisible.thread(hit.threadId))
        .slice(0, limit)
        .map((hit) => {
          const bot = store.botByThread(hit.threadId);
          const group = bot ? undefined : store.groupByThread(hit.threadId);
          if (!bot && !group) return null;
          const active = onActivePath(hit.threadId, hit.messageId);
          if (bot) {
            const task = store.taskByThread(bot.id, hit.threadId);
            return { ...hit, botId: bot.id, name: bot.name, task: task?.title, onActivePath: active };
          }
          if (group) {
            const task = store.groupTaskByThread(group.id, hit.threadId);
            return { ...hit, groupId: group.id, name: group.name, task: task?.title, onActivePath: active };
          }
          return null;
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      return json(res, 200, { hits });
    }

    // ── transcript export (the visible branch, human-readable) ──────────
    m = path.match(/^\/api\/threads\/([\w-]+)\/export$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const bot = store.botByThread(threadId);
      const group = bot ? undefined : store.groupByThread(threadId);
      if (!bot && !group) return json(res, 404, { error: "no such conversation" });
      const format = url.searchParams.get("format") ?? "markdown";
      if (format !== "markdown" && format !== "json") {
        return json(res, 400, { error: "format must be markdown or json" });
      }
      const title = bot
        ? (store.taskByThread(bot.id, threadId)?.title || bot.name)
        : (store.groupTaskByThread(group!.id, threadId)?.title || group!.name);
      const filename = (title.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);
      const messages = store.activePath(threadId);
      if (format === "json") {
        // pixels stripped — an export is for reading and archiving, and a
        // base64 desktop frame is neither
        const slim = messages.map(({ png: _png, mime: _mime, ...rest }) => rest);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${filename}.json"`,
        });
        return res.end(JSON.stringify({ name: title, threadId, messages: slim }, null, 2));
      }
      const userName = cfg.profile?.name?.trim() || "User";
      const lines: string[] = [`# ${title}`, ""];
      for (const msg of messages) {
        const sentBy = msg.sender?.name ?? userName;
        const who = msg.role === "user"
          ? msg.via === "api" ? `${sentBy} (via the local API)` : sentBy
          : (msg.from?.name ?? bot?.name ?? "Bot");
        // A widget exports as its text fallback (shared/widget.ts widgetToText).
        if ((msg.kind === "text" || msg.kind === "widget") && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
        else if (msg.kind === "activity" && msg.tool) lines.push(`> ${msg.tool.name}`, "");
        else if (msg.kind === "screen") lines.push("> [screen capture]", "");
        else if (msg.kind === "options" && msg.card) {
          lines.push(`> ${msg.card.title}${msg.card.answered ? ` — answered: ${msg.card.answered}` : ""}`, "");
        }
      }
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}.md"`,
      });
      return res.end(lines.join("\n"));
    }
    return PASS;
  };
  return async (ctx) => (await jobs(ctx) !== PASS || await handle(ctx) !== PASS ? undefined : PASS);
}
