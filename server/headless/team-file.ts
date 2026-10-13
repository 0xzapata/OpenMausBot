// The team file: a whole team written down (teams and their briefs, bots
// with their standing instructions, models, approval levels, computers and
// skills, rooms, and the engines they run on), in YAML or JSON, applied
// with `openmausbot team apply FILE`. This module reads and checks a file;
// team-apply.ts compares it with the workspace and makes the changes.
//
// Everything a file names is read when it is loaded (souls, briefs, skills),
// paths relative to the file. Keys are never written in the file: an engine's
// key is { env: NAME } or { file: PATH }, read only when it must be written.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { parseSkillMd } from "../../shared/skill-md.ts";
import { parseToolScope, type ToolScope } from "../../shared/tool-scope.ts";
import { usageError } from "./args.ts";

const SOUL_MAX_BYTES = 24_000;

const secret = z.union([
  z.object({ env: z.string().trim().min(1) }).strict(),
  z.object({ file: z.string().trim().min(1) }).strict(),
], { error: "put the key in an environment variable or a file: { env: NAME } or { file: PATH }" });
const textOrFile = z.union([z.string(), z.object({ file: z.string().trim().min(1) }).strict()]);
const url = z.string().regex(/^https?:\/\/\S+$/, "must be an http:// or https:// address");

const keyOnly = z.object({ key: secret }).strict();
const enginesSchema = z.object({
  claude: z.object({ key: secret, baseUrl: z.union([url, secret]).optional(), everyClaudeBot: z.boolean().optional(), install: z.boolean().optional() }).strict().optional(),
  openai: keyOnly.optional(),
  openrouter: keyOnly.optional(),
  xai: keyOnly.optional(),
  groq: keyOnly.optional(),
  mistral: keyOnly.optional(),
  cerebras: keyOnly.optional(),
  openaiCompatible: z.object({ key: secret, baseUrl: z.union([url, secret]) }).strict().optional(),
}).strict();

const botFields = {
  team: z.string().trim().min(1).max(60).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(4_000).optional(),
  soul: textOrFile.optional(),
  model: z.string().regex(/^[\w.-]+\/\S.*$/, "must be INSTANCE/MODEL, such as claude/claude-sonnet-5-5").optional(),
  effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
  approval: z.enum(["ask", "edits", "auto", "full"], { error: "must be ask, edits, auto or full (custom is set in the desktop app)" }).optional(),
  computer: z.enum(["auto", "off", "browser", "local", "vm", "cloud"]).optional(),
  cwd: z.string().min(1).optional(),
  browser: z.union([z.boolean(), z.object({ enabled: z.boolean(), profile: z.string().trim().min(1).max(100).optional() }).strict()]).optional(),
  tools: z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).strict().optional(),
  skills: z.array(z.object({ file: z.string().trim().min(1), enabled: z.boolean().optional() }).strict()).optional(),
};

const teamFileSchema = z.object({
  version: z.literal(1, { error: "version: 1 is required" }),
  engines: enginesSchema.optional(),
  defaults: z.object(botFields).strict().optional(),
  teams: z.array(z.object({
    name: z.string().trim().min(1).max(60),
    brief: textOrFile.optional(),
    prune: z.boolean().optional(),
  }).strict()).optional(),
  bots: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    was: z.string().trim().min(1).max(100).optional(),
    chief: z.boolean().optional(),
    manages: z.array(z.string().trim().min(1).max(60)).optional(),
    ...botFields,
  }).strict()).min(1, "list at least one bot"),
  rooms: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    team: z.string().trim().min(1).max(60).optional(),
    members: z.array(z.string().trim().min(1)).min(1),
    brief: textOrFile.optional(),
    responder: z.string().trim().min(1).optional(),
  }).strict()).optional(),
}).strict();

export type Secret = z.infer<typeof secret>;
export type TeamFileInput = z.infer<typeof teamFileSchema>;

