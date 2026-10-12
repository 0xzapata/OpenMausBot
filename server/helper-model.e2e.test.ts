// The helper model through the real server (server/side-jobs.ts). A bot on
// an engine with no one-off text call, the fake Pi, gets memory capture, the
// skill review and a written compaction summary from the helper instance
// (the fake Claude's one-shot mode, with the model the setting names), each
// booked as a helper call for that bot. A Codex bot keeps its own background
// call for memory upkeep and gets only the summary from the helper; a Claude
// bot keeps writing everything with its own engine and quick model. A second
// server without the setting shows the Pi bot keeping today's fallbacks.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPTURE_MARKER } from "./memory-capture.ts";
import { SKILL_REVIEW_MARKER } from "./skill-review.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const FAKES = ["fake-claude-cli.ts", "fake-codex-app-server.ts", "fake-pi-cli.ts"];
const posixOnly = describe.skipIf(process.platform === "win32");

const SUMMARY_MARKER = "Summarize this conversation history in third person";
const SUMMARY = "The person said they are vegetarian and asked for nothing else.";
const SKILL_MD = "---\nname: weekly-report\ndescription: Writes the weekly status report.\n---\n\n# Weekly report\n\nWrites the weekly status report from the project notes.\n\n## When to Use\n- \"write the weekly report\"\n\n## Procedure\n1. Read the notes.\n2. Keep it to five bullets.\n\n## Pitfalls\n- Long reports go unread: stop at five bullets.\n\n## Verification\n- Count the bullets.\n";

interface Msg {
  role: string;
  kind: string;
  text?: string;
  compaction?: { summary: string };
  card?: { title?: string; answered?: string; skillRequest?: { name: string } };
}
interface Row {
  botId: string;
  threadId: string;
  instanceId: string;
  driverKind: string;
  model: string;
  trigger: { kind: string; botId?: string; job?: string };
}

/** One isolated server in a throwaway home, with the fake engines and
 * whatever else the test puts in config.json. */
async function boot(extraConfig: Record<string, unknown>) {
  for (const name of FAKES) chmodSync(fake(name), 0o755);
  const port = 18800 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "omb-helper-model-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  const routes = join(home, "one-shot-routes.json");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{ text: "The person is vegetarian", kind: "preference", aboutUser: true, confidence: 0.9 }]),
    [SUMMARY_MARKER]: SUMMARY,
    [SKILL_REVIEW_MARKER]: JSON.stringify({ changes: [{ action: "create", skill_md: SKILL_MD, gist: "Five-bullet weekly report." }] }),
  }));
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
    instances: {
      claude: { driver: "claudeAgent", config: { cli: fake("fake-claude-cli.ts"), permissionMode: "bypassPermissions" } },
      codex: { driver: "codex", config: { cli: fake("fake-codex-app-server.ts") } },
      pi: { driver: "piAgent", environment: { FAKE_PI_MODE: "tooluse" }, config: { cli: fake("fake-pi-cli.ts"), fullAuto: true } },
    },
    memory: { captureQuietMs: 1_000 },
    ...extraConfig,
  }));
  let stderr = "";
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port), FAKE_CLAUDE_TEXT_ROUTES: routes };
  if (process.env.PATH) env.PATH = process.env.PATH;
  const child: ChildProcess = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  let stdout = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // Generous on purpose: every wait ends the moment its condition holds, and
  // a busy machine starts each fake CLI slowly.
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const close = async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  };
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, "the server to come up");
  } catch (error) {
    // a server that never answered is still this test's to stop
    await close();
    throw error;
  }

  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === id) as { busy: boolean; messages: Msg[] };
  const newBot = async (instanceId: string) => {
    const created = (await api("POST", "/api/bots")).body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model: "fake-model" } })).status).toBe(200);
    return created;
  };
  /** One turn, sent and settled with its reply. */
  const turn = async (bot: { id: string }, text: string) => {
    const before = (await getBot(bot.id)).messages.filter((message) => message.role === "bot" && message.kind === "text").length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => {
      const current = await getBot(bot.id);
      return !current.busy && current.messages.filter((message) => message.role === "bot" && message.kind === "text").length > before;
    }, `a turn of ${bot.id} to settle`);
  };
  const ledger = (botId: string): Row[] => {
    const file = join(home, ".openmausbot", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row).filter((row) => row.botId === botId);
  };
  const memory = async (botId: string) => ((await api("GET", `/api/bots/${botId}/memory/file?path=MEMORY.md`)).body?.text ?? "") as string;
  return { api, waitFor, getBot, newBot, turn, ledger, memory, close, log: () => stdout };
}

