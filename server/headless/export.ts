// export: one conversation's job, written to a folder a person or a CI step
// can keep. Everything is read through the routes the app itself uses, each
// under its own grant: the job tree (GET /api/threads/:id/job), every
// transcript of the job (the transcript export), the files its bots' replies
// link to (the message-scoped file route: a reply is the grant; a linked
// folder brings the files directly in it), and screen captures the server
// kept. Bounded by file count, screen count and bytes actually written;
// transcripts and the job tree pass through secret redaction.
//
//   DIR/manifest.json   what was written, and what was skipped and why
//   DIR/job.json        the job tree: every assignment, its status and result
//   DIR/transcripts/    each conversation of the job, .json and .md
//   DIR/files/          files the replies link to, per conversation
//   DIR/screens/        screen captures, per conversation
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { messageFileTargets } from "../message-file.ts";
import { EXIT, flag, HeadlessError, parseCount, parseSize, usageError } from "./args.ts";
import { readJob, type HeadlessClient } from "./client.ts";
import { resolveTarget, type VerbContext, type VerbOutcome } from "./context.ts";
import { redactDeep, type Output } from "./output.ts";

type Rec = Record<string, any>;

export interface ExportOptions {
  threadId: string;
  out: string;
  /** Work open at or begun after this server time (default: the whole conversation). */
  since?: number;
  /** Only this root's tree. */
  root?: string;
  maxFiles?: number;
  maxScreens?: number;
  maxBytes?: number;
  /** Write into a folder that already has files in it (an earlier export's files are replaced). */
  force?: boolean;
}

const TRANSCRIPT_MESSAGES = 2_000;
const MESSAGE_TEXT_MAX = 50_000;
const enc = encodeURIComponent;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "conversation";

/** A name made safe to write on any system: one path segment, no control
 * or reserved characters, no trailing dot or space (Windows drops them), and
 * never a Windows device name (con.md would be the console there). */