export interface DesiredSkill { name: string; description: string; text: string; enabled: boolean; file: string }
export interface DesiredBot {
  name: string;
  was?: string;
  team?: string;
  title?: string;
  description?: string;
  /** true: the Chief of Staff of its team; false: not; absent: left as it is. */
  chief?: boolean;
  manages: string[];
  soul?: string;
  model?: { instanceId: string; model: string };
  effort?: string;
  approval?: "ask" | "edits" | "auto" | "full";
  computer?: "auto" | "off" | "browser" | "local" | "vm" | "cloud";
  cwd?: string;
  browser?: { enabled: boolean; profile?: string };
  tools?: ToolScope;
  skills: DesiredSkill[];
}
export interface DesiredRoom { name: string; team?: string; members: string[]; brief?: string; responder?: string }
export interface DesiredTeam { name: string; brief?: string; prune: boolean }
export interface DesiredEngine { kind: string; key: Secret; baseUrl?: string | Secret; everyClaudeBot?: boolean; install?: boolean }

export interface TeamFile {
  path: string;
  engines: DesiredEngine[];
  teams: DesiredTeam[];
  bots: DesiredBot[];
  rooms: DesiredRoom[];
  warnings: string[];
}

const ENGINE_KIND: Record<string, string> = {
  claude: "claude", openai: "openai", openrouter: "openrouter", xai: "xai", groq: "groq", mistral: "mistral", cerebras: "cerebras",
  openaiCompatible: "openai-compatible",
};

/** Read and check a team file. Every problem is a usage error (exit 2) that names where it is. */
export function loadTeamFile(path: string): TeamFile {
  const file = resolve(path);
  const dir = dirname(file);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw usageError(`${path} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let data: unknown;
  try {
    data = /\.json$/i.test(file) ? JSON.parse(raw) : parseYaml(raw);
  } catch (error) {
    throw usageError(`${path} is not valid ${/\.json$/i.test(file) ? "JSON" : "YAML"}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const parsed = teamFileSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length ? issue.path.map((part) => typeof part === "number" ? `[${part}]` : `.${String(part)}`).join("").replace(/^\./, "") : "the file";
    const message = issue.code === "unrecognized_keys" ? `unknown field ${issue.keys.map((key) => `"${key}"`).join(", ")}` : issue.message;
    throw usageError(`${path}: ${where}: ${message}`);
  }
  return checkTeamFile(parsed.data, file, dir);
}

