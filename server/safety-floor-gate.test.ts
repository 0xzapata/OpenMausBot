// The floor's enforcement, fed fake permission requests and a fake adapter.
// No command in this file is ever run: the adapter only records the answer
// it was given.
import { homedir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs, loadConfig, parseConfigPatch, parseStoredConfig, safetyFloorEnabled, saveConfig, type AppConfig } from "./config.ts";
import type { RequestOutcome } from "./contracts.ts";
import { flushDecisionLog, readDecisions } from "./decision-log.ts";
import { bindSafetyFloor, denyAtSafetyFloor, floorBlockForToolCall, safetyFloorBlock, safetyFloorOn, shellCommandOfToolCall } from "./safety-floor-gate.ts";

const ON: AppConfig = { safetyFloor: { enabled: true } };
// A shell that already exports the switch must not turn the floor on here.
beforeEach(() => { delete process.env.OMB_SAFETY_FLOOR; });
afterEach(() => bindSafetyFloor(() => ({})));

type Decision = { behavior: "allow" | "deny" | "answer"; message?: string };

/** A provider adapter that runs nothing: it records each answer it is given
 * and each turn it is told to stop. */
function fakeAdapter(respond: (decision: Decision) => RequestOutcome | Promise<RequestOutcome> = () => "rejected") {
  const answers: Array<{ threadId: string; requestId: string; decision: Decision }> = [];
  const interrupted: Array<{ threadId: string; turnId?: string }> = [];
  return {
    answers,
    interrupted,
    respondToRequest: async (threadId: string, requestId: string, decision: Decision) => {
      answers.push({ threadId, requestId, decision });
      return respond(decision);
    },
    interruptTurn: async (threadId: string, turnId?: string) => {
      interrupted.push({ threadId, turnId });
    },
  };
}

/** One fake permission request, as a driver would raise it for a shell command. */
function request(command: string | undefined, overrides: { adapter?: ReturnType<typeof fakeAdapter>; isCurrent?: () => boolean } = {}) {
  const adapter = overrides.adapter ?? fakeAdapter();
  const said: unknown[] = [];
  let released!: () => void;
  const settled = new Promise<void>((resolve) => { released = resolve; });
  const threadId = `thread-${Math.random().toString(36).slice(2)}`;
  const blocked = denyAtSafetyFloor({
    event: { threadId, turnId: "turn-1", tool: "Bash", summary: command ?? "mcp tool", ...(command === undefined ? {} : { command: { command, cwd: "/work" } }) },
    requestId: "request-1",
    bot: { id: "bot-1", name: "Ada" },
    adapter,
    isCurrent: overrides.isCurrent ?? (() => true),
    say: (message) => said.push(message),
    release: () => released(),
  });
  const rows = async () => {
    await flushDecisionLog(DATA_DIR);
    return readDecisions(DATA_DIR, 200).filter((row) => row.threadId === threadId);
  };
  return { blocked, adapter, said, settled, threadId, rows };
}

describe("the safetyFloor setting", () => {
  it("is off until switched on, in config.json or with OMB_SAFETY_FLOOR=1", () => {
    expect(safetyFloorEnabled({}, {})).toBe(false);
    expect(safetyFloorEnabled({ safetyFloor: {} }, {})).toBe(false);
    expect(safetyFloorEnabled({ safetyFloor: { enabled: false } }, {})).toBe(false);
    expect(safetyFloorEnabled({ safetyFloor: { enabled: true } }, {})).toBe(true);
    // the environment switches it on over the file, and nothing else it says counts
    expect(safetyFloorEnabled({}, { OMB_SAFETY_FLOOR: "1" })).toBe(true);
    expect(safetyFloorEnabled({ safetyFloor: { enabled: false } }, { OMB_SAFETY_FLOOR: " 1 " })).toBe(true);
    for (const value of ["", "0", "true", "yes", "on"]) {
      expect(safetyFloorEnabled({}, { OMB_SAFETY_FLOOR: value }), value).toBe(false);
      expect(safetyFloorEnabled(ON, { OMB_SAFETY_FLOOR: value }), value).toBe(true);
    }
  });

  it("is a typed config key that a settings save keeps", () => {
    expect(parseStoredConfig({}).safetyFloor).toBeUndefined();
    expect(parseStoredConfig({ safetyFloor: { enabled: true } })).toEqual({ safetyFloor: { enabled: true } });
    expect(parseConfigPatch({ safetyFloor: { enabled: true } })).toEqual({ safetyFloor: { enabled: true } });
    expect(() => parseConfigPatch({ safetyFloor: { enabled: "yes" } })).toThrow("safetyFloor.enabled");
    expect(() => parseConfigPatch({ safetyFloor: { enabled: true, rules: ["rm"] } })).toThrow("safetyFloor");
    ensureDirs();
    saveConfig({ safetyFloor: { enabled: true } });
    expect(loadConfig().safetyFloor).toEqual({ enabled: true });
    saveConfig({ safetyFloor: { enabled: false } });
    expect(loadConfig().safetyFloor).toEqual({ enabled: false });
  });
});

