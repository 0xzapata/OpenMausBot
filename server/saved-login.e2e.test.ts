// A saved login on the fake engine, end to end through the real agents MCP
// proxy: a bot working in its built-in browser asks the person to sign in,
// the person saves a login from the card instead, the bot resumes and calls
// fill_login, and the server types the username and password into the login
// page itself. The bot hears only what was filled; the password reaches the
// page, never a tool result, an engine command line, the bot's prompt or
// the transcript. The browser here is a happy-dom page behind a stand-in
// agent-browser (server/testing/fake-login-page.ts); nothing reaches a real
// browser, the user's data or port 8799.
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";
import { freePortBlock } from "./testing/ports.ts";

// Obvious fakes only.
const PASSWORD = "fake-E2E-Passw0rd!";
const USERNAME = "alice@example.com";

it.skipIf(process.platform === "win32")("saves a login from the sign-in card, and fill_login signs the bot in without it ever seeing the password", async () => {
  const page = new FakeLoginPage("https://accounts.example.com/login", LOGIN_FORM);
  // The bridge plays the running browser: the stand-in engine forwards each
  // command here, and the engine's input relay (`/api/command`) is here too.
  const port = await freePortBlock([0], 19_960, 40);
  const engineArgs: string[][] = [];
  const bridge = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const reply = (data: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      if (req.url === "/api/command") {
        const command = JSON.parse(raw) as { action?: string; subaction?: string; text?: string };
        if (command.action !== "keyboard" || command.subaction !== "insertText" || typeof command.text !== "string") return reply({ success: false });
        await page.insertText(command.text);
        return reply({ success: true, data: {} });
      }
      const { args } = JSON.parse(raw) as { args: string[] };
      engineArgs.push(args);
      const data = await page.engine(args);
      // The relay answers on this bridge's own port.
      return reply({ success: true, data: data && "port" in data ? { ...data, port } : data });
    } catch (error) {
      return reply({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((ready) => bridge.listen(port, "127.0.0.1", ready));

  const tools = mkdtempSync(join(tmpdir(), "omb-saved-login-e2e-"));
  const binaryPath = join(tools, "agent-browser");
  // The stand-in agent-browser: its browser is always running, `mcp` and
  // `close` do nothing, and every other command goes to the bridge.
  writeFileSync(binaryPath, `#!${process.execPath}
const args = process.argv.slice(2).filter((arg) => arg !== "--json" && arg !== "--no-webmcp");
const say = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] === "session" && args[1] === "list") say({ success: true, data: { sessions: [process.env.AGENT_BROWSER_SESSION] } });
else if (args[0] === "mcp" || args[0] === "close" || args[0] === "set") process.exit(0);
else fetch("http://127.0.0.1:${port}/engine", { method: "POST", body: JSON.stringify({ args }) })
  .then((response) => response.text()).then((text) => { process.stdout.write(text); process.exit(0); }, () => process.exit(1));
`, { mode: 0o755 });

  const fixture = await launchVerificationServer({}, undefined, undefined, { binaryPath, executablePath: join(tools, "chrome") }, undefined, { scripted: true });
  const url = fixture.info.url;
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Signer" })).body.bot;
    // A temporary browser: nothing of the stand-in's is saved or restored.
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "request_sign_in", arguments: { site: "https://accounts.example.com/login", reason: "The invoices are behind a login." } }],
        reply: "I asked you to sign in to accounts.example.com." },
      // A careless bot repeats the password in its reply; the transcript must not keep it.
      { steps: [{ tool: "fill_login", arguments: {} }], reply: `Signed in. The password was ${PASSWORD}.` },
    ] } }));

    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Download this month's invoices.", "--url", url]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    await expect.poll(async () => (await messages()).some((message) => message.kind === "signin"), { timeout: 15_000 }).toBe(true);
    const card = (await messages()).find((message) => message.kind === "signin");

    // The person saves a login on the card.
    const saved = await api("POST", `/api/bots/${bot.id}/sign-in-cards/${card.id}/save-login`, { threadId: bot.threadId, username: USERNAME, password: PASSWORD });
    expect(saved).toMatchObject({ status: 200, body: { done: true, resumed: true, saved: true, host: "accounts.example.com" } });
    expect(saved.text).not.toContain(PASSWORD);

    // The bot resumes, is told its saved logins, and calls fill_login.
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(2);
    const resumed = evidence()[1];
    expect(JSON.stringify(resumed.prompt)).toContain("the person saved a login for accounts.example.com");
    expect(resumed.system).toContain(`Your saved logins, for fill_login on exactly these hosts: accounts.example.com (${USERNAME}).`);
    const call = resumed.evidence.find((entry: any) => entry.step?.tool === "fill_login");
    expect(call.response.result.isError).toBeFalsy();
    expect(call.response.result.content[0].text).toContain(`Filled the username and the password for ${USERNAME} on accounts.example.com. Submit the form now`);

    // The page holds the login, typed as real input.
    expect(page.field("#email").value).toBe(USERNAME);
    expect(page.field("#password").value).toBe(PASSWORD);
    expect(page.state).toMatchObject({ email: USERNAME, password: PASSWORD });

    // And nothing else does.
    await expect.poll(async () => (await messages()).some((message) => message.role === "bot" && String(message.text).startsWith("Signed in.")), { timeout: 15_000 }).toBe(true);
    const reply = (await messages()).find((message) => message.role === "bot" && String(message.text).startsWith("Signed in."));
    expect(reply.text).toBe("Signed in. The password was ••••••.");
    expect(JSON.stringify(evidence())).not.toContain(PASSWORD);
    expect(JSON.stringify(engineArgs)).not.toContain(PASSWORD);
    expect(JSON.stringify(await messages())).not.toContain(PASSWORD);
    expect((await api("GET", "/api/logins")).text).not.toContain(PASSWORD);
    expect(readFileSync(join(fixture.info.dataDir, "logins.json.enc")).includes(Buffer.from(PASSWORD))).toBe(false);
  } finally {
    page.close();
    await fixture.close();
    await new Promise((done) => bridge.close(done));
    await removeTempDir(tools);
  }
}, 120_000);