const readRelative = (dir: string, path: string, what: string): string => {
  try {
    return readFileSync(resolve(dir, path), "utf8");
  } catch (error) {
    throw usageError(`${what}: ${path} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
};
const text = (dir: string, value: string | { file: string } | undefined, what: string) =>
  value === undefined ? undefined : typeof value === "string" ? value : readRelative(dir, value.file, what);

/** The file's rules beyond its shape, and every file it names read in. */
export function checkTeamFile(input: TeamFileInput, file: string, dir: string): TeamFile {
  const warnings: string[] = [];
  const key = (name: string) => name.trim().toLowerCase();
  const seen = new Map<string, string>();
  for (const bot of input.bots) {
    if (seen.has(key(bot.name))) throw usageError(`bots: "${bot.name}" is listed twice (names are compared without case)`);
    seen.set(key(bot.name), bot.name);
  }
  const teams: DesiredTeam[] = (input.teams ?? []).map((team) => {
    const brief = text(dir, team.brief, `team "${team.name}" brief`);
    return { name: team.name, ...(brief !== undefined ? { brief } : {}), prune: team.prune === true };
  });
  const teamSeen = new Set<string>();
  for (const team of teams) {
    if (teamSeen.has(key(team.name))) throw usageError(`teams: "${team.name}" is listed twice`);
    teamSeen.add(key(team.name));
  }
  const defaults = input.defaults ?? {};
  const bots: DesiredBot[] = input.bots.map((entry) => {
    const bot = { ...defaults, ...entry };
    const where = `bot "${bot.name}"`;
    if (bot.manages?.length && !bot.chief) throw usageError(`${where}: manages needs chief: true`);
    let cwd: string | undefined;
    if (bot.cwd !== undefined) {
      if (bot.cwd === "~" || bot.cwd.startsWith("~/")) throw usageError(`${where}: cwd must be a full path (~ is not expanded the same way on the server)`);
      if (!isAbsolute(bot.cwd)) throw usageError(`${where}: cwd must be an absolute path on the server`);
      cwd = resolve(bot.cwd);
    }
    const soul = text(dir, bot.soul, `${where} soul`);
    if (soul !== undefined && Buffer.byteLength(soul, "utf8") > SOUL_MAX_BYTES) throw usageError(`${where}: soul is over ${SOUL_MAX_BYTES} bytes`);
    let tools: ToolScope | undefined;
    if (bot.tools) {
      const scope = parseToolScope(bot.tools);
      if (!scope.ok) throw usageError(`${where}: tools: ${scope.error} (selectors look like native:Bash or mcp:server:tool; docs/tool-selection.md)`);
      tools = scope.scope ?? {};
    }
    const skills = (bot.skills ?? []).map((skill) => {
      const body = readRelative(dir, skill.file, `${where} skill`);
      const parsed = parseSkillMd(body);
      if ("error" in parsed) throw usageError(`${where}: ${skill.file}: ${parsed.error}`);
      return { name: parsed.name, description: parsed.description, text: body, enabled: skill.enabled !== false, file: skill.file };
    });
    if (new Set(skills.map((skill) => skill.name)).size !== skills.length) throw usageError(`${where}: two skills share a name`);
    if (bot.computer === undefined) warnings.push(`${where} has no computer set: on auto it may ask which computer to use, and nobody answers a headless run`);
    const slash = bot.model?.indexOf("/") ?? -1;
    const browser = bot.browser === undefined ? undefined : typeof bot.browser === "boolean" ? { enabled: bot.browser } : bot.browser;
    return {
      name: bot.name, ...(bot.was ? { was: bot.was } : {}), ...(bot.team ? { team: bot.team } : {}),
      ...(bot.title !== undefined ? { title: bot.title } : {}), ...(bot.description !== undefined ? { description: bot.description } : {}),
      ...(bot.chief !== undefined ? { chief: bot.chief } : {}), manages: bot.manages ?? [], ...(soul !== undefined ? { soul } : {}),
      ...(bot.model ? { model: { instanceId: bot.model.slice(0, slash), model: bot.model.slice(slash + 1) } } : {}),
      ...(bot.effort ? { effort: bot.effort } : {}), ...(bot.approval ? { approval: bot.approval } : {}),
      ...(bot.computer ? { computer: bot.computer } : {}), ...(cwd ? { cwd } : {}), ...(browser ? { browser } : {}),
      ...(tools ? { tools } : {}), skills,
    };
  });
  const chiefs = new Map<string, string>();
  for (const bot of bots.filter((candidate) => candidate.chief === true)) {
    const team = key(bot.team ?? "");
    if (chiefs.has(team)) throw usageError(`team "${bot.team ?? "(no team)"}" has two chiefs: ${chiefs.get(team)} and ${bot.name}`);
    chiefs.set(team, bot.name);
  }
  const roomSeen = new Set<string>();
  const rooms: DesiredRoom[] = (input.rooms ?? []).map((room) => {
    const where = `room "${room.name}"`;
    if (roomSeen.has(key(room.name))) throw usageError(`rooms: "${room.name}" is listed twice`);
    roomSeen.add(key(room.name));
    if (new Set(room.members.map(key)).size !== room.members.length) throw usageError(`${where}: a member is listed twice`);
    if (room.responder && !["everyone", "mentions"].includes(room.responder) && !room.members.some((member) => key(member) === key(room.responder!))) {
      throw usageError(`${where}: responder must be everyone, mentions, or one of its members`);
    }
    const brief = text(dir, room.brief, `${where} brief`);
    return { name: room.name, ...(room.team ? { team: room.team } : {}), members: room.members, ...(brief !== undefined ? { brief } : {}), ...(room.responder ? { responder: room.responder } : {}) };
  });
  const engines: DesiredEngine[] = Object.entries(input.engines ?? {}).flatMap(([name, value]) => {
    if (!value) return [];
    const spec = value as { key: Secret; baseUrl?: string | Secret; everyClaudeBot?: boolean; install?: boolean };
    // A key file is named relative to the team file, like every other path in it.
    const anchored = <T extends string | Secret>(ref: T): T => typeof ref === "object" && "file" in ref ? { file: resolve(dir, ref.file) } as T : ref;
    return [{ kind: ENGINE_KIND[name]!, key: anchored(spec.key), ...(spec.baseUrl !== undefined ? { baseUrl: anchored(spec.baseUrl) } : {}),
      ...(spec.everyClaudeBot !== undefined ? { everyClaudeBot: spec.everyClaudeBot } : {}), ...(spec.install ? { install: true } : {}) }];
  });
  return { path: file, engines, teams, bots, rooms, warnings };
}
