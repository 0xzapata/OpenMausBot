// Learn from group chats: with the switch on, a member bot's room turn feeds
// its memory capture like a 1:1 turn, read under room rules and sourced to
// the room. Off by default. Pinned against the real server because the
// room's eligibility (switch, membership, who can see the room) and the
// turn it reads are assembled in server/index.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";

it("captures a member bot's room turn into its memory, sourced to the room, once Learn from group chats is on", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-room-capture-"));
  const routes = join(scratch, "routes.json");
  const textDump = join(scratch, "text-dump.json");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{ text: "The garden launch moved to Friday", kind: "decision", confidence: 0.9 }]),
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes, FAKE_CLAUDE_TEXT_DUMP: textDump });
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const capturePrompt = () => {
    try {
      // SAFETY: the fake CLI writes exactly this shape; a missing or partial file reads as no capture yet
      return (JSON.parse(readFileSync(textDump, "utf8")) as { prompt?: string }).prompt ?? "";
    } catch {
      return "";
    }
  };
  try {
    const { bot: lead } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Lead" });
    const { bot: helper } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Helper" });
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    expect((await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config")).features?.roomMemoryCapture).toBe(false);
    const config = await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config", "PATCH", { features: { roomMemoryCapture: true } });
    expect(config.features?.roomMemoryCapture).toBe(true);

    const { group } = await api<{ group: { id: string } }>("/api/groups", "POST", {
      name: "Garden room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    await api(`/api/groups/${group.id}/messages`, "POST", { text: "Lead, the garden launch moved to Friday." });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });

    await expect.poll(async () => (await api<{ text: string }>(`/api/bots/${lead.id}/memory/file?path=MEMORY.md`)).text, { timeout: 30_000 })
      .toMatch(/- \d{4}-\d{2}-\d{2} · from room "Garden room" \(noticed\) · The garden launch moved to Friday/);
    const prompt = capturePrompt();
    expect(prompt).toContain("Person: Lead, the garden launch moved to Friday.");
    expect(prompt).toContain('This is a group chat ("room") Lead is a member of.');
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
