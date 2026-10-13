// export against a stand-in server that answers the routes it reads: what
// lands in the folder, what is skipped and why, the byte limit counted on
// what is actually written (a proxy may send a body with no length), a
// linked folder's files, and secrets removed from the transcripts.
import "../testing/scrub-ambient-omb-env.ts";

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-export-"));
let server: Server;
let origin: string;

const LEAD = "lead-thread-0001";
const PRIYA = "priya-thread-0002";
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const BIG = Buffer.alloc(3_000, 7);

const messages: Record<string, unknown[]> = {
  [LEAD]: [
    { id: "u1", role: "user", kind: "text", text: `Rehearse it. The key is ${KEY}` },
    { id: "m1", role: "bot", kind: "text", text: "Report: [report](report.md), [raw](big.bin), [shots](shots/), [secret](../../etc/passwd)" },
    { id: "s1", role: "bot", kind: "screen" },
    { id: "s2", role: "bot", kind: "screen" },
  ],
  [PRIYA]: [{ id: "p1", role: "bot", kind: "text", text: "Pricing was hidden.\n\n![step 1](priya-1.png)" }],
};

function answer(req: IncomingMessage, res: ServerResponse, raw: string) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/bots") return send(200, { bots: [{ id: "lead", name: "Room Lead", threadId: LEAD, tasks: [{ threadId: LEAD }] }], groups: [] });
  if (url.pathname === `/api/threads/${LEAD}/job`) {
    return send(200, { threadId: LEAD, state: "completed", reason: "Room Lead finished", since: 0, version: "v1", nodes: [
      { id: "r1", rootId: "r1", botName: "Room Lead", threadId: LEAD, status: "completed", result: "Report" },
      { id: "a1", rootId: "r1", botName: "Priya", threadId: PRIYA, threadTitle: "Visit", status: "completed", result: `Saw ${KEY}` },
    ] });
  }
  const exported = /^\/api\/threads\/([\w-]+)\/export$/.exec(url.pathname);
  if (exported) {
    if (url.searchParams.get("format") === "json") return send(200, { name: "Rehearsal", threadId: exported[1], messages: messages[exported[1]!] ?? [] });
    res.writeHead(200, { "content-type": "text/markdown" });
    return res.end(`# Rehearsal\n\nThe key is ${KEY}\n`);
  }
  const image = /^\/api\/threads\/([\w-]+)\/messages\/(s\d)\/image$/.exec(url.pathname);
  if (image) {
    // s2's pixels are gone: the server no longer keeps them
    if (image[2] === "s2") return send(404, { error: "no image on that message" });
    res.writeHead(200, { "content-type": "image/png", "content-length": "4" });
    return res.end("PNG!");
  }
  const file = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/file$/.exec(url.pathname);
  if (file && req.method === "POST") {
    const body = JSON.parse(raw) as { path: string; entry?: string; listFolder?: boolean };
    if (body.path === "report.md") {
      res.writeHead(200, { "content-type": "text/markdown", "content-length": "15", "content-disposition": "attachment; filename=\"report.md\"" });
      return res.end("# Launch report");
    }
    if (body.path === "priya-1.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": "3" });
      return res.end("png");
    }
    if (body.path === "big.bin") {
      // no content-length: sent in chunks, as a proxy may
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(BIG.subarray(0, 1_500));
      return res.end(BIG.subarray(1_500));
    }
    if (body.path === "shots/" && body.entry) {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.entry.length) });
      return res.end(body.entry);
    }
    if (body.path === "shots/" && body.listFolder) {
      return send(200, { name: "shots", entries: [{ name: "a.png", bytes: 5 }, { name: "b.png", bytes: 5 }], truncated: false }, { "x-openmausbot-folder": "1" });
    }
    return send(403, { error: "that bot message does not link to this file" });
  }
  send(404, { error: "not found" });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    answer(req, res, raw);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  await removeTempDir(dir);
});

const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
  const code = await runHeadless(argv, { io, env: { OPENMAUSBOT_URL: origin } });
  return { code, result: out.length ? JSON.parse(out.join("\n")) : undefined, err };
};

describe("export", () => {
  it("writes the job, every transcript, the linked files and folders and the screens, within the byte limit", async () => {
    const out = join(dir, "first");
    const { code, result } = await run(["export", "--thread", LEAD, "--out", out, "--max-bytes", "2KB", "--json"]);
    expect(code).toBe(0);
    const files = (result.files as Array<{ file: string; link: string; entry?: string; bytes: number }>).map(({ file, link, entry, bytes }) => ({ file, link, entry, bytes }));
    expect(files).toEqual([
      { file: "files/conversation-lead-thr/report.md", link: "report.md", entry: undefined, bytes: 15 },
      { file: "files/conversation-lead-thr/shots/a.png", link: "shots/", entry: "a.png", bytes: 5 },
      { file: "files/conversation-lead-thr/shots/b.png", link: "shots/", entry: "b.png", bytes: 5 },
      { file: "files/priya-visit-priya-th/priya-1.png", link: "priya-1.png", entry: undefined, bytes: 3 },
    ]);
    expect(readFileSync(join(out, "files/conversation-lead-thr/report.md"), "utf8")).toBe("# Launch report");
    // the body with no length header was counted as it streamed, and nothing of it is left behind
    expect(result.skipped).toEqual([
      { threadId: LEAD, messageId: "m1", link: "big.bin", reason: "more than --max-bytes 2000" },
      { threadId: LEAD, messageId: "m1", link: "../../etc/passwd", reason: "that bot message does not link to this file" },
    ]);
    expect(readdirSync(join(out, "files/conversation-lead-thr"))).toEqual(["report.md", "shots"]);
    // one capture kept; the one whose pixels are gone is not a failure
    expect(result.screens).toEqual([{ threadId: LEAD, messageId: "s1", file: "screens/conversation-lead-thr/001-s1.png", bytes: 4 }]);
    expect(result.bytes).toBe(32);
    expect(result.transcripts.map((transcript: { file: string }) => transcript.file)).toEqual([
      "transcripts/conversation-lead-thr.json", "transcripts/priya-visit-priya-th.json"]);
    // secrets are gone from everything written
    for (const file of ["transcripts/conversation-lead-thr.json", "transcripts/conversation-lead-thr.md", "job.json", "manifest.json"]) {
      const text = readFileSync(join(out, file), "utf8");
      expect(text, file).not.toContain(KEY);
    }
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).toMatchObject({ ok: true, threadId: LEAD, state: "completed" });
  });

  it("refuses a folder with files in it before reading anything, and --force replaces an earlier export's files", async () => {
    const out = join(dir, "again");
    expect((await run(["export", "--thread", LEAD, "--out", out, "--json"])).code).toBe(0);
    const refused = await run(["export", "--thread", LEAD, "--out", out, "--json"]);
    expect(refused).toMatchObject({ code: 2, result: { ok: false, error: `${out} already has files in it` } });
    const forced = await run(["export", "--thread", LEAD, "--out", out, "--force", "--json"]);
    expect(forced.code).toBe(0);
    // the same names, not "report (2).md" beside the old copy
    expect(readdirSync(join(out, "files/conversation-lead-thr")).sort()).toEqual(["big.bin", "report.md", "shots"]);
    expect(existsSync(join(out, "files/conversation-lead-thr/report (2).md"))).toBe(false);
  });

  it("keeps one job of the conversation with --root, and says so when there is none", async () => {
    const missing = await run(["export", "--thread", LEAD, "--out", join(dir, "none"), "--root", "nope", "--json"]);
    expect(missing).toMatchObject({ code: 2, result: { error: "no job with root nope in this conversation" } });
  });
});