describe("safetyFloorBlock", () => {
  it("says nothing while the floor is off", () => {
    expect(safetyFloorBlock("rm -rf /")).toBeNull();
    bindSafetyFloor(() => ({ safetyFloor: { enabled: false } }));
    expect(safetyFloorBlock("rm -rf /")).toBeNull();
  });

  it("names the block for the person and for the engine once the floor is on", () => {
    bindSafetyFloor(() => ON);
    expect(safetyFloorBlock("sudo rm -rf /")).toEqual({
      rule: "delete-root",
      label: "recursive delete of the filesystem root",
      line: "Blocked by the safety floor: recursive delete of the filesystem root",
      reason: expect.stringContaining("Blocked by the safety floor: recursive delete of the filesystem root."),
    });
    expect(safetyFloorBlock("rm -rf ./build")).toBeNull();
    expect(safetyFloorBlock(undefined)).toBeNull();
    expect(safetyFloorBlock("")).toBeNull();
  });

  it("reads the setting each time, so a settings save applies to the next request", () => {
    let config: AppConfig = {};
    bindSafetyFloor(() => config);
    expect(safetyFloorOn()).toBe(false);
    expect(safetyFloorBlock("rm -rf ~")).toBeNull();
    config = ON;
    expect(safetyFloorOn()).toBe(true);
    expect(safetyFloorBlock("rm -rf ~")?.rule).toBe("delete-home");
  });

  it("is switched on by OMB_SAFETY_FLOOR=1 alone, whatever the saved config says", () => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: false } }));
    process.env.OMB_SAFETY_FLOOR = "1";
    try {
      expect(safetyFloorOn()).toBe(true);
      expect(safetyFloorBlock("rm -rf /")?.rule).toBe("delete-root");
    } finally {
      delete process.env.OMB_SAFETY_FLOOR;
    }
    expect(safetyFloorOn()).toBe(false);
  });

  it("knows this machine's home directory by its own path", () => {
    bindSafetyFloor(() => ON);
    expect(safetyFloorBlock(`rm -rf "${homedir()}"`)?.rule).toBe("delete-home");
    expect(safetyFloorBlock(`rm -rf "${homedir()}/project/dist"`)).toBeNull();
  });
});

