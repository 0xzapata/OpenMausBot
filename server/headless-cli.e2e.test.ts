// The headless CLI end to end, as Launch Room and a CI step use it: the real
// `openmausbot` entry (server/openmausbot.ts) as a child process, against an
// isolated fake-engine server whose engine is scripted (room-plan.json).
// A team file makes a Chief and two teammates; a second apply changes
// nothing; `run --wait job` sends the Chief one job, waits until it and both
// teammates are done, and exports it; the export holds the job tree, every
// transcript, the report the Chief wrote and the teammates' screenshots.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const ENTRY = join(import.meta.dirname, "openmausbot.ts");

interface Ran { code: number | null; stdout: string; stderr: string }

let session: VerificationServer;
let dir: string;

function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
      env: { ...process.env, OPENMAUSBOT_TOKEN: "", OMB_PORT: "", OPENMAUSBOT_URL: session.info.url, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`openmausbot ${args.join(" ")} did not finish: ${stderr}`)); }, 90_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const json = (ran: Ran) => JSON.parse(ran.stdout);

beforeAll(async () => {
  // A port range of its own (19975-19999), and a scripted fake engine.
  session = await launchVerificationServer({ ...process.env, OMB_TEST_PORTS: "19975-19999" }, undefined, undefined, undefined, undefined, { scripted: true });
  dir = mkdtempSync(join(tmpdir(), "omb-headless-cli-"));
}, 60_000);

afterAll(async () => {
  await session?.close();
  if (dir) await removeTempDir(dir);
});

