// Whether one turn's agents proxy lists its tools through the tool bridge
// (drivers/agents-bridge.ts): the workspace's switch, and the one decision
// for a turn of one bot on one engine. What server/index.ts needs to launch
// that proxy and to apply the decision is here too.
//
// The default is no bridge. A call made through use_tool reaches the host and
// the engine under the name use_tool, so a turn is bridged only where nothing
// decides by an agents tool's own name: the bot has no tool selection, and
// its engine is one on which the harness pre-approves the whole agents server
// and nothing the engine reads names it (engineBridgeRefusal below). Even
// then, a tool selection mounted later is given an unbridged proxy at the
// mount (drivers/agents-bridge.ts unbridgedServer), so nothing depends on two
// readings of a bot agreeing.
//
// This module reads the engine drivers to decide. What only needs to know
// whether a turn is bridged, or what a bridged call is called, does not load
// it: the prompt builder reads drivers/agents-bridge.ts, the Activity log
// agents-bridge-names.ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseToolScope } from "../shared/tool-scope.ts";

import { bridgedCallName } from "./agents-bridge-names.ts";
import { TOOL_BRIDGE_ENV } from "./drivers/agents-bridge.ts";
import { claudeCliSupports, parseClaudeCliVersion } from "./drivers/claude.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "./proxy-paths.ts";

export { TOOL_BRIDGE_ENV };

/** How a turn's agents proxy is launched: the harness's own node, on the
 * proxy's entry file (resolved from the server root, server/proxy-paths.ts). */
export const agentsProxyLaunch = () => ({ command: process.execPath, args: [SPAWNED_PROXIES.agents] });

/** What every agents proxy starts with, before anything about its turn is
 * known: the node flag, and the bridge off. The bridge is never left out,
 * so it is never inherited: an engine may hand its MCP children this
 * server's own environment, where OMB_AGENTS_TOOL_BRIDGE=1 is how an
 * operator turns the feature on. A turn that qualifies has it turned on by
 * its decision (bridgedAgents). */
export const AGENTS_PROXY_ENV = { ...AGENTS_NODE_FLAG, [TOOL_BRIDGE_ENV]: "0" } as const;

/** As much of the config as the bridge reads. `features.agentsToolBridge` is
 * the saved switch (its one-key schema sits where config.ts joins it);
 * `features.claudeUserMcp` is the person's own Claude Code MCP servers. */
type BridgeConfig = { features?: { agentsToolBridge?: boolean; claudeUserMcp?: boolean } };

/** The workspace's switch: on by hand in ~/.openmausbot/config.json
 * (`{"features": {"agentsToolBridge": true}}`), or for one server process
 * with OMB_AGENTS_TOOL_BRIDGE=1. The variable wins either way when it is
 * exactly "1" or "0", so a deployment can pin it; anything else leaves the
 * saved setting to decide. A turn still gets the bridge only when its bot
 * and its engine can safely have it: agentsToolBridgeRefusal. */
export function agentsToolBridgeEnabled(cfg: BridgeConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env[TOOL_BRIDGE_ENV];
  if (override === "1") return true;
  if (override === "0") return false;
  return cfg.features?.agentsToolBridge === true;
}

/** The engine a turn runs on, as far as the decision reads it. */
export interface BridgeEngine {
  driverKind: string;
  instanceId?: string;
  /** The instance's own config and environment (config.ts instanceConfigs). */
  config?: unknown;
  environment?: Record<string, string | undefined>;
  /** The engine CLI's version as the harness last read it (the instance's
   * last snapshot); absent before the engines were first described. */
  version?: string | null;
  /** The folder the turn is launched in; absent when the turn has none of
   * its own and the engine falls back to its default. */
  cwd?: string;
}

/** A turn's engine from what server/index.ts holds: the live instance, the
 * instance configs, the registry's last snapshot of it, the turn's folder. */
