// Same-room jobs take turns. A requester that sends several members work in
// one room is told they run one at a time and where each one stands, and the
// room itself shows who waits on whom ("Queued · waiting for X (2 of 3)"),
// on an isolated fixture with the real coordination proxy.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { openSse } from "./testing/sse.ts";

it("tells the requester and the room that three same-room jobs run in turn", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { OPENMAUSBOT_URL: session.info.url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  const events = await openSse(`${session.info.url}/api/events`, { Origin: session.info.url });
  try {
    const lead = (await cli("new-bot", "--name", "Lead", "--section", "A")).bot;
    const workers: any[] = [];
    for (const name of ["First", "Second", "Third"]) workers.push((await cli("new-bot", "--name", name, "--section", "A")).bot);
    const room = (await tool("create_channel", { name: "Studio", member_ids: [lead.id, ...workers.map(w => w.id)] })).channel;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const gate = join(session.info.dataDir, "first.gate");
    const ready = join(session.info.dataDir, "first.ready");
    writeFileSync(planPath, JSON.stringify({
      [lead.id]: { steps: [{ arguments: { bot_ids: workers.map(w => w.id), message: "Each of you, cut one part" } }], reply: "Assigned", resumeReply: "All parts reviewed" },
      [workers[0].id]: { reply: "First part cut", gateFile: gate, readyFile: ready },
      [workers[1].id]: { reply: "Second part cut" },
      [workers[2].id]: { reply: "Third part cut" },
    }));
    await cli("send-channel", "--channel", room.id, "--text", "@Lead Split the work");
    await expect.poll(() => existsSync(ready), { timeout: 30_000 }).toBe(true);

    // The requester's receipts: each job's place in the room's line, and a
    // message that says they run in turn, not in parallel.
    const turns = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    await expect.poll(() => existsSync(`${planPath}.evidence.jsonl`) && turns().some((t: any) => t.botId === lead.id), { timeout: 15_000 }).toBe(true);
    const step = turns().find((t: any) => t.botId === lead.id).evidence.find((e: any) => e.step);
    const answer = JSON.parse(step.response.result.content[0].text);
    expect(answer.receipts.map((r: any) => [r.botName, r.queue?.position, r.queue?.of])).toEqual([["First", 1, 3], ["Second", 2, 3], ["Third", 3, 3]]);
    expect(answer.receipts[1].queue.waitingFor).toBe("First");
    expect(answer.receipts[1].detail).toContain("queued 2 of 3 in this room");
    expect(answer.message).toContain("These run one at a time in this room, not in parallel");

    // The room, while the first job runs: the other two wait on it.
    const frame = await events.until(f => f.kind === "group" && f.group?.id === room.id &&
      (f.group.queue ?? []).some((e: any) => e.botId === workers[2].id && e.waitingForBotId === workers[0].id), 15_000);
    expect(frame.group.queue.map((e: any) => [e.botId, e.state, e.position, e.of, e.waitingForBotId ?? null])).toEqual([
      [workers[0].id, "running", 1, 3, null],
      [workers[1].id, "queued", 2, 3, workers[0].id],
      [workers[2].id, "queued", 3, 3, workers[0].id],
    ]);

    writeFileSync(gate, "release");
    expect((await cli("wait", "--channel", room.id, "--timeout", "45")).status).toBe("settled");
    expect(readHandoffs(session.info.dataDir).filter((n: any) => n.parentId).every((n: any) => n.status === "completed")).toBe(true);
    await events.until(f => f.kind === "group" && f.group?.id === room.id && Array.isArray(f.group.queue) && f.group.queue.length === 0, 15_000);
  } finally {
    events.close();
    await session.close();
  }
}, 90_000);