describe("openmausbot headless: team apply → run --wait job → export", () => {
  it("rehearses a launch with a Chief and two teammates and exports what they made", async () => {
    for (const folder of ["room", "priya", "marcus"]) mkdirSync(join(dir, "work", folder), { recursive: true });
    mkdirSync(join(dir, "skills", "launch-report"), { recursive: true });
    writeFileSync(join(dir, "skills", "launch-report", "SKILL.md"), "---\nname: launch-report\ndescription: How to write the launch report.\n---\nList what each visitor tried and the fixes that matter.\n");
    const doctor = await cli(["doctor", "--json"]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(json(doctor)).toMatchObject({ ok: true, server: { capabilities: { jobs: true } }, session: { kind: "loopback" } });
    const model = json(await cli(["models", "--json"])).instances.find((instance: any) => instance.instanceId === "claude").models.default;
    const teamFile = join(dir, "launch-room.yaml");
    writeFileSync(teamFile, `version: 1
defaults:
  team: Launch Room
  model: claude/${model}
  approval: full
  computer: "off"
teams:
  - name: Launch Room
    prune: true
    brief: |
      We rehearse a product launch before it happens. Never ask the person anything.
bots:
  - name: Room Lead
    chief: true
    title: Launch rehearsal lead
    cwd: ${join(dir, "work", "room")}
    soul: Hand the site to every visitor, then write report.md and link it.
    skills:
      - file: skills/launch-report/SKILL.md
  - name: Priya
    title: Skeptical procurement manager
    cwd: ${join(dir, "work", "priya")}
    soul: You are Priya, who buys software for a 200-person company.
  - name: Marcus
    title: Rushed founder on a phone-sized screen
    cwd: ${join(dir, "work", "marcus")}
    soul: You are Marcus, who gives a site 30 seconds.
`);

    // apply: created; applied again: nothing to do, and no write sent
    const applied = await cli(["team", "apply", teamFile]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('bot "Room Lead": create (Chief of Launch Room');
    expect(applied.stdout).toContain("Applied: 4 created, 0 changed, 0 deleted.");
    const again = await cli(["team", "apply", teamFile, "--json"]);
    expect(again.code).toBe(0);
    expect(json(again)).toMatchObject({ created: 0, changed: 0, deleted: 0, writes: 0, plan: [] });
    expect((await cli(["team", "apply", teamFile, "--check"])).code).toBe(0);

    const bots = json(await cli(["bots", "--json"])).bots as any[];
    const byName = (name: string) => bots.find((bot) => bot.name === name);
    const [lead, priya, marcus] = ["Room Lead", "Priya", "Marcus"].map(byName);
    expect(lead).toMatchObject({ section: "Launch Room", chiefOfStaff: true, modelSelection: { instanceId: "claude", model } });
    expect([priya, marcus].every((bot) => bot.section === "Launch Room")).toBe(true);

    // The engine, scripted: the Chief hands the site to both visitors, and
    // writes the report once both have reported; each visitor saves a screenshot.
    writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({
      [lead.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [priya.id, marcus.id], message: "Visit https://example.com as yourself and report what stopped you." } }], reply: "Briefed both visitors." },
        { writeFiles: { "report.md": "# Launch report\n\n- Priya could not find pricing.\n- Marcus left after the hero.\n" },
          reply: "Launch report: [report](report.md)" },
      ] },
      [priya.id]: { writeFiles: { "priya-1.png": "fake png bytes" }, reply: "Pricing was hard to find.\n\n![step 1](priya-1.png)" },
      [marcus.id]: { writeFiles: { "marcus-1.png": "fake png bytes" }, reply: "The hero did not say what it does.\n\n![step 1](marcus-1.png)" },
    }));

    const out = join(dir, "export");
    const run = await cli(["run", "Room Lead", "Rehearse the launch of example.com with every visitor.", "--wait", "job", "--timeout", "60s", "--json", "--export", out]);
    expect(run.code, `${run.stderr}\n${run.stdout}`).toBe(0);
    const result = json(run);
    expect(result).toMatchObject({ ok: true, exitCode: 0, status: "settled", state: "completed",
      reply: { text: "Launch report: [report](report.md)", files: ["report.md"] }, export: { ok: true } });
    // the whole tree settled: the Chief's root and both teammates
    const nodes = result.job.nodes as any[];
    expect(nodes.map((node) => [node.botName, node.status])).toEqual([["Room Lead", "completed"], ["Priya", "completed"], ["Marcus", "completed"]]);
    // progress went to stderr as JSON lines, the first naming the thread
    const progress = run.stderr.trim().split("\n").map((line) => JSON.parse(line));
    expect(progress[0]).toMatchObject({ event: "started", threadId: result.threadId });
    expect(progress.some((event) => event.event === "job" && event.state === "running")).toBe(true);

    // the export: manifest, job tree, three transcripts, the report and both screenshots
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ ok: true, threadId: result.threadId, state: "completed", skipped: [] });
    expect(manifest.transcripts).toHaveLength(3);
    const exported = (name: string) => manifest.files.find((file: any) => file.file.endsWith(name));
    expect(readFileSync(join(out, exported("report.md").file), "utf8")).toContain("Priya could not find pricing.");
    expect(readFileSync(join(out, exported("priya-1.png").file), "utf8")).toBe("fake png bytes");
    expect(exported("marcus-1.png")).toBeTruthy();
    const job = JSON.parse(readFileSync(join(out, "job.json"), "utf8"));
    expect(job.nodes.map((node: any) => node.result)).toEqual(["Launch report: [report](report.md)", expect.stringContaining("Pricing was hard to find."),
      expect.stringContaining("The hero did not say what it does.")]);
    const transcripts = readdirSync(join(out, "transcripts"));
    expect(transcripts.filter((name) => name.endsWith(".json"))).toHaveLength(3);
    expect(transcripts.filter((name) => name.endsWith(".md"))).toHaveLength(3);
    const leadTranscript = JSON.parse(readFileSync(join(out, manifest.transcripts[0].file), "utf8"));
    expect(leadTranscript.messages.some((message: any) => message.role === "user" && message.text.includes("Rehearse the launch"))).toBe(true);

    // the export verb on its own: a used folder is refused, --force writes into it
    const refused = await cli(["export", "--thread", result.threadId, "--out", out]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("already has files in it");
    const forced = await cli(["export", "--thread", result.threadId, "--out", out, "--force", "--json"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(json(forced).files.length).toBeGreaterThanOrEqual(3);

    // waiting again on a finished job returns at once, and nothing is running now
    const waited = await cli(["wait", "--thread", result.threadId, "--json"]);
    expect(waited.code).toBe(0);
    expect(json(waited)).toMatchObject({ status: "settled", state: "idle" });
    expect(existsSync(join(dir, "work", "room", "report.md"))).toBe(true);
  }, 180_000);
});