export function turnEngine(
  instance: { instanceId: string; driverKind: string },
  configs: Record<string, { config?: unknown; environment?: Record<string, string> } | undefined>,
  snapshot: { version?: string | null } | undefined,
  cwd: string | undefined,
): BridgeEngine {
  const { config, environment } = configs[instance.instanceId] ?? {};
  return {
    driverKind: instance.driverKind,
    instanceId: instance.instanceId,
    ...(config !== undefined ? { config } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(snapshot?.version != null ? { version: snapshot.version } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/** The machine an engine runs on, as far as the files it reads go: the
 * person's home and where a managed Claude Code policy would be. Handed in
 * so a test never reads the real ones. */
export interface EngineHost {
  home: string;
  managedPolicyFiles: readonly string[];
}

/** The chat-completions runtime (drivers/openai-chat.ts), by the drivers
 * that run on it. */
const CHAT_RUNTIME_DRIVERS: ReadonlySet<string> = new Set(["cerebras", "grok", "groq", "meta", "minimax", "mistral", "openai-compat"]);

/** Text that names the agents server: the one test for an entry of a tool
 * pattern list and for anything in a settings file, as plain strings
 * compared case-insensitively. It "contains" `mcp__agents`, so a server
 * whose name merely starts the same way counts too, on the cautious side;
 * or it contains `mcp__` followed directly by a wildcard, which in the
 * server position may reach the agents server. No pattern is ever built
 * from configuration text: a glob made of it is the configuration's to
 * make expensive. */
function namesAgentsServer(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("mcp__agents") || lower.includes("mcp__*") || lower.includes("mcp__?");
}

/** Whether a permission rule has a wildcard in a tool's name. The CLI
 * matches a deny or ask rule's whole tool name as a glob, so `mcp__a*__x`,
 * `*exec*` or a bare `*` reaches an agents tool called directly and misses
 * the same call made as use_tool, whatever server the rule was written for.
 * A wildcard inside parentheses is in the rule's specifier (`Bash(git *)`)
 * and matches no tool name. "Inside" is one flag per entry, set at `(` and
 * cleared at `)`, exactly as the CLI splits a `--disallowedTools` list: not
 * a depth, not first-to-last. */
function wildcardInToolName(rule: string): boolean {
  let inside = false;
  for (const char of rule) {
    if (char === "(") inside = true;
    else if (char === ")") inside = false;
    else if (!inside && (char === "*" || char === "?")) return true;
  }
  return false;
}

/** An entry of a pattern list an engine is handed that could match one of
 * the agents server's tools: it names the agents server, or it has a
 * wildcard in a tool's name. The driver takes any text as an entry and joins
 * the entries with a comma for the CLI, so one entry may hold several
 * patterns; both tests read the whole entry, so where in it does not matter.
 * An entry that is not text counts: it cannot be read. */
function namesAgentsTools(entry: unknown): boolean {
  return typeof entry !== "string" || namesAgentsServer(entry) || wildcardInToolName(entry);
}

/** Where a machine-wide Claude Code policy lives, by platform: the
 * documented locations, every one of them for the platform. The CLI applies
 * it to every session, whatever --setting-sources says. */
export function claudeManagedPolicyFiles(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") return ["C:\\Program Files\\ClaudeCode\\managed-settings.json", "C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  return ["/etc/claude-code/managed-settings.json"];
}

/** The most of a settings file that is read. A person's settings are a few
 * kilobytes; anything past this is refused without being read. */
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

/** A settings file's text, null when it is not there (nor a folder to hold
 * it), and "unreadable" when it is there and cannot be read: a file that
 * fails to read, or anything that is not a regular file of a size worth
 * reading. The path is looked at before it is opened, so a FIFO, a socket
 * or a device there is never opened (a FIFO would hold the server's one
 * thread until something wrote to it) and a huge file is never read in. */
function textOf(file: string): string | null | "unreadable" {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > SETTINGS_FILE_MAX_BYTES) return "unreadable";
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unreadable";
  }
}

/** The settings files in a managed policy's drop-in folder
 * (`managed-settings.d` beside it), or "unreadable". No folder, no files. */
function managedDropIns(policyFile: string): string[] | "unreadable" {
  const folder = join(dirname(policyFile), "managed-settings.d");
  try {
    return readdirSync(folder).filter((name) => name.endsWith(".json")).sort().map((name) => join(folder, name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? [] : "unreadable";
  }
}

/** The hooks that judge a tool call before it runs, in lower case: one of
 * them matching by name, matching everything, or testing the name in its own
 * script does not see a call made through use_tool for what it is. */
const JUDGING_HOOKS: ReadonlySet<string> = new Set(["pretooluse", "permissionrequest"]);

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The permission rule lists the CLI matches as globs, in lower case. Allow
 * rules do not glob, and `additionalDirectories` holds no rules. */
const GLOBBING_RULE_LISTS: ReadonlySet<string> = new Set(["deny", "ask"]);

/** The managed-policy key that may void the harness's own pre-approval of
 * the agents server (`--allowedTools mcp__agents`), on which the Claude Code
 * row rests. In lower case. */
const MANAGED_RULES_ONLY_KEY = "allowmanagedpermissionrulesonly";

/** What was found walking a parsed settings file. */
interface SettingsFindings { names: boolean; hooks: boolean; wildcard: boolean; managedOnly: boolean }

/** Walks every value of a parsed settings file. Every string, value or key,
 * is tested for the agents server's name, so a spelling the raw text hides
 * (JSON escapes) is seen. A `hooks` block, under that key in any case and
 * wherever it sits, sets a judging hook when it holds `PreToolUse` or
 * `PermissionRequest`, in any case, with any value but null: a list of none
 * is a value too. The lists a hook entry itself calls `hooks` are walked
 * like anything else. A `permissions` block (any case) has a wildcard rule
 * when a string of its `deny` or `ask` list (any case) has a wildcard in a
 * tool's name. A key `allowManagedPermissionRulesOnly` (any case) with any
 * value but null or false is noted; what it means depends on whose file
 * this is (claudeSettings). */
function walkSettings(value: unknown, found: SettingsFindings): void {
  if (typeof value === "string") {
    if (namesAgentsServer(value)) found.names = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkSettings(item, found);
    return;
  }
  if (!record(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (namesAgentsServer(key)) found.names = true;
    const lower = key.toLowerCase();
    if (lower === "hooks" && record(inner)) {
      for (const [event, setting] of Object.entries(inner)) if (JUDGING_HOOKS.has(event.toLowerCase()) && setting !== null) found.hooks = true;
    }
    if (lower === "permissions" && record(inner)) {
      for (const [list, rules] of Object.entries(inner)) {
        if (!GLOBBING_RULE_LISTS.has(list.toLowerCase()) || !Array.isArray(rules)) continue;
        if (rules.some((rule) => typeof rule === "string" && wildcardInToolName(rule))) found.wildcard = true;
      }
    }
    if (lower === MANAGED_RULES_ONLY_KEY && inner !== null && inner !== false) found.managedOnly = true;
    walkSettings(inner, found);
  }
}

type SettingsReading = "silent" | "names" | "hooks" | "wildcard" | "managed-only" | "unreadable";

/** What one Claude settings file means for the bridge: nothing (also when
 * it is not there); that it names the agents server anywhere (in its raw
 * text or in any string or key of what it parses to); that it sets a hook
 * that judges tool calls; that a deny or ask rule of its has a wildcard in a
 * tool's name, which may reach an agents tool by pattern; for a managed
 * policy only, that it allows only its own permission rules, which may void
 * the pre-approval the bridge rests on; or that it cannot be read as
 * settings (its top level is not an object, or its `hooks` is neither an
 * object nor null). The first of these that holds, in that order, is the
 * reading.
 *
 * Every hook of those two kinds counts. OpenMausBot's own hooks cannot be
 * among them: they are PostToolUse, PreCompact, SessionStart and Stop, and
 * they reach the CLI through a private --settings file written for the
 * launch (drivers/claude.ts claudeHookSettings), never through a file this
 * reads. */
function claudeSettings(file: string, managed: boolean): SettingsReading {
  const text = textOf(file);
  if (text === null) return "silent";
  if (text === "unreadable") return "unreadable";
  if (namesAgentsServer(text)) return "names";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  if (!record(parsed)) return "unreadable";
  const hooks = Object.entries(parsed).find(([key]) => key.toLowerCase() === "hooks")?.[1];
  if (hooks !== undefined && hooks !== null && !record(hooks)) return "unreadable";
  const found: SettingsFindings = { names: false, hooks: false, wildcard: false, managedOnly: false };
  walkSettings(parsed, found);
  if (found.names) return "names";
  if (found.hooks) return "hooks";
  if (found.wildcard) return "wildcard";
  if (managed && found.managedOnly) return "managed-only";
  return "silent";
}

/** Why a Claude Code turn is not bridged, or null. `--allowedTools
 * mcp__agents` pre-allows the whole agents server (drivers/claude.ts, where
 * it is mounted), so the harness asks nothing by name. What the CLI itself
 * reads is the rest of it. */
function claudeRefusal(cfg: BridgeConfig, engine: BridgeEngine, env: NodeJS.ProcessEnv, host: EngineHost): string | null {
  // The CLI is started with the server's environment under the instance's.
  if ({ ...env, ...engine.environment }.OMB_CLAUDE_INHERIT_USER_CONFIG === "1" || cfg.features?.claudeUserMcp === true) {
    return "the bot inherits this machine's own Claude Code setup";
  }
  const config = engine.config && typeof engine.config === "object" ? engine.config as { tools?: unknown; disallowedTools?: unknown } : {};
  for (const list of [config.tools, config.disallowedTools]) {
    // A list that cannot be read is refused by the driver; never bridged here.
    if (list !== undefined && (!Array.isArray(list) || list.some(namesAgentsTools))) return "the engine's tool patterns name the agents server or match tools by pattern";
  }
  // The driver's own floor table and its own reading of a version. Unlike
  // the driver, which takes an unreadable version for a current CLI so that
  // it keeps passing its flags, an unknown version here is no bridge.
  const version = parseClaudeCliVersion(engine.version);
  if (version === null) return "the Claude CLI's version is not known";
  if (!claudeCliSupports(version, "--setting-sources")) return "the Claude CLI is too old to leave the person's own settings out";
  // An isolated turn is launched with --setting-sources project, so the CLI
  // still reads the settings of the folder it is launched in (the turn's
  // own, or the person's home), and a managed policy always applies, with
  // the files of its drop-in folder.
  const folder = join(engine.cwd ?? host.home, ".claude");
  const read = [join(folder, "settings.json"), join(folder, "settings.local.json")].map((file) => claudeSettings(file, false));
  for (const policy of host.managedPolicyFiles) {
    const dropIns = managedDropIns(policy);
    if (dropIns === "unreadable") return "a Claude settings file cannot be read";
    read.push(...[policy, ...dropIns].map((file) => claudeSettings(file, true)));
  }
  if (read.includes("unreadable")) return "a Claude settings file cannot be read";
  if (read.includes("names")) return "a Claude settings file names the agents server";
  if (read.includes("hooks")) return "a Claude settings file sets a hook that judges tool calls";
  if (read.includes("wildcard")) return "a Claude settings file denies or asks for tools by pattern";
  if (read.includes("managed-only")) return "a managed Claude policy allows only its own permission rules";
  return null;
}

/** Why this engine's turns are not bridged, or null when they are.
 *
 * An engine qualifies only when the harness pre-approves the whole agents
 * server on it, so no approval is asked for, remembered or refused by an
 * agents tool's name, and when everything the engine itself reads that
 * could name one can be read here:
 *
 *   Claude Code   pre-allowed as a whole (--allowedTools mcp__agents); see
 *                 claudeRefusal for what the CLI reads and what turns it down.
 *   API models    the chat runtime never asks for the agents server
 *                 (drivers/chat-mcp-tools.ts, view(): `ask: false`), and
 *                 reads no configuration of the person's about a tool.
 *
 * Everything else is left out, each for its own reason:
 *
 *   Codex         mounted with approval mode "approve", but it reads a
 *                 layered configuration of its own (config.toml under
 *                 CODEX_HOME or ~/.codex, a Company engine's own home under
 *                 this server's data, a trusted project's .codex/config.toml,
 *                 /etc/codex/config.toml and managed_config.toml) and has
 *                 PreToolUse and PermissionRequest hooks, any of which can
 *                 take a rule about a tool by name. Reading every layer is
 *                 not something this version does.
 *   Pi            launched with -e for this server's extension and nothing
 *                 that keeps the person's own out (drivers/pi.ts PI_ARGS), in
 *                 the person's home. Pi loads the extensions found there, and
 *                 an extension's tool_call handler can block a call by the
 *                 name it sees, as this server's own does
 *                 (drivers/pi-mcp-extension.ts).
 *   ACP agents    keep their own permissions: one "always allow" given for a
 *                 harmless use_tool call would cover every hidden tool for the
 *                 session, a reviewer would lose the read-only marks the
 *                 hidden reads carry, and Grok has a native use_tool of its
 *                 own (drivers/acp/grok.ts).
 *   the rest      Muse Code and any driver not named here have not been
 *                 shown to qualify. */
export function engineBridgeRefusal(
  cfg: BridgeConfig,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host: EngineHost = { home: homedir(), managedPolicyFiles: claudeManagedPolicyFiles() },
): string | null {
  if (!engine) return "no engine";
  const { driverKind } = engine;
  if (driverKind === "claudeAgent") return claudeRefusal(cfg, engine, env, host);
  if (CHAT_RUNTIME_DRIVERS.has(driverKind)) return null;
  if (driverKind === "codex") return "Codex reads its own layered configuration and hooks, which this version does not examine";
  if (driverKind === "piAgent") return "Pi loads the person's own extensions, which can block a tool by its name, and this version does not examine them";
  return "this engine keeps its own tool permissions";
}

/** Why a turn of `bot` on `engine` is not bridged, or null when it is: the
 * one decision, and a total one. It reads files and records on a bot's
 * turn, and the bridge is a saving, never something a turn should fail
 * for: whatever is thrown inside it is answered as no bridge, the
 * integration then being exactly what the switch off gives, and one line
 * is logged naming the class of what was thrown (and a file system error's
 * code), never its message, which may carry a path or what a file held. */
export function agentsToolBridgeRefusal(
  cfg: BridgeConfig,
  // store.bot() answers null for a bot that is gone; no bot, no bridge.
  bot: { toolScope?: unknown } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host?: EngineHost,
): string | null {
  try {
    if (!agentsToolBridgeEnabled(cfg, env)) return "the switch is off";
    // A tool selection is enforced by gates that match the name in the call
    // (mcp-gate.ts, the chat runtime, the Pi extension). Any selection counts,
    // even one that permits everything, because any selection mounts those
    // gates; one that cannot be read counts too (the turn is refused elsewhere).
    const selection = bot ? parseToolScope(bot.toolScope) : undefined;
    if (selection?.ok !== true || selection.scope !== undefined) return "the bot has a tool selection";
    return engineBridgeRefusal(cfg, engine, env, host);
  } catch (error) {
    const kind = logWord(() => (error instanceof Error ? error.name : typeof error));
    const code = logWord(() => (error as { code?: unknown } | null)?.code, true);
    console.warn(`[agents] the tool bridge decision failed (${kind}${code === null ? "" : ` ${code}`}); the turn is not bridged`);
    return "the decision failed";
  }
}

/** A thrown value's `name` or `code` as a word fit for the log: it is
 * printed as given only when it is a short string of letters, digits, `_`,
 * `-` and `.`; anything else, and anything that cannot be read (a getter
 * that throws), is "unknown". With `absent`, a value that is not there at
 * all is null, so the log leaves it out. */
function logWord(read: () => unknown, absent = false): string | null {
  try {
    const value = read();
    if (absent && (value === undefined || value === null)) return null;
    return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
  } catch {
    return "unknown";
  }
}

/** The decision as the entry of the agents proxy's environment: "1" or "0",
 * never left out. */
export function agentsToolBridgeEnv(
  cfg: BridgeConfig,
  bot: { toolScope?: unknown } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  host?: EngineHost,
): { [TOOL_BRIDGE_ENV]: "1" | "0" } {
  return { [TOOL_BRIDGE_ENV]: agentsToolBridgeRefusal(cfg, bot, engine, env, host) === null ? "1" : "0" };
}

/** How many threads' marks are kept. Far more than run at once; the cap is
 * there so the set cannot grow with every thread a server ever bridged. */
export const BRIDGED_THREADS_MAX = 5_000;

/** The threads whose turn in flight was asked to bridge, oldest decision
 * first. A thread runs one turn at a time, and each turn's decision replaces
 * the last. Past the cap the oldest mark is dropped; what that costs, should
 * its turn still be running, is a row shown as use_tool instead of the tool
 * it ran. */
const BRIDGED_THREADS = new Set<string>();

/** A turn's agents integration with the decision for that turn written into
 * it: what the turn mounts, and what its prompt is built from. A turn that
 * mounts no agents tools has nothing to decide, and its thread's mark goes. */
export function bridgedAgents<Agents extends { env: Record<string, string> }>(
  threadId: string,
  agents: Agents | undefined,
  cfg: BridgeConfig,
  bot: { toolScope?: unknown } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env?: NodeJS.ProcessEnv,
  host?: EngineHost,
): Agents | undefined {
  BRIDGED_THREADS.delete(threadId);
  if (!agents) return undefined;
  const decided = agentsToolBridgeEnv(cfg, bot, engine, env, host);
  if (decided[TOOL_BRIDGE_ENV] === "1") {
    BRIDGED_THREADS.add(threadId);
    if (BRIDGED_THREADS.size > BRIDGED_THREADS_MAX) BRIDGED_THREADS.delete(BRIDGED_THREADS.values().next().value!);
  }
  return { ...agents, env: { ...agents.env, ...decided } };
}

/** Decides a turn and writes the decision into the integrations it mounts,
 * in place: the one statement server/index.ts makes for it, once the folder
 * the turn is launched in is known and before the prompt is built. A turn
 * with no agents tools is left as it was, without an `agents` key: there is
 * nothing to assign. */
export function applyAgentsBridge<Agents extends { env: Record<string, string> }>(
  threadId: string,
  integrations: { agents?: Agents },
  cfg: BridgeConfig,
  bot: { toolScope?: unknown } | null | undefined,
  engine: BridgeEngine | null | undefined,
  env?: NodeJS.ProcessEnv,
  host?: EngineHost,
): void {
  const agents = bridgedAgents(threadId, integrations.agents, cfg, bot, engine, env, host);
  if (agents !== undefined) integrations.agents = agents;
}

/** The name a tool call's row is given. On a turn that was asked to bridge,
 * a use_tool call on the agents server that names one of the catalog's tools
 * reads as that tool, so the activity row, the work summary, the daily log,
 * the screen-preview refresh and the restart policy's evidence all see what
 * ran. Anything else keeps its name, and so does every call of a turn that
 * was not bridged: there a tool called use_tool is some other server's
 * (Grok's native one, or a configured server's on an engine such as Codex,
 * whose events name the tool without its server). */
export function bridgedToolTitle(threadId: string, title: string, input: unknown): string {
  return BRIDGED_THREADS.has(threadId) ? bridgedCallName(title, input) : title;
}
