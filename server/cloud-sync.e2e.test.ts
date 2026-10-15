// Sync with My Cloud end to end: the full server as a Cloud home over its real HTTP boundary, and the desktop's sync
// service driving it, with the owner's pairing token standing in for the desktop window's Cloud cookie. No network.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCloudSyncService } from "../electron/cloud-sync.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const PC_ORIGIN = `https://${HOST}`;
const secret = randomBytes(32).toString("base64url");
let home: string;
let base: string;
let child: ChildProcess;
let log = "";
let ownerToken = "";

async function api(method: string, path: string, options: { body?: unknown; remote?: boolean; headers?: Record<string, string> } = {}) {
  const asOwner = !options.remote && ownerToken !== "";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.remote || asOwner ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } : {}),
      ...(asOwner ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function ownerPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await api("POST", "/api/cloud/pairing", { remote: true, headers: {
    "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body: JSON.parse(body) });
  return (await api("POST", "/api/auth/pair", { remote: true, body: { code: granted.body.code } })).body.token as string;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-sync-e2e-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" }));
  process.exit(0);
}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    },
  }));
  mkdirSync(join(home, "web"));
  writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>OpenMausBot</title>");
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "web"),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`, OMB_SYNC_ROOT: join(home, "Synced"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await api("GET", "/api/health")).body?.pid === child.pid) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ownerToken = await ownerPairing();
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

// The desktop's fetch, but over the test's loopback edge: the owner's pairing token stands in for the window's cookie.
const desktopFetch = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(url.replace(PC_ORIGIN, base), { ...init, headers: { ...init.headers, host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", authorization: `Bearer ${ownerToken}` } });

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
    expect(service.state().phase, JSON.stringify(service.state())).toBe("synced");
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
    expect(entry!.path).toBe("from-a-bot.md");
    await service.restore(entry!.id);
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

it("a desktop's open long poll does not block a backup or a restore on My Cloud", async () => {
  const headers = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", authorization: `Bearer ${ownerToken}` };
  const { cursor } = await (await fetch(`${base}/api/sync/changes?cursor=0&waitMs=0`, { headers })).json() as { cursor: number };
  const poll = fetch(`${base}/api/sync/changes?cursor=${cursor}&waitMs=5000`, { headers }).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 200));
  const backup = await api("POST", "/api/workspace-backup/export", { body: { password: "correct horse battery staple" } });
  expect(backup.status, JSON.stringify(backup.body)).not.toBe(409);
  await poll;
}, 30_000);
