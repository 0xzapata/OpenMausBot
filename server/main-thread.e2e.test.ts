// A bot's main thread is the open thread a person last wrote in
// (server/main-thread.ts). The stamp it reads, askedAt, comes from a
// person's own line only: work that merely lands in a thread (a routine, a
// webhook, a thread the bot opened, a teammate's hand-off, a line relayed
// from Slack) never moves it. Clients get the answer (WireBot.mainThreadId),
// never the stamp. Real server, scripted fake engine.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("stamps askedAt where a person writes, never for a routine, a webhook, start_thread, a teammate's hand-off or a Slack relay", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const wire = async (botId: string) => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId);
  const tasks = async (botId: string) => (await wire(botId)).tasks as any[];
  /** The stamps as the server keeps them, written as each one is made. */
  const stamps = (botId: string) => Object.fromEntries((JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as any[])
    .find((bot) => bot.id === botId).tasks.filter((task: any) => task.askedAt !== undefined).map((task: any) => [task.threadId, task.askedAt]));
  const thread = async (botId: string, title: string) => {
    await expect.poll(async () => (await tasks(botId)).some((task) => task.title === title), { timeout: 20_000 }).toBe(true);
    return (await tasks(botId)).find((task) => task.title === title);
  };
  const idle = (botId: string) => expect.poll(async () => (await tasks(botId)).some((task) => task.busy), { timeout: 20_000 }).toBe(false);
  const said = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[])
    .map((message) => message.peerAsk ? `@${message.peerAsk.name}: ${message.text}` : message.relayed ? `relayed: ${message.text}` : message.text);
  /** The scripted turn ran there, and its bot is free for the next one. */
  const replied = async (botId: string, threadId: string, text: string) => {
    await expect.poll(() => said(threadId), { timeout: 20_000 }).toContain(text);
    await idle(botId);
  };
  const finished = async (find: (run: any) => boolean) => {
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find(find)?.status, { timeout: 20_000 }).toBe("completed");
    return (await api("GET", "/api/routines")).runs.find(find).threadId as string;
  };
  try {
    // One turn at a time per bot, and each step settles before the next, so
    // every turn meets its own scripted entry.
    await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    const { bot } = await cli("new-bot", "--name", "Asker");
    const { bot: teammate } = await cli("new-bot", "--name", "Teammate");
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [bot.id]: { turns: [
        { steps: [{ tool: "start_thread", arguments: { title: "Side job", message: "Check the side job." } }], reply: "Opened a side job." },
        { reply: "Side job checked." },
        { reply: "Relayed line handled." },
        { reply: "Routine report." },
        { reply: "Webhook handled." },
        { reply: "Hand-off done." },
      ] },
      [teammate.id]: { turns: [
        { steps: [{ tool: "send_to_bot", arguments: { bot_id: bot.id, title: "Hand-off", message: "Take this over." } }], reply: "Handed it over." },
      ] },
    }));
    const first = bot.activeTaskId as string;
    await cli("send", "--bot", bot.id, "--task", first, "--text", "Open a side job.");
    const side = await thread(bot.id, "Side job");
    await replied(bot.id, side.threadId, "Side job checked.");
    const asked = stamps(bot.id);
    expect(asked).toEqual({ [first]: expect.any(Number) });
    expect(side.openedBy).toMatchObject({ botId: bot.id });

    // Slack's worker relays a person's line through the guarded route.
    const { task: relayed } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "From Slack" }, 201);
    await api("POST", `/api/bots/${bot.id}/messages/guarded`, {
      threadId: relayed.threadId, sendId: randomUUID(), text: "Sent from Slack.", expectedActiveLeafId: null,
    }, 202);
    await replied(bot.id, relayed.threadId, "Relayed line handled.");
    expect(await said(relayed.threadId)).toContain("relayed: Sent from Slack.");

    const { routine } = await api("POST", "/api/routines", {
      name: "Morning report", prompt: "Report this run's state.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    const routineThread = await finished((candidate) => candidate.id === run.id);
    await replied(bot.id, routineThread, "Routine report.");
    // It reported into the one thread a person wrote in.
    expect(run.resultsThreadId).toBe(first);

    const hook = await api("POST", "/api/webhooks", { name: "Build", prompt: "Handle the build event.", botId: bot.id, runOn: "maus" }, 201);
    const delivered = await fetch(hook.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(delivered.status).toBe(202);
    const webhookThread = await finished((candidate) => candidate.webhookId === hook.webhook.id);
    await replied(bot.id, webhookThread, "Webhook handled.");

    await cli("send", "--bot", teammate.id, "--task", teammate.activeTaskId, "--text", "Hand this to Asker.");
    const handoff = await thread(bot.id, "Hand-off");
    await replied(bot.id, handoff.threadId, "Hand-off done.");
    await idle(teammate.id);
    expect((await said(handoff.threadId)).some((line) => line.startsWith("@Teammate: ") && line.includes("Take this over."))).toBe(true);

    // Nothing since the person's one line stamped anything: not the side
    // job, the Slack thread, the routine's or webhook's run, or the hand-off.
    expect(stamps(bot.id)).toEqual(asked);
    const after = await wire(bot.id);
    expect(after.mainThreadId).toBe(first);
    expect(JSON.stringify(after)).not.toContain("askedAt");
  } finally {
    await fixture.close();
  }
}, 120_000);