describe("denyAtSafetyFloor", () => {
  it("leaves every request alone while the floor is off", async () => {
    const off = request("rm -rf /");
    expect(off.blocked).toBe(false);
    expect(off.adapter.answers).toEqual([]);
    expect(off.said).toEqual([]);
    expect(await off.rows()).toEqual([]);
  });

  it("denies a never-list command instead of allowing it, says so once, and logs the decision", async () => {
    bindSafetyFloor(() => ON);
    const floored = request("TOKEN=sk-live-1234567890abcdef rm -rf /");
    expect(floored.blocked).toBe(true);
    await floored.settled;
    // the engine got one answer, and it was a deny with the reason
    expect(floored.adapter.answers).toEqual([{
      threadId: floored.threadId,
      requestId: "request-1",
      decision: { behavior: "deny", message: expect.stringContaining("Blocked by the safety floor: recursive delete of the filesystem root.") },
    }]);
    expect(floored.adapter.interrupted).toEqual([]);
    // one status row the person always sees, whatever the Tool calls setting
    expect(floored.said).toEqual([{
      role: "bot",
      kind: "activity",
      tool: { name: "notice: Blocked by the safety floor: recursive delete of the filesystem root", ok: false },
    }]);
    expect(await floored.rows()).toEqual([expect.objectContaining({
      threadId: floored.threadId,
      requestId: "request-1",
      botId: "bot-1",
      botName: "Ada",
      tool: "Bash",
      decision: "auto-denied",
      source: "safety-floor",
      rule: "delete-root",
    })]);
    // neither line carries the command, so a credential typed into it stays out
    expect(JSON.stringify([floored.said, floored.adapter.answers])).not.toContain("sk-live");
  });

  it("lets everything else through to the grant that was about to answer", async () => {
    bindSafetyFloor(() => ON);
    for (const command of ["rm -rf ./build", "git commit -m 'rm -rf /'", "npm test", undefined]) {
      const ordinary = request(command);
      expect(ordinary.blocked, String(command)).toBe(false);
      expect(ordinary.adapter.answers).toEqual([]);
      expect(ordinary.said).toEqual([]);
      expect(await ordinary.rows()).toEqual([]);
    }
  });

  it("stops the turn when the denial cannot be delivered, rather than leave the request open", async () => {
    bindSafetyFloor(() => ON);
    const adapter = fakeAdapter(() => { throw new Error("broker gone"); });
    const undelivered = request("rm -rf ~", { adapter });
    expect(undelivered.blocked).toBe(true);
    await undelivered.settled;
    expect(adapter.interrupted).toEqual([{ threadId: undelivered.threadId, turnId: "turn-1" }]);
    expect(undelivered.said).toHaveLength(1);
    expect(await undelivered.rows()).toHaveLength(1);
  });

  it("never stops a turn that is no longer the one that asked", async () => {
    bindSafetyFloor(() => ON);
    const adapter = fakeAdapter(() => { throw new Error("broker gone"); });
    let delivered!: () => void;
    const answered = new Promise<void>((resolve) => { delivered = resolve; });
    const respond = adapter.respondToRequest;
    adapter.respondToRequest = async (...args) => {
      try { return await respond(...args); } finally { delivered(); }
    };
    const stale = request("rm -rf ~", { adapter, isCurrent: () => false });
    expect(stale.blocked).toBe(true);
    await answered;
    await flushDecisionLog(DATA_DIR);
    expect(adapter.interrupted).toEqual([]);
  });

  it("holds without an adapter too: nothing is allowed and the block is still recorded", async () => {
    bindSafetyFloor(() => ON);
    const said: unknown[] = [];
    let released!: () => void;
    const settled = new Promise<void>((resolve) => { released = resolve; });
    expect(denyAtSafetyFloor({
      event: { threadId: "thread-no-adapter", tool: "shell", summary: "mkfs.ext4 /dev/sda1", command: { command: "mkfs.ext4 /dev/sda1", cwd: "/" } },
      requestId: "request-2", bot: { id: "bot-2", name: "Bo" }, adapter: undefined, isCurrent: () => true,
      say: (message) => said.push(message), release: () => released(),
    })).toBe(true);
    await settled;
    expect(said).toEqual([{ role: "bot", kind: "activity", tool: { name: "notice: Blocked by the safety floor: formatting a disk", ok: false } }]);
    await flushDecisionLog(DATA_DIR);
    expect(readDecisions(DATA_DIR, 200).filter((row) => row.threadId === "thread-no-adapter")).toEqual([
      expect.objectContaining({ decision: "auto-denied", source: "safety-floor", rule: "format-disk", botName: "Bo" }),
    ]);
  });
});

describe("a runtime that answers its own tool gate", () => {
  it("finds the shell command a tool call carries, and nothing in any other argument", () => {
    expect(shellCommandOfToolCall({ command: "ls -la" })).toBe("ls -la");
    expect(shellCommandOfToolCall({ cmd: "ls -la" })).toBe("ls -la");
    expect(shellCommandOfToolCall({ command: "", cmd: "pwd" })).toBe("pwd");
    expect(shellCommandOfToolCall({ command: ["rm", "-rf", "/"] })).toBeUndefined();
    expect(shellCommandOfToolCall({ text: "rm -rf /", note: "rm -rf /" })).toBeUndefined();
    expect(shellCommandOfToolCall({})).toBeUndefined();
  });

  it("blocks a never-list command and records it, only while the floor is on", async () => {
    const call = { threadId: "thread-chat", botId: "bot-3", tool: "computer_exec", summary: '{"command":"rm -rf /"}', input: { command: "rm -rf /" } };
    expect(floorBlockForToolCall(call)).toBeNull();
    bindSafetyFloor(() => ON);
    expect(floorBlockForToolCall({ ...call, input: { command: "ls /" } })).toBeNull();
    expect(floorBlockForToolCall({ ...call, input: { text: "rm -rf /" } })).toBeNull();
    expect(floorBlockForToolCall(call)).toMatchObject({ rule: "delete-root", line: "Blocked by the safety floor: recursive delete of the filesystem root" });
    await flushDecisionLog(DATA_DIR);
    expect(readDecisions(DATA_DIR, 200).filter((row) => row.threadId === "thread-chat")).toEqual([
      expect.objectContaining({ botId: "bot-3", tool: "computer_exec", decision: "auto-denied", source: "safety-floor", rule: "delete-root" }),
    ]);
  });
});
