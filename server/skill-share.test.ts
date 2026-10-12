import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts resolves DATA_DIR at import time; isolate before importing.
process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "omb-skill-share-"));

const library = await import("./skill-library.ts");
const skills = await import("./skills.ts");
const share = await import("./skill-share.ts");
const { buildSystemPrompt } = await import("./system-prompt.ts");
const { learnSource } = await import("./skill-learn.ts");

const SKILL = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: Cuts a rough edit the way this team does.\n---\n\n# ${name}\n\n${body}\n`;

interface Bot { id: string; name: string; section?: string; assignedSkills?: string[] }

let bots: Bot[];
let author: Bot;
let mate: Bot;
let other: Bot;
let root: string;
const patchAssigned = (botId: string, assignedSkills: string[]) => {
  const bot = bots.find((candidate) => candidate.id === botId)!;
  bot.assignedSkills = assignedSkills;
};
const id = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

/** A learned skill applied to the author's private store, like skill_manage. */
function learn(botId: string, name: string, body?: string) {
  const staged = skills.stageSkillWrite(botId, { action: "create", files: [{ path: "SKILL.md", content: SKILL(name, body) }], source: learnSource("conversation") });
  if ("error" in staged) throw new Error(staged.error);
  const applied = skills.applyStagedSkillWrite(botId, staged.id, { expectedSha256: staged.sha256 });
  if ("error" in applied) throw new Error(applied.error);
  return staged;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-skill-share-lib-"));
  author = { id: id("author"), name: "Cutter", section: "Editing", assignedSkills: [] };
  mate = { id: id("mate"), name: "Colorist", section: " Editing ", assignedSkills: ["existing-skill"] };
  other = { id: id("other"), name: "Accountant", section: "Finance" };
  bots = [author, mate, other];
});

describe("sharing learned skills with the team", () => {
  it("moves a learned skill into the library and assigns it to the author's team only", () => {
    const staged = learn(author.id, "rough-cut");
    const result = share.shareLearnedSkill({ author, bots, name: "rough-cut", patchAssigned, root, now: 1000 });
    if ("error" in result) throw new Error(result.error);
    expect(result.library).toBe("installed");
    expect(result.sha256).toBe(staged.sha256);
    expect(result.assigned.map((bot) => bot.botId)).toEqual([author.id, mate.id]);
    // the library holds the exact reviewed bytes, enabled
    expect(library.readLibrarySkillFile("rough-cut", root)).toBe(SKILL("rough-cut"));
    expect(library.listLibrarySkills(root)[0]).toMatchObject({ name: "rough-cut", enabled: true });
    // the private copy is archived write-once and its manifest entry gone
    expect(skills.listSkills(author.id).map((skill) => skill.name)).not.toContain("rough-cut");
    expect(readFileSync(join(library.libraryArchiveDirectory(root, author.id, "rough-cut"), "SKILL.md"), "utf8")).toBe(SKILL("rough-cut"));
    expect(author.assignedSkills).toEqual(["rough-cut"]);
    expect(mate.assignedSkills).toEqual(["existing-skill", "rough-cut"]);
    expect(other.assignedSkills).toBeUndefined();
    // the author's durable pending assignment is spent once applied
    expect(JSON.parse(readFileSync(join(root, "pending-assignments.json"), "utf8"))[author.id]).toBeUndefined();
    expect(share.sharedAssignmentTimes(mate.id, root)).toEqual({ "rough-cut": 1000 });
    expect(share.sharedAssignmentTimes(author.id, root)).toEqual({});
  });

  it("never clobbers a teammate's own skill of the same name and reports it", () => {
    learn(author.id, "rough-cut");
    skills.installSkill(mate.id, "private:test", [{ path: "SKILL.md", content: SKILL("rough-cut", "The colorist's own way.") }]);
    const result = share.shareLearnedSkill({ author, bots, name: "rough-cut", patchAssigned, root });
    if ("error" in result) throw new Error(result.error);
    expect(result.skipped).toEqual([{ botId: mate.id, name: "Colorist", reason: 'has its own skill named "rough-cut"' }]);
    expect(mate.assignedSkills).toEqual(["existing-skill"]);
    expect(skills.readSkillFile(mate.id, "rough-cut")).toContain("The colorist's own way.");
  });

  it("refuses when the library holds different bytes under that name and leaves the private skill alone", () => {
    library.installLibrarySkill({ name: "rough-cut", instructions: SKILL("rough-cut", "Someone else's."), source: "local-import", root });
    learn(author.id, "rough-cut");
    const result = share.shareLearnedSkill({ author, bots, name: "rough-cut", patchAssigned, root });
    expect(result).toEqual({ error: 'the library already has a different skill named "rough-cut"' });
    expect(skills.listSkills(author.id).find((skill) => skill.name === "rough-cut")?.enabled).toBe(true);
    expect(mate.assignedSkills).toEqual(["existing-skill"]);
  });

  it("Undo of a shared create takes it out of the library and off every bot it was assigned to", () => {
    learn(author.id, "rough-cut");
    const result = share.shareLearnedSkill({ author, bots, name: "rough-cut", patchAssigned, root });
    if ("error" in result) throw new Error(result.error);
    const undone = share.undoSharedLearnedSkill({ authorId: author.id, name: "rough-cut", action: "create", share: result, bots, patchAssigned, root });
    expect(undone).toEqual({ undone: true });
    expect(library.readSkillLibraryIndex(root)["rough-cut"]).toBeUndefined();
    expect(author.assignedSkills).toEqual([]);
    expect(mate.assignedSkills).toEqual(["existing-skill"]);
    expect(share.sharedAssignmentTimes(mate.id, root)).toEqual({});
    // the retired bytes are archived, never deleted
    expect(readdirSync(join(root, "archive", "retired"))).toHaveLength(1);
  });

  it("updates a shared skill through the library copy, refuses a stale read, and Undo restores the previous version", () => {
    learn(author.id, "rough-cut");
    const first = share.shareLearnedSkill({ author, bots, name: "rough-cut", patchAssigned, root });
    if ("error" in first) throw new Error(first.error);
    // a teammate improves it: the library copy changes for everyone
    const stale = share.updateSharedLearnedSkill({ bot: mate, bots, name: "rough-cut", skillMd: SKILL("rough-cut", "v2"), expectSha256: "0".repeat(64), patchAssigned, root });
    expect(stale).toEqual({ error: 'skill "rough-cut" changed since it was read — read it again first' });
    const updated = share.updateSharedLearnedSkill({ bot: mate, bots, name: "rough-cut", skillMd: SKILL("rough-cut", "v2"), expectSha256: first.sha256, patchAssigned, root });
    if ("error" in updated) throw new Error(updated.error);
    expect(updated.share.library).toBe("updated");
    expect(updated.previous.skillMd).toBe(SKILL("rough-cut"));
    expect(library.readLibrarySkillFile("rough-cut", root)).toBe(SKILL("rough-cut", "v2"));
    expect(share.sharedSkillEditable(mate.id, mate.assignedSkills, "rough-cut", root)).toBe(true);
    const undone = share.undoSharedLearnedSkill({ authorId: mate.id, name: "rough-cut", action: "update", share: updated.share, previous: updated.previous, bots, patchAssigned, root });
    expect(undone).toEqual({ undone: true });
    expect(library.readLibrarySkillFile("rough-cut", root)).toBe(SKILL("rough-cut"));
    // an Undo once the copy changed again is stale and changes nothing
    expect(share.undoSharedLearnedSkill({ authorId: mate.id, name: "rough-cut", action: "update", share: updated.share, previous: updated.previous, bots, patchAssigned, root })).toEqual({ stale: true });
    expect(author.assignedSkills).toEqual(["rough-cut"]);
  });

  it("shares an already-library learned skill by assignment alone", () => {
    library.installLibrarySkill({ name: "rough-cut", instructions: SKILL("rough-cut"), source: learnSource("conversation"), reviewState: "approved", root });
    author.assignedSkills = ["rough-cut"];
    const result = share.shareLearnedSkill({ author, bots, name: "rough-cut", patchAssigned, root });
    if ("error" in result) throw new Error(result.error);
    expect(result.library).toBe("assigned");
    expect(result.assigned.map((bot) => bot.botId)).toEqual([mate.id]);
  });
});