export function safeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const name = basename(raw.replace(/[\\/]/g, "_")).replace(/[\x00-\x1f<>:"|?*]/g, "_").trim().slice(0, 120).replace(/[. ]+$/, "");
  if (!name) return "file";
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? `_${name}` : name;
}

/** A file name from the server's content-disposition, else the link's own. */
function fileName(disposition: string | null, link: string): string {
  const star = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="([^"]+)"/i)?.[1];
  let name = "";
  try { name = star ? decodeURIComponent(star) : plain ?? decodeURIComponent(basename(link.split(/[?#]/)[0]!)); } catch { name = plain ?? ""; }
  return safeName(name);
}

/** A name this export has not used yet in a folder: report.md, report (2).md, …
 * (a file an earlier export left there is replaced, under --force). */
function unused(dir: string, name: string, taken: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; taken.has(join(dir, candidate)); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(join(dir, candidate));
  return candidate;
}

/** The folder an export writes: new, or empty unless `force`. Checked before
 * anything is read or sent (run --export checks it before the job starts). */
export function exportFolder(dir: string, force: boolean): string {
  const out = resolve(dir);
  if (!existsSync(out) || force) return out;
  let entries: string[];
  try {
    entries = readdirSync(out);
  } catch (error) {
    throw usageError(`${out} cannot be written into (${(error as NodeJS.ErrnoException).code ?? "error"})`, "choose a folder");
  }
  if (entries.length) throw usageError(`${out} already has files in it`, "choose an empty folder, or pass --force to write into it");
  return out;
}

/** A transcript for people to read, written from the messages the export
 * keeps (the .json's, secrets already removed), as the app's own Markdown
 * export lays it out: so a long conversation's .md ends with the job, not
 * with its first few megabytes. */
function markdownOf(title: string, messages: readonly Rec[], botName: string): string {
  const lines: string[] = [`# ${title}`, ""];
  for (const message of messages) {
    const who = message.role === "user"
      ? `${message.sender?.name ?? "User"}${message.via === "api" ? " (via the local API)" : ""}`
      : message.from?.name ?? botName;
    if (message.kind === "text" && message.text) lines.push(`**${who}:**`, "", String(message.text), "");
    else if (message.kind === "activity" && message.tool) lines.push(`> ${message.tool.name}`, "");
    else if (message.kind === "screen") lines.push("> [screen capture]", "");
    else if (message.kind === "options" && message.card) lines.push(`> ${message.card.title}${message.card.answered ? ` — answered: ${message.card.answered}` : ""}`, "");
  }
  return lines.join("\n");
}

/** Under --force: what an earlier export wrote in this folder, as its
 * manifest lists it, is removed before this one writes, so no file of an
 * older job is left beside this one's. Only files that manifest names, inside
 * the folder; anything else in it is left alone. */
function removeEarlierExport(out: string): void {
  let manifest: Rec;
  try {
    manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Rec;
  } catch {
    return;
  }
  const listed = [manifest.transcripts, manifest.files, manifest.screens].flatMap((entries) => Array.isArray(entries) ? entries as Rec[] : [])
    .map((entry) => entry?.file).filter((file): file is string => typeof file === "string");
  const written = [...listed, ...listed.filter((file) => /^transcripts[\\/].*\.json$/.test(file)).map((file) => file.replace(/\.json$/, ".md")), "job.json", "manifest.json"];
  for (const file of written) {
    const target = resolve(out, file);
    const inside = relative(out, target);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue;
    try { rmSync(target, { force: true }); } catch { continue; } // a folder of that name is not a file it wrote
    // and the folders that held only what it wrote
    for (let folder = dirname(target); relative(out, folder) && !relative(out, folder).startsWith(".."); folder = dirname(folder)) {
      try { rmdirSync(folder); } catch { break; }
    }
  }
}

const OVER_LIMIT = Symbol("over the byte limit");

/** A response body into a new file, counting as it goes: past `limit` bytes it
 * stops, removes what it wrote, and says so. A length header is not trusted:
 * a proxy in front of the server may send the body without one. */
async function writeCapped(response: Response, file: string, limit: number): Promise<number | typeof OVER_LIMIT> {
  let written = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      written += chunk.length;
      if (written > limit) done(new Error("over the byte limit"));
      else done(null, chunk);
    },
  });
  const body = response.body ? Readable.fromWeb(response.body as WebReadableStream<Uint8Array>) : Readable.from([]);
  try {
    await pipeline(body, count, createWriteStream(file, { mode: 0o600 }));
    return written;
  } catch (error) {
    rmSync(file, { force: true });
    if (written > limit) return OVER_LIMIT;
    throw error;
  }
}

/** Why the server would not hand a file over, in its own words. */
const refusal = async (response: Response | null): Promise<string> =>
  response ? String(((await response.json().catch(() => ({}))) as Rec).error ?? `HTTP ${response.status}`) : "the server did not answer";

export async function exportJob(client: HeadlessClient, options: ExportOptions, output: Output): Promise<Rec> {
  const out = exportFolder(options.out, options.force === true);
  if (options.force) removeEarlierExport(out);
  const maxFiles = options.maxFiles ?? 200;
  const maxScreens = options.maxScreens ?? 100;
  const maxBytes = options.maxBytes ?? 500_000_000;
  const job = await readJob(client, options.threadId, { since: String(options.since ?? 0), full: "1" });
  const nodes: Rec[] = (job.nodes ?? []).filter((node: Rec) => !options.root || node.rootId === options.root);
  if (options.root && !nodes.length) throw usageError(`no job with root ${options.root} in this conversation`, "openmausbot export TARGET without --root writes all of it");
  for (const dir of ["transcripts", "files", "screens"]) mkdirSync(join(out, dir), { recursive: true });

  const threads = new Map<string, string>([[options.threadId, "conversation"]]);
  const botNames = new Map<string, string>();
  for (const node of nodes) {
    if (!threads.has(node.threadId)) threads.set(node.threadId, `${node.botName}${node.threadTitle ? `-${node.threadTitle}` : ""}`);
    if (!node.groupId && !botNames.has(node.threadId)) botNames.set(node.threadId, String(node.botName));
  }
  const transcripts: Rec[] = [];
  const files: Rec[] = [];
  const screens: Rec[] = [];
  const skipped: Rec[] = [];
  const taken = new Set<string>();
  let bytes = 0;

  /** One answered file into `dir` under what is left of the byte budget, or the reason it is not. */
  const keep = async (response: Response, dir: string, wanted: string, about: Rec, into: Rec[]) => {
    const left = maxBytes - bytes;
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > left) {
      await response.body?.cancel();
      skipped.push({ ...about, reason: `more than --max-bytes ${maxBytes}` });
      return;
    }
    mkdirSync(dir, { recursive: true });
    const file = join(dir, unused(dir, wanted, taken));
    const written = await writeCapped(response, file, left);
    if (written === OVER_LIMIT) {
      skipped.push({ ...about, reason: `more than --max-bytes ${maxBytes}` });
      return;
    }
    bytes += written;
    // with /, as the transcripts' paths are, whatever system wrote it
    into.push({ ...about, file: relative(out, file).split(sep).join("/"), bytes: written });
  };
  const fileRoute = (threadId: string, messageId: string, body: Rec) =>
    client.raw(`/api/threads/${enc(threadId)}/messages/${enc(messageId)}/file`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => null);

  /** A linked file, or each file directly in a linked folder, under the reply's own grant. */
  const saveLinked = async (threadId: string, folder: string, messageId: string, link: string) => {
    const about = { threadId, messageId, link };
    if (files.length >= maxFiles) return void skipped.push({ ...about, reason: `more than --max-files ${maxFiles}` });
    const response = await fileRoute(threadId, messageId, { path: link, listFolder: true });
    if (!response?.ok) return void skipped.push({ ...about, reason: await refusal(response) });
    if (response.headers.get("x-openmausbot-folder") !== "1") {
      return keep(response, join(out, "files", folder), fileName(response.headers.get("content-disposition"), link), about, files);
    }
    const listing = await response.json() as Rec;
    const dir = join(out, "files", folder, safeName(String(listing.name ?? "folder")));
    for (const entry of Array.isArray(listing.entries) ? listing.entries as Rec[] : []) {
      const name = String(entry.name);
      const one = { ...about, entry: name };
      if (files.length >= maxFiles) { skipped.push({ ...one, reason: `more than --max-files ${maxFiles}` }); continue; }
      const answered = await fileRoute(threadId, messageId, { path: link, entry: name });
      if (!answered?.ok) { skipped.push({ ...one, reason: await refusal(answered) }); continue; }
      await keep(answered, dir, safeName(name), one, files);
    }
    if (listing.truncated === true) skipped.push({ ...about, reason: "the folder has more files than the server lists" });
  };

  for (const [threadId, label] of threads) {
    const name = `${slug(label)}-${threadId.slice(0, 8)}`;
    let transcript: Rec;
    try {
      transcript = await client.json(`/api/threads/${enc(threadId)}/export?format=json`);
    } catch (error) {
      skipped.push({ threadId, reason: `transcript not readable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const all: Rec[] = Array.isArray(transcript.messages) ? transcript.messages : [];
    const kept = all.slice(-TRANSCRIPT_MESSAGES).map((message) => typeof message.text === "string" && message.text.length > MESSAGE_TEXT_MAX
      ? { ...message, text: `${message.text.slice(0, MESSAGE_TEXT_MAX)}…` } : message);
    const redacted = redactDeep({ name: transcript.name, threadId, label, ...(all.length > kept.length ? { truncated: all.length - kept.length } : {}), messages: kept });
    writeFileSync(join(out, "transcripts", `${name}.json`), `${JSON.stringify(redacted, null, 2)}\n`, { mode: 0o600 });
    const title = String(redacted.name ?? label);
    writeFileSync(join(out, "transcripts", `${name}.md`), markdownOf(title, redacted.messages, botNames.get(threadId) ?? "Bot"), { mode: 0o600 });
    transcripts.push({ threadId, label, file: `transcripts/${name}.json`, messages: kept.length, ...(all.length > kept.length ? { truncated: all.length - kept.length } : {}) });

    // the files its replies link to or attach, each under that reply's grant
    const seen = new Set<string>();
    for (const message of kept) {
      if (message.role !== "bot" || message.kind !== "text") continue;
      const links = [...messageFileTargets(String(message.text ?? "")), ...(message.attachments ?? []).map((attachment: Rec) => String(attachment.path))];
      for (const link of links) {
        if (seen.has(link)) continue;
        seen.add(link);
        await saveLinked(threadId, name, message.id, link);
      }
    }

    // screen captures the server kept (their pixels are never in the transcript)
    for (const message of kept) {
      if (message.kind !== "screen") continue;
      const about = { threadId, messageId: message.id };
      if (screens.length >= maxScreens) { skipped.push({ ...about, reason: `more than --max-screens ${maxScreens}` }); continue; }
      const response = await client.raw(`/api/threads/${enc(threadId)}/messages/${enc(message.id)}/image`).catch(() => null);
      // a capture whose pixels the server no longer keeps is not a failure
      if (response?.status === 404) { await response.body?.cancel(); continue; }
      if (!response?.ok) { skipped.push({ ...about, reason: await refusal(response) }); continue; }
      const type = response.headers.get("content-type") ?? "image/png";
      const ext = type.includes("jpeg") ? ".jpg" : type.includes("webp") ? ".webp" : ".png";
      await keep(response, join(out, "screens", name), `${String(screens.length + 1).padStart(3, "0")}-${message.id}${ext}`, about, screens);
    }
  }

  writeFileSync(join(out, "job.json"), `${JSON.stringify(redactDeep({ ...job, nodes }), null, 2)}\n`, { mode: 0o600 });
  const manifest = {
    ok: true, out, exportedAt: new Date().toISOString(), server: client.baseUrl, threadId: options.threadId,
    state: job.state, reason: job.reason, ...(options.root ? { root: options.root } : {}),
    transcripts, files, screens, skipped, bytes,
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(redactDeep(manifest), null, 2)}\n`, { mode: 0o600 });
  output.progress({ event: "exported", out, transcripts: transcripts.length, files: files.length, screens: screens.length, skipped: skipped.length });
  return manifest;
}

export async function exportVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const out = flag(ctx.flags, "out")?.trim();
  if (!out) throw usageError("--out is required (the folder to write)");
  const rawSince = flag(ctx.flags, "since");
  const options = {
    out,
    ...(rawSince !== undefined ? { since: parseCount(rawSince, "--since", 0, Number.MAX_SAFE_INTEGER, 0) } : {}),
    ...(flag(ctx.flags, "root") ? { root: flag(ctx.flags, "root")!.trim() } : {}),
    maxFiles: parseCount(flag(ctx.flags, "max-files"), "--max-files", 200, 100_000, 0),
    maxScreens: parseCount(flag(ctx.flags, "max-screens"), "--max-screens", 100, 100_000, 0),
    maxBytes: flag(ctx.flags, "max-bytes") ? parseSize(flag(ctx.flags, "max-bytes")!, "--max-bytes") : 500_000_000,
    force: ctx.flags.force === true,
  };
  exportFolder(out, options.force);
  const target = await resolveTarget(ctx, ctx.positionals[0]);
  const client = await ctx.client();
  let threadId = target.taskId;
  if (!threadId) {
    const fleet = await client.json<Rec>("/api/bots?messages=0");
    threadId = (target.type === "bot" ? fleet.bots : fleet.groups)?.find((record: Rec) => record.id === target.id)?.threadId;
    if (!threadId) throw new HeadlessError(`no conversation found for ${target.name ?? target.id}`, EXIT.usage);
  }
  const manifest = await exportJob(client, { ...options, threadId }, ctx.output);
  return {
    result: manifest, exitCode: EXIT.done,
    human: [`Exported to ${manifest.out}: ${manifest.transcripts.length} transcripts, ${manifest.files.length} files, ${manifest.screens.length} screen captures.`,
      ...(manifest.skipped.length ? [`Skipped ${manifest.skipped.length} (see manifest.json).`] : [])],
  };
}
