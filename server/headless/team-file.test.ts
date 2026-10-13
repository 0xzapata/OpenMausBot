// A team file read and checked: defaults under every bot, files read in from
// beside it, and each rule that makes a file unusable named with where it is.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { loadTeamFile } from "./team-file.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-team-file-"));
afterAll(() => removeTempDir(dir));
let n = 0;
const file = (text: string, name = `team-${++n}.yaml`) => { writeFileSync(join(dir, name), text); return join(dir, name); };
const refused = (text: string) => {
  try {
    loadTeamFile(file(text));
  } catch (error) {
    return { message: (error as Error).message, exitCode: (error as { exitCode?: number }).exitCode };
  }
  throw new Error("expected the file to be refused");
};

mkdirSync(join(dir, "souls"), { recursive: true });
mkdirSync(join(dir, "skills", "launch-report"), { recursive: true });
writeFileSync(join(dir, "souls", "lead.md"), "Lead the rehearsal.\n");
writeFileSync(join(dir, "skills", "launch-report", "SKILL.md"), "---\nname: launch-report\ndescription: Write the report.\n---\nBody.\n");

describe("loadTeamFile", () => {
  it("puts defaults under every bot, reads souls and skills from beside the file, and keeps keys as references", () => {
    const team = loadTeamFile(file(`version: 1
engines:
  claude: { key: { env: ANTHROPIC_API_KEY }, baseUrl: https://gateway.example, everyClaudeBot: true }
  openaiCompatible: { key: { file: keys/compat }, baseUrl: { env: COMPAT_URL } }
defaults:
  team: Launch Room
  model: claude/claude-haiku-5-5
  approval: full
  computer: browser
  browser: { enabled: true, profile: guest }
  cwd: /work/visitors/
  tools: { deny: ["native:Bash"] }
teams:
  - { name: Launch Room, prune: true, brief: "We rehearse." }
bots:
  - name: Room Lead
    chief: true
    manages: [Support]
    model: claude/claude-sonnet-5-5
    effort: medium
    computer: local
    browser: false
    tools: { deny: [] }
    soul: { file: souls/lead.md }
    skills: [{ file: skills/launch-report/SKILL.md }]
  - name: Priya
    soul: You are Priya.
rooms:
  - { name: Rehearsal, members: [Room Lead, Priya], responder: Room Lead }
`));
    expect(team.bots[0]).toEqual({
      name: "Room Lead", team: "Launch Room", chief: true, manages: ["Support"], soul: "Lead the rehearsal.\n",
      model: { instanceId: "claude", model: "claude-sonnet-5-5" }, effort: "medium", approval: "full", computer: "local",
      cwd: "/work/visitors", browser: { enabled: false }, tools: { deny: [] },
      skills: [{ name: "launch-report", description: "Write the report.", text: expect.stringContaining("Body."), enabled: true, file: "skills/launch-report/SKILL.md" }],
    });
    expect(team.bots[1]).toMatchObject({ name: "Priya", team: "Launch Room", model: { instanceId: "claude", model: "claude-haiku-5-5" },
      browser: { enabled: true, profile: "guest" }, tools: { deny: ["native:Bash"] }, soul: "You are Priya.", skills: [], manages: [] });
    expect(team.bots[1]).not.toHaveProperty("chief");
    expect(team.teams).toEqual([{ name: "Launch Room", brief: "We rehearse.", prune: true }]);
    expect(team.rooms).toEqual([{ name: "Rehearsal", members: ["Room Lead", "Priya"], responder: "Room Lead" }]);
    expect(team.engines).toEqual([
      { kind: "claude", key: { env: "ANTHROPIC_API_KEY" }, baseUrl: "https://gateway.example", everyClaudeBot: true },
      { kind: "openai-compatible", key: { file: join(dir, "keys", "compat") }, baseUrl: { env: "COMPAT_URL" } },
    ]);
    expect(team.warnings).toEqual([]);
  });

  it("reads JSON too, and warns about a bot left on an automatic computer", () => {
    const team = loadTeamFile(file(JSON.stringify({ version: 1, bots: [{ name: "Solo" }] }), "team.json"));
    expect(team.bots).toEqual([{ name: "Solo", manages: [], skills: [] }]);
    expect(team.warnings).toEqual([expect.stringContaining('bot "Solo" has no computer set')]);
  });

  it.each([
    ["a literal key", "engines: { claude: { key: sk-ant-abcdefghijklmnopqrstuvwx } }\nbots: [{ name: A }]", "put the key in an environment variable or a file"],
    ["an unknown field", "bots: [{ name: A, colour: blue }]", 'bots[0]: unknown field "colour"'],
    ["no bots", "bots: []", "list at least one bot"],
    ["a duplicate name", "bots: [{ name: Priya }, { name: priya }]", '"priya" is listed twice'],
    ["two chiefs in a team", "bots: [{ name: A, team: T, chief: true }, { name: B, team: T, chief: true }]", 'team "T" has two chiefs: A and B'],
    ["manages without chief", "bots: [{ name: A, manages: [T] }]", "manages needs chief: true"],
    ["a model without its engine", "bots: [{ name: A, model: sonnet }]", "must be INSTANCE/MODEL"],
    ["a relative folder", "bots: [{ name: A, cwd: work/a }]", "cwd must be an absolute path on the server"],
    ["a home folder", "bots: [{ name: A, cwd: ~/work }]", "~ is not expanded the same way on the server"],
    ["Custom approval", "bots: [{ name: A, approval: custom }]", "custom is set in the desktop app"],
    ["a soul file that is not there", "bots: [{ name: A, soul: { file: souls/nobody.md } }]", "souls/nobody.md could not be read (ENOENT)"],
    ["a bad tool selector", 'bots: [{ name: A, tools: { deny: ["Bash"] } }]', "selectors look like native:Bash"],
    ["a room member listed twice", "bots: [{ name: A }]\nrooms: [{ name: R, members: [A, a] }]", "a member is listed twice"],
    ["a responder from outside the room", "bots: [{ name: A }]\nrooms: [{ name: R, members: [A], responder: B }]", "responder must be everyone, mentions, or one of its members"],
  ])("refuses %s (exit 2)", (_what, body, message) => {
    expect(refused(`version: 1\n${body}\n`)).toEqual({ message: expect.stringContaining(message), exitCode: 2 });
  });

  it("refuses a file without its version, or one that is not YAML", () => {
    expect(refused("bots: [{ name: A }]\n").message).toContain("version: 1 is required");
    expect(refused("version: 1\nbots: [ { name: A\n").message).toContain("is not valid YAML");
  });
});