describe("prompt-cache safety", () => {
  // skillsSystemPrompt reads the default library, so this block uses it.
  beforeEach(() => { root = library.skillsLibraryRoot(); });
  /** The teammate's system prompt the way server/index.ts composes it for a
   * conversation: the skills index built from the conversation's assignments. */
  const systemPrompt = (botId: string, startedAt: number | undefined) =>
    buildSystemPrompt("persona", "soul", [
      { id: "skills", label: "Skills index", text: skills.skillsSystemPrompt(botId, share.conversationAssignedSkills(botId, mate.assignedSkills, startedAt, root)) },
    ]);

  it("keeps an existing conversation's system prompt byte-identical after a share and announces the skill once", () => {
    // the teammate's existing library skill gives it a non-empty index
    library.installLibrarySkill({ name: "existing-skill", instructions: SKILL("existing-skill"), source: "local-import", reviewState: "approved", root });
    const startedAt = 500;
    const before = systemPrompt(mate.id, startedAt);
    learn(author.id, "rough-cut");
    const result = share.shareLearnedSkill({ author, bots, name: "rough-cut", patchAssigned, root, now: 1000 });
    if ("error" in result) throw new Error(result.error);
    expect(mate.assignedSkills).toContain("rough-cut");
    // the conversation that started before the share: same bytes, stable and volatile
    const after = systemPrompt(mate.id, startedAt);
    expect(after.text).toBe(before.text);
    expect(after.stable).toBe(before.stable);
    expect(after.volatile).toBe(before.volatile);
    // a conversation started after the share lists it
    expect(systemPrompt(mate.id, 2000).text).toContain("rough-cut");
    expect(systemPrompt(mate.id, undefined).text).toContain("rough-cut");
    // the existing conversation hears about it on its next turn, once
    const note = share.takeShareNote(mate.id, "thread-1", mate.assignedSkills, startedAt, [], root);
    expect(note).toContain("New team skill available: rough-cut");
    expect(note).toContain(library.librarySkillFilePath("rough-cut", root));
    expect(share.takeShareNote(mate.id, "thread-1", mate.assignedSkills, startedAt, [], root)).toBe("");
    // a new conversation needs no note: the index already lists it
    expect(share.takeShareNote(mate.id, "thread-2", mate.assignedSkills, 2000, [], root)).toBe("");
    expect(existsSync(join(root, "share-notes.json"))).toBe(true);
  });

  it("changes nothing for a bot no share touched", () => {
    expect(share.conversationAssignedSkills(other.id, ["a", "b"], 1, root)).toEqual(["a", "b"]);
    expect(share.conversationAssignedSkills(other.id, undefined, 1, root)).toBeUndefined();
    expect(share.takeShareNote(other.id, "t", ["a"], 1, [], root)).toBe("");
  });
});
