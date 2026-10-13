// engine set / engine list against a stand-in API: a key is written once and
// never printed, a second run changes nothing, --rotate replaces it, an
// engine's command is installed only when it is not already running, and
// the list shows which keys are set, never their values.
import "../testing/scrub-ambient-omb-env.ts";

import { describe, expect, it, vi } from "vitest";

import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

type Rec = Record<string, any>;
const KEY = "sk-ant-api03-test-0123456789abcdefghijklmnop";

function workspace(seed: { configured?: Record<string, boolean>; available?: string[] } = {}) {
  const config: Rec = {
    anthropic: { configured: Boolean(seed.configured?.anthropic), everyClaudeBot: true },
    openai: { configured: false }, openaiCompat: { configured: false, url: "" }, mistral: { configured: false },
  };
  const writes: Array<{ path: string; body?: Rec }> = [];
  const instances = () => ["claude", "claudeApi", "openai", "openaiCompat", "mistral"].map((instanceId) => ({
    instanceId, driverKind: instanceId.startsWith("claude") ? "claudeAgent" : "openai-compat",
    snapshot: { state: seed.available?.includes(instanceId) ? "available" : "unavailable" },
  }));
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if ((init.method ?? "GET") !== "GET") writes.push({ path, ...(body ? { body } : {}) });
    if (path === "/api/config" && init.method === "PUT") {
      for (const [name, value] of Object.entries(body as Rec)) {
        config[name] = { ...config[name], ...(value.key ? { configured: true } : {}), ...(value.everyClaudeBot !== undefined ? { everyClaudeBot: value.everyClaudeBot } : {}),
          ...(value.url !== undefined && name === "openaiCompat" ? { url: value.url } : {}) };
      }
      return { ok: true };
    }
    if (path === "/api/config") return config;
    if (path === "/api/instances") return { instances: instances() };
    if (/^\/api\/instances\/\w+\/install$/.test(path)) return { ok: true, installed: true };
    throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
  });
  const callTool = vi.fn(async (name: string) => {
    if (name === "list_available_models") return { instances: instances() };
    throw new Error(`unexpected tool ${name}`);
  });
  const run = async (argv: string[], env: Rec = { ANTHROPIC_API_KEY: KEY }) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
    const code = await runHeadless(argv, { io, env: { OPENMAUSBOT_URL: "http://127.0.0.1:19997", ...env }, request: request as any, callTool: callTool as any });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { config, writes, run };
}

describe("engine set", () => {
  it("writes a key once, never prints it, and leaves it alone on the next run unless --rotate", async () => {
    const w = workspace();
    const first = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--json"]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ ok: true, kind: "claude", instanceId: "claude", configured: true, changed: ["key"] });
    expect(w.writes).toEqual([{ path: "/api/config", body: { anthropic: { key: KEY, everyClaudeBot: true } } }]);
    expect(first.out + first.err).not.toContain(KEY);

    w.writes.length = 0;
    const again = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY"]);
    expect(again.out).toBe("claude was already set up; nothing changed (pass --rotate to replace its key). Bots use it as claude/MODEL (openmausbot models).");
    expect(w.writes).toEqual([]);
    expect((await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--rotate", "--json"])).code).toBe(0);
    expect(w.writes).toEqual([{ path: "/api/config", body: { anthropic: { key: KEY, everyClaudeBot: true } } }]);
  });

  it("installs an engine's command only when the engine is not running already", async () => {
    const ready = workspace({ configured: { anthropic: true }, available: ["claude"] });
    const kept = await ready.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--install", "--json"]);
    expect(JSON.parse(kept.out)).toMatchObject({ installed: "already", changed: [] });
    expect(ready.writes).toEqual([]);
    const missing = workspace({ configured: { anthropic: true } });
    const installed = await missing.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--install"]);
    expect(installed.out).toContain("Installed its command.");
    expect(missing.writes).toEqual([{ path: "/api/instances/claude/install", body: {} }]);
  });

  it("keeps a Claude key to Claude (API key) bots with --only-claude-api, and takes a base URL where the engine has one", async () => {
    const w = workspace();
    const only = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--only-claude-api", "--base-url", "https://gw.example.com", "--json"]);
    expect(JSON.parse(only.out)).toMatchObject({ instanceId: "claudeApi", changed: ["key", "baseUrl", "everyClaudeBot"] });
    expect(w.writes[0]).toEqual({ path: "/api/config", body: { anthropic: { key: KEY, url: "https://gw.example.com", everyClaudeBot: false } } });
    const compat = await w.run(["engine", "set", "openai-compatible", "--key-env", "ANTHROPIC_API_KEY", "--json"]);
    expect(JSON.parse(compat.out)).toMatchObject({ ok: false, exitCode: 2, error: "openai-compatible needs --base-url" });
    const mistral = await w.run(["engine", "set", "mistral", "--key-env", "ANTHROPIC_API_KEY", "--base-url", "https://x.example", "--json"]);
    expect(JSON.parse(mistral.out)).toMatchObject({ exitCode: 2, error: "mistral takes no base URL" });
  });

  it("refuses a key it cannot read, and a dry run writes nothing", async () => {
    const w = workspace();
    const unset = await w.run(["engine", "set", "claude", "--key-env", "NOT_SET", "--json"], {});
    expect(JSON.parse(unset.out)).toMatchObject({ exitCode: 2, error: "the claude key: the environment variable NOT_SET is not set" });
    const both = await w.run(["engine", "set", "claude", "--key-env", "A", "--key-file", "B", "--json"]);
    expect(JSON.parse(both.out)).toMatchObject({ exitCode: 2, error: "give the key one way: --key-env VAR or --key-file FILE" });
    const dry = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--dry-run", "--json"]);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, changed: ["key"] });
    expect(w.writes).toEqual([]);
  });
});

describe("engine list", () => {
  it("shows each engine and which keys are set, never their values", async () => {
    const w = workspace({ configured: { anthropic: true }, available: ["claude"] });
    const listed = await w.run(["engine", "list", "--json"]);
    expect(JSON.parse(listed.out).keys).toEqual({ claude: true, openai: false, openrouter: false, "openai-compatible": false, xai: false, groq: false, mistral: false, cerebras: false });
    const human = await w.run(["engine", "list"]);
    expect(human.out).toContain("claude · claudeAgent · available");
    expect(human.out).toContain("Keys set: claude");
  });
});