posixOnly("the helper model, through the real server", () => {
  let server: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    server = await boot({
      helper: { instanceId: "claude", model: "claude-haiku-5-5" },
      features: { skillReview: true, skillReviewSteps: 3 },
    });
  }, 90_000);
  afterAll(async () => { await server?.close(); });

  const helperRow = (job: string) => expect.objectContaining({
    instanceId: "claude", driverKind: "claudeAgent", model: "claude-haiku-5-5", threadId: expect.stringMatching(new RegExp(`^${job}-`)),
    trigger: expect.objectContaining({ kind: "helper", job }),
  });
  const compacted = async (bot: { id: string; threadId: string }) => {
    expect((await server.api("POST", `/api/bots/${bot.id}/compact`, { threadId: bot.threadId })).status).toBe(202);
    await server.waitFor(async () => {
      const current = await server.getBot(bot.id);
      return !current.busy && current.messages.some((message) => message.kind === "compaction");
    }, "the compaction record");
    return (await server.getBot(bot.id)).messages.find((message) => message.kind === "compaction")!.compaction!.summary;
  };

  it("gives a Pi bot memory capture, the skill review and a written summary from the helper, each booked as a helper call", async () => {
    const { api, waitFor, getBot, newBot, turn, ledger, memory } = server;
    const bot = await newBot("pi");
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: true });
    // one tool step a turn: three reach the review threshold
    for (const text of ["Just so you know, I'm vegetarian.", "Write the weekly report from the notes.", "Shorter please, five bullets at most."]) await turn(bot, text);

    await waitFor(async () => (await memory(bot.id)).includes("The person is vegetarian"), "the helper to capture the fact");
    await waitFor(() => ledger(bot.id).some((row) => row.trigger.job === "memory"), "the capture call to be booked");
    expect(ledger(bot.id)).toContainEqual(helperRow("memory"));
    // the turns themselves stay the Pi engine's, booked to whoever asked
    expect(ledger(bot.id)).toContainEqual(expect.objectContaining({ driverKind: "piAgent", threadId: bot.threadId, trigger: { kind: "owner" } }));

    await waitFor(async () => (await getBot(bot.id)).messages.some((message) => message.card?.skillRequest?.name === "weekly-report"), "the skill receipt");
    expect((await getBot(bot.id)).messages.find((message) => message.card?.skillRequest)!.card).toMatchObject({ answered: "allow", title: 'Skill "weekly-report" enabled' });
    await waitFor(() => ledger(bot.id).some((row) => row.trigger.job === "skill-review"), "the review call to be booked");
    expect(ledger(bot.id)).toContainEqual(helperRow("skill-review"));

    expect(await compacted(bot)).toContain(`Model-written historical summary (may be incomplete):\n${SUMMARY}`);
    await waitFor(() => ledger(bot.id).some((row) => row.trigger.job === "compaction"), "the summary call to be booked");
    expect(ledger(bot.id)).toContainEqual(helperRow("compaction"));

    // read on its own in the usage summary, apart from the person's turns
    const byPerson = (await api("GET", "/api/usage?groupBy=user")).body.groups as Array<{ key: string; label: string }>;
    expect(byPerson.find((group) => group.key === "helper")).toMatchObject({ label: "Helper model" });
    expect(server.log()).toContain('helper model: small writing jobs for bots whose engine has no one-off text call are written by "claude" (claude-haiku-5-5)');
  }, 300_000);

  it("writes a Codex bot's summary with the helper, while its memory upkeep stays on Codex's own background call", async () => {
    const { api, waitFor, newBot, turn, ledger } = server;
    const bot = await newBot("codex");
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: true });
    await turn(bot, "Just so you know, I'm vegetarian.");
    await waitFor(() => ledger(bot.id).some((row) => row.threadId.startsWith("memory-")), "Codex's own capture call to be booked");
    expect(ledger(bot.id).filter((row) => row.threadId.startsWith("memory-")).every((row) => row.driverKind === "codex" && row.trigger.kind === "bot")).toBe(true);

    expect(await compacted(bot)).toContain(`Model-written historical summary (may be incomplete):\n${SUMMARY}`);
    await waitFor(() => ledger(bot.id).some((row) => row.trigger.job === "compaction"), "the summary call to be booked");
    expect(ledger(bot.id)).toContainEqual(helperRow("compaction"));
    expect(ledger(bot.id).filter((row) => row.trigger.kind === "helper").map((row) => row.trigger.job)).toEqual(["compaction"]);
  }, 240_000);

  it("leaves a Claude bot writing with its own engine and its own quick model", async () => {
    const { waitFor, newBot, turn, ledger, memory } = server;
    const bot = await newBot("claude");
    await turn(bot, "Just so you know, I'm vegetarian.");
    await waitFor(async () => (await memory(bot.id)).includes("The person is vegetarian"), "the bot's own capture");
    await waitFor(() => ledger(bot.id).some((row) => row.threadId.startsWith("memory-")), "the capture call to be booked");
    const background = ledger(bot.id).filter((row) => row.threadId.startsWith("memory-"));
    expect(background.every((row) => row.trigger.kind === "bot" && row.model === "claude-haiku-4-5")).toBe(true);
    expect(ledger(bot.id).some((row) => row.trigger.kind === "helper")).toBe(false);
  }, 180_000);
});

posixOnly("without a helper model, through the real server", () => {
  let server: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { server = await boot({}); }, 90_000);
  afterAll(async () => { await server?.close(); });

  it("keeps a Pi bot's fallbacks: no model steps for upkeep, and an excerpt summary", async () => {
    const { api, waitFor, getBot, newBot, turn, ledger } = server;
    const bot = await newBot("pi");
    expect((await api("GET", `/api/bots/${bot.id}/memory/upkeep`)).body).toMatchObject({ enabled: true, modelSteps: false });
    await turn(bot, "Just so you know, I'm vegetarian.");
    expect((await api("POST", `/api/bots/${bot.id}/compact`, { threadId: bot.threadId })).status).toBe(202);
    await waitFor(async () => {
      const current = await getBot(bot.id);
      return !current.busy && current.messages.some((message) => message.kind === "compaction");
    }, "the compaction record");
    const record = (await getBot(bot.id)).messages.find((message) => message.kind === "compaction")!;
    expect(record.compaction!.summary).toMatch(/^Historical excerpts in chronological order/);
    expect(record.compaction!.summary).not.toContain("Model-written");
    expect(ledger(bot.id).some((row) => row.trigger.kind === "helper")).toBe(false);
    expect(server.log()).not.toContain("helper model:");
  }, 180_000);
});
