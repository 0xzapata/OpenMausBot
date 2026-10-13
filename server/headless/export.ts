// export: one conversation's job, written to a folder a person or a CI step
// can keep. Everything is read through the routes the app itself uses, each
// under its own grant: the job tree (GET /api/threads/:id/job), every
// transcript of the job (the transcript export), the files its bots' replies
// link to (the message-scoped file route: a reply is the grant), and screen
// captures the server kept. Bounded by file count, screen count and bytes;
// transcripts and the job tree pass through secret redaction.
//
//   DIR/manifest.json   what was written, and what was skipped and why
//   DIR/job.json        the job tree: every assignment, its status and result
//   DIR/transcripts/    each conversation of the job, .json and .md
//   DIR/files/          files the replies link to, per conversation
//   DIR/screens/        screen captures, per conversation
import { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { redactSecretsInText } from "../../shared/redact.ts";
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
  /** Write into a folder that already has files in it. */
  force?: boolean;
}

const TRANSCRIPT_MESSAGES = 2_000;
const MESSAGE_TEXT_MAX = 50_000;
const MARKDOWN_MAX = 5_000_000;
const enc = encodeURIComponent;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "conversation";

/** A file name from the server's content-disposition, else the link's own, made safe to write. */
function fileName(disposition: string | null, link: string): string {
  const star = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="([^"]+)"/i)?.[1];
  let name = "";
  try { name = star ? decodeURIComponent(star) : plain ?? decodeURIComponent(basename(link.split(/[?#]/)[0]!)); } catch { name = plain ?? ""; }
  // eslint-disable-next-line no-control-regex
  name = basename(name.replace(/[\\/]/g, "_")).replace(/[\x00-\x1f<>:"|?*]/g, "_").trim();
  return !name || name === "." || name === ".." ? "file" : name.slice(0, 120);
}

/** A name not yet used in a folder: report.md, report (2).md, … */
function unused(dir: string, name: string, taken: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; taken.has(join(dir, candidate)) || existsSync(join(dir, candidate)); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(join(dir, candidate));
  return candidate;
}

export async function exportJob(client: HeadlessClient, options: ExportOptions, output: Output): Promise<Rec> {
  const out = resolve(options.out);
  if (existsSync(out) && readdirSync(out).length && !options.force) {
    throw usageError(`${out} already has files in it`, "choose an empty folder, or pass --force to write into it");
  }
  const maxFiles = options.maxFiles ?? 200;
  const maxScreens = options.maxScreens ?? 100;
  const maxBytes = options.maxBytes ?? 500_000_000;
  const job = await readJob(client, options.threadId, { since: String(options.since ?? 0), full: "1" });
  const nodes: Rec[] = (job.nodes ?? []).filter((node: Rec) => !options.root || node.rootId === options.root);
  if (options.root && !nodes.length) throw usageError(`no job with root ${options.root} in this conversation`, "openmausbot export TARGET without --root writes all of it");
  for (const dir of ["transcripts", "files", "screens"]) mkdirSync(join(out, dir), { recursive: true });

  const threads = new Map<string, string>([[options.threadId, "conversation"]]);
  for (const node of nodes) {
    if (!threads.has(node.threadId)) threads.set(node.threadId, `${node.botName}${node.threadTitle ? `-${node.threadTitle}` : ""}`);
  }
  const transcripts: Rec[] = [];
  const files: Rec[] = [];
  const screens: Rec[] = [];
  const skipped: Rec[] = [];
  const taken = new Set<string>();
  let bytes = 0;
  const save = async (response: Response, dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, unused(dir, name, taken));
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(file, { mode: 0o600 }));
    return file;
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
    writeFileSync(join(out, "transcripts", `${name}.json`), `${JSON.stringify(redactDeep({ name: transcript.name, threadId, label,
      ...(all.length > kept.length ? { truncated: all.length - kept.length } : {}), messages: kept }), null, 2)}\n`, { mode: 0o600 });
    const markdown = await client.raw(`/api/threads/${enc(threadId)}/export?format=markdown`).then((response) => response.ok ? response.text() : "").catch(() => "");
    if (markdown) writeFileSync(join(out, "transcripts", `${name}.md`), redactSecretsInText(markdown.slice(0, MARKDOWN_MAX)), { mode: 0o600 });
    transcripts.push({ threadId, label, file: `transcripts/${name}.json`, messages: kept.length, ...(all.length > kept.length ? { truncated: all.length - kept.length } : {}) });

    // the files its replies link to or attach, each under that reply's grant
    const seen = new Set<string>();
    for (const message of kept) {
      if (message.role !== "bot" || message.kind !== "text") continue;
      const links = [...messageFileTargets(String(message.text ?? "")), ...(message.attachments ?? []).map((attachment: Rec) => String(attachment.path))];
      for (const link of links) {
        if (seen.has(link)) continue;
        seen.add(link);
        if (files.length >= maxFiles) { skipped.push({ threadId, messageId: message.id, link, reason: `more than --max-files ${maxFiles}` }); continue; }
        const response = await client.raw(`/api/threads/${enc(threadId)}/messages/${enc(message.id)}/file`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: link }),
        }).catch(() => null);
        if (!response?.ok) {
          const why = response ? String(((await response.json().catch(() => ({}))) as Rec).error ?? response.status) : "not reachable";
          skipped.push({ threadId, messageId: message.id, link, reason: why });
          continue;
        }
        const size = Number(response.headers.get("content-length") ?? 0);
        if (bytes + size > maxBytes) { await response.body?.cancel(); skipped.push({ threadId, messageId: message.id, link, reason: `more than --max-bytes ${maxBytes}` }); continue; }
        const file = await save(response, join(out, "files", name), fileName(response.headers.get("content-disposition"), link));
        bytes += size;
        files.push({ threadId, messageId: message.id, link, file: file.slice(out.length + 1), bytes: size });
      }
    }

    // screen captures the server kept (their pixels are never in the transcript)
    for (const message of kept) {
      if (message.kind !== "screen") continue;
      if (screens.length >= maxScreens) { skipped.push({ threadId, messageId: message.id, reason: `more than --max-screens ${maxScreens}` }); continue; }
      const response = await client.raw(`/api/threads/${enc(threadId)}/messages/${enc(message.id)}/image`).catch(() => null);
      if (!response?.ok) { await response?.body?.cancel(); continue; }
      const size = Number(response.headers.get("content-length") ?? 0);
      if (bytes + size > maxBytes) { await response.body?.cancel(); skipped.push({ threadId, messageId: message.id, reason: `more than --max-bytes ${maxBytes}` }); continue; }
      const type = response.headers.get("content-type") ?? "image/png";
      const ext = type.includes("jpeg") ? ".jpg" : type.includes("webp") ? ".webp" : ".png";
      const file = await save(response, join(out, "screens", name), `${String(screens.length + 1).padStart(3, "0")}-${message.id}${ext}`);
      bytes += size;
      screens.push({ threadId, messageId: message.id, file: file.slice(out.length + 1), bytes: size });
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
