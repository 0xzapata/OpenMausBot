// Share learned skills with the author's team (features.shareLearnedSkills,
// only while features.skillsLibrary is on).
//
// A skill a bot learns (skill_manage, the automatic skill review) lands in
// that bot's private skills store. Sharing moves it into the shared skills
// library right away — the same move the boot migration makes: install the
// exact reviewed bytes, record the author's assignment durably, archive the
// private copy write-once, drop its manifest entry — and assigns it to every
// bot in the author's team (bots in the same sidebar section). A teammate
// that already has a private skill of that name keeps it; the receipt says
// so. Once shared, an update by any bot it is assigned to rewrites the
// library copy while it is still the version that bot read.
//
// Prompt-cache safety. A teammate's existing conversations must not see
// their system prompt change because a skill was shared: that would throw
// away the provider's cached prefix of a long conversation. So every
// assignment made by a share is recorded with its time, and a conversation
// that started before it keeps that skill out of its skills index for good.
// It learns about the skill instead from a one-time note added to its next
// user turn. New conversations see the skill in the index like any other.
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { LEARN_SOURCE_PREFIX } from "./skill-learn.ts";
import {
  installLibrarySkill,
  libraryArchiveDirectory,
  librarySkillFilePath,
  listLibrarySkills,
  readLibrarySkillFile,
  readSkillLibraryIndex,
  retireLibrarySkill,
  skillLibraryEvents,
  skillsLibraryRoot,
  updateLibrarySkill,
} from "./skill-library.ts";
import { archiveSkillDirectory, readPendingAssignments, writePendingAssignments } from "./skills-library-migration.ts";
import { listMigratableSkills, listSkills, prepareLearnedSkillMd, removeManifestEntry } from "./skills.ts";
import type { SkillShareRecord } from "../shared/skill-request.ts";

export type ShareLearnedSkillsMode = "off" | "ask" | "auto";

export interface ShareBot {
  id: string;
  name: string;
  section?: string;
  assignedSkills?: string[];
}

type PatchAssigned = (botId: string, assignedSkills: string[]) => void;

const sectionKey = (section?: string | null): string => section?.trim() || "";

/** The author's team: every other bot in the same sidebar section (the
 * unsectioned bots are the General team). */
export function teammatesOf(author: ShareBot, bots: readonly ShareBot[]): ShareBot[] {
  const team = sectionKey(author.section);
  return bots.filter((bot) => bot.id !== author.id && sectionKey(bot.section) === team);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const sortedUnique = (names: readonly string[]) => [...new Set(names)].sort();

// --- the shared-assignment record (prompt-cache safety) ------------------

function sharedAssignmentsPath(root: string): string {
  return join(root, "shared-assignments.json");
}

function shareNotesPath(root: string): string {
  return join(root, "share-notes.json");
}

function readJsonRecord(path: string): Record<string, Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) result[key] = { ...(value as Record<string, unknown>) };
    }
    return result;
  } catch {
    return {};
  }
}

function writeJsonRecord(root: string, path: string, value: unknown): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** When a share assigned each skill to this bot (epoch ms), by name. */
export function sharedAssignmentTimes(botId: string, root: string = skillsLibraryRoot()): Record<string, number> {
  const entry = readJsonRecord(sharedAssignmentsPath(root))[botId] ?? {};
  const result: Record<string, number> = {};
  for (const [name, at] of Object.entries(entry)) if (typeof at === "number" && Number.isFinite(at)) result[name] = at;
  return result;
}

function recordSharedAssignments(root: string, changes: Array<{ botId: string; name: string; at: number | null }>): void {
  if (!changes.length) return;
  const all = readJsonRecord(sharedAssignmentsPath(root));
  for (const change of changes) {
    const entry = { ...all[change.botId] };
    if (change.at === null) delete entry[change.name];
    else entry[change.name] = change.at;
    if (Object.keys(entry).length) all[change.botId] = entry;
    else delete all[change.botId];
  }
  writeJsonRecord(root, sharedAssignmentsPath(root), all);
}

/** Shared skills this conversation must keep out of its skills index: the
 * ones a share assigned after the conversation started. `startedAt` is the
 * time of the conversation's first message; a conversation with none is
 * new and withholds nothing. */
function withheldForConversation(botId: string, startedAt: number | undefined, root: string): Set<string> {
  if (startedAt === undefined) return new Set();
  return new Set(Object.entries(sharedAssignmentTimes(botId, root))
    .filter(([, at]) => startedAt < at)
    .map(([name]) => name));
}

/** The library assignments a conversation's skills index may list. Equal
 * to `assigned` except for skills shared into this bot after the
 * conversation started, so a share never changes an existing
 * conversation's system prompt. */
export function conversationAssignedSkills(
  botId: string,
  assigned: readonly string[] | undefined,
  startedAt: number | undefined,
  root: string = skillsLibraryRoot(),
): string[] | undefined {
  if (!assigned?.length) return assigned ? [...assigned] : undefined;
  const withheld = withheldForConversation(botId, startedAt, root);
  return withheld.size ? assigned.filter((name) => !withheld.has(name)) : [...assigned];
}

/** The one-time note for skills shared into this bot after the
 * conversation started: added to the next user turn instead of the system
 * prompt, then remembered so it is never repeated in this conversation.
 * Empty when there is nothing new. */
export function takeShareNote(
  botId: string,
  threadId: string,
  assigned: readonly string[] | undefined,
  startedAt: number | undefined,
  privateNames: readonly string[],
  root: string = skillsLibraryRoot(),
): string {
  if (!assigned?.length) return "";
  const withheld = withheldForConversation(botId, startedAt, root);
  if (!withheld.size) return "";
  const notes = readJsonRecord(shareNotesPath(root));
  const noted = new Set(Array.isArray(notes[botId]?.[threadId]) ? (notes[botId]![threadId] as unknown[]).filter((name): name is string => typeof name === "string") : []);
  const shadowed = new Set(privateNames);
  const assignedNow = new Set(assigned);
  const fresh = listLibrarySkills(root).filter((skill) =>
    skill.enabled && withheld.has(skill.name) && assignedNow.has(skill.name) && !noted.has(skill.name) && !shadowed.has(skill.name));
  if (!fresh.length) return "";
  notes[botId] = { ...notes[botId], [threadId]: sortedUnique([...noted, ...fresh.map((skill) => skill.name)]) };
  writeJsonRecord(root, shareNotesPath(root), notes);
  return `\n\n${fresh.map((skill) =>
    `New team skill available: ${skill.name} — ${skill.description} Read ${JSON.stringify(librarySkillFilePath(skill.name, root))} with your file tools before a task it covers.`,
  ).join("\n")}`;
}

// --- sharing -------------------------------------------------------------

function assignTeam(args: {
  author: ShareBot;
  bots: readonly ShareBot[];
  name: string;
  patchAssigned: PatchAssigned;
  at: number;
  root: string;
  assignAuthor: boolean;
}): Pick<SkillShareRecord, "assigned" | "skipped"> {
  const assigned: SkillShareRecord["assigned"] = [];
  const skipped: SkillShareRecord["skipped"] = [];
  const recorded: Array<{ botId: string; name: string; at: number }> = [];
  if (args.assignAuthor && !args.author.assignedSkills?.includes(args.name)) {
    args.patchAssigned(args.author.id, sortedUnique([...(args.author.assignedSkills ?? []), args.name]));
    assigned.push({ botId: args.author.id, name: args.author.name });
  }
  for (const mate of teammatesOf(args.author, args.bots)) {
    if (listSkills(mate.id).some((skill) => skill.name === args.name)) {
      skipped.push({ botId: mate.id, name: mate.name, reason: `has its own skill named "${args.name}"` });
      continue;
    }
    if (mate.assignedSkills?.includes(args.name)) continue;
    args.patchAssigned(mate.id, sortedUnique([...(mate.assignedSkills ?? []), args.name]));
    assigned.push({ botId: mate.id, name: mate.name });
    recorded.push({ botId: mate.id, name: args.name, at: args.at });
  }
  recordSharedAssignments(args.root, recorded);
  return { assigned, skipped };
}

/** Share one of the author's learned skills with its team. A private copy
 * moves into the library (installed, or deduplicated against identical
 * bytes already there); a learned library skill already assigned to the
 * author is only assigned onward. Every refusal returns `{ error }` and
 * leaves the skill exactly where it was. */
export function shareLearnedSkill(args: {
  author: ShareBot;
  bots: readonly ShareBot[];
  name: string;
  patchAssigned: PatchAssigned;
  now?: number;
  root?: string;
}): SkillShareRecord | { error: string } {
  const root = args.root ?? skillsLibraryRoot();
  const at = args.now ?? Date.now();
  const { author, name } = args;
  const copy = listMigratableSkills(author.id).find((skill) => skill.name === name);
  let library: SkillShareRecord["library"];
  if (copy) {
    if (!copy.source.startsWith(LEARN_SOURCE_PREFIX)) return { error: `"${name}" was imported, not learned — only learned skills are shared` };
    if (!copy.intact || !copy.directory) return { error: "the stored SKILL.md is missing or changed after review" };
    if (!copy.enabled) return { error: `"${name}" is switched off` };
    let instructions: string;
    try {
      if (readdirSync(copy.directory).some((entry) => entry !== "SKILL.md")) {
        return { error: "the skill has supporting files — the library stores SKILL.md only" };
      }
      instructions = readFileSync(join(copy.directory, "SKILL.md"), "utf8");
    } catch {
      return { error: "could not read the stored SKILL.md" };
    }
    if (sha256Hex(instructions) !== copy.sha256) return { error: "the stored SKILL.md changed after review" };
    const existing = readSkillLibraryIndex(root)[name];
    if (existing && existing.sha256 !== copy.sha256) {
      return { error: `the library already has a different skill named "${name}"` };
    }
    if (existing && existing.reviewState !== "approved") return { error: `the library's "${name}" is switched off` };
    if (!existing) {
      const installed = installLibrarySkill({
        name,
        description: copy.description,
        instructions,
        source: copy.source,
        reviewState: "approved",
        root,
      });
      if ("error" in installed) return installed;
    }
    library = existing ? "deduplicated" : "installed";
    // The migration's order: the assignment is durable before the private
    // copy goes, so a crash in between replays it at the next boot.
    try {
      const pending = readPendingAssignments(root);
      writePendingAssignments({ ...pending, [author.id]: sortedUnique([...(pending[author.id] ?? []), name]) }, root);
      archiveSkillDirectory(copy.directory, libraryArchiveDirectory(root, author.id, name), copy.sha256);
    } catch (error) {
      return { error: `could not move the private copy into the library: ${error instanceof Error ? error.message : String(error)}` };
    }
    const removed = removeManifestEntry(author.id, name, copy.sha256);
    if ("error" in removed) return removed;
  } else {
    const entry = readSkillLibraryIndex(root)[name];
    if (!entry || !author.assignedSkills?.includes(name)) return { error: `no learned skill named "${name}"` };
    if (!entry.source.startsWith(LEARN_SOURCE_PREFIX)) return { error: `"${name}" was imported, not learned — only learned skills are shared` };
    if (entry.reviewState !== "approved") return { error: `the library's "${name}" is switched off` };
    library = "assigned";
  }
  const sha256 = readSkillLibraryIndex(root)[name]?.sha256 ?? "";
  const team = assignTeam({ ...args, at, root, assignAuthor: true });
  if (copy) {
    const pending = readPendingAssignments(root);
    const rest = (pending[author.id] ?? []).filter((entry) => entry !== name);
    if (rest.length) pending[author.id] = rest;
    else delete pending[author.id];
    try {
      writePendingAssignments(pending, root);
    } catch {
      // The pending entry only replays an assignment that already exists.
    }
  }
  skillLibraryEvents.emit("invalidate", { kind: "share", name, botIds: team.assigned.map((bot) => bot.botId) });
  return { library, sha256, sharedAt: at, ...team };
}

/** Update a shared learned skill through the library copy. The bot must
 * have it assigned (and no private skill of that name); the write applies
 * only while the library still holds the version this bot's skills list
 * showed (`expectSha256`, else the current one). Teammates that joined since
 * are assigned too. */
export function updateSharedLearnedSkill(args: {
  bot: ShareBot;
  bots: readonly ShareBot[];
  name: string;
  skillMd: string;
  expectSha256?: string;
  patchAssigned: PatchAssigned;
  now?: number;
  root?: string;
}):
  | { share: SkillShareRecord; previous: { skillMd: string; source: string }; content: string; sha256: string; warnings: string[]; description: string }
  | { error: string } {
  const root = args.root ?? skillsLibraryRoot();
  const at = args.now ?? Date.now();
  const entry = readSkillLibraryIndex(root)[args.name];
  if (!entry || !args.bot.assignedSkills?.includes(args.name)) return { error: `no shared skill named "${args.name}"` };
  if (!entry.source.startsWith(LEARN_SOURCE_PREFIX)) return { error: `skill "${args.name}" was imported — it cannot be rewritten` };
  if (entry.reviewState !== "approved") return { error: `the library's "${args.name}" is switched off` };
  const prepared = prepareLearnedSkillMd(args.skillMd);
  if ("error" in prepared) return prepared;
  if (prepared.name !== args.name) return { error: `updated SKILL.md name must remain "${args.name}"` };
  const previous = readLibrarySkillFile(args.name, root);
  if (previous === null) return { error: "stored SKILL.md changed after review — restore or remove it before proposing an update" };
  const base = args.expectSha256 ?? entry.sha256;
  if (base !== entry.sha256) return { error: `skill "${args.name}" changed since it was read — read it again first` };
  if (prepared.sha256 === entry.sha256) return { error: `skill "${args.name}" already matches the proposed SKILL.md` };
  const updated = updateLibrarySkill({ name: args.name, instructions: prepared.content, expectSha256: base, root });
  if ("stale" in updated) return { error: `skill "${args.name}" changed since it was read — read it again first` };
  if ("error" in updated) return updated;
  const team = assignTeam({ author: args.bot, bots: args.bots, name: args.name, patchAssigned: args.patchAssigned, at, root, assignAuthor: false });
  skillLibraryEvents.emit("invalidate", { kind: "share", name: args.name, botIds: team.assigned.map((bot) => bot.botId) });
  return {
    share: { library: "updated", sha256: prepared.sha256, sharedAt: at, ...team },
    previous: { skillMd: previous, source: entry.source },
    content: prepared.content,
    sha256: prepared.sha256,
    warnings: prepared.warnings,
    description: prepared.description,
  };
}

/** Undo a share recorded on a receipt: the library write is reverted (a
 * skill this share put in the library leaves it again; an update gets its
 * previous SKILL.md back) and every assignment the share made is removed.
 * Only while the library copy is exactly what the change left; otherwise
 * `stale` and nothing changes. */
export function undoSharedLearnedSkill(args: {
  authorId: string;
  name: string;
  action: "create" | "update";
  share: SkillShareRecord;
  previous?: { skillMd: string; source: string };
  bots: readonly ShareBot[];
  patchAssigned: PatchAssigned;
  root?: string;
}): { undone: true } | { stale: true } | { error: string } {
  const root = args.root ?? skillsLibraryRoot();
  const entry = readSkillLibraryIndex(root)[args.name];
  if (!entry || entry.sha256 !== args.share.sha256 || readLibrarySkillFile(args.name, root) === null) return { stale: true };
  const { library } = args.share;
  let unassign = args.share.assigned.map((bot) => bot.botId);
  if (library === "installed" && args.action === "create") {
    const retired = retireLibrarySkill(args.name, args.share.sha256, root);
    if (!("retired" in retired)) return retired;
  } else if ((library === "installed" && args.action === "update") || library === "updated") {
    if (!args.previous) return { error: "This change can't be undone here." };
    const restored = updateLibrarySkill({ name: args.name, instructions: args.previous.skillMd, expectSha256: args.share.sha256, source: args.previous.source, root });
    if (!("name" in restored)) return restored;
    // The author keeps the skill it had before this update.
    if (library === "installed") unassign = unassign.filter((botId) => botId !== args.authorId);
  } else if (args.action === "update") {
    return { error: "This change can't be undone here." };
  }
  const targets = new Set(unassign);
  for (const bot of args.bots) {
    if (!targets.has(bot.id) || !bot.assignedSkills?.includes(args.name)) continue;
    args.patchAssigned(bot.id, bot.assignedSkills.filter((name) => name !== args.name));
  }
  recordSharedAssignments(root, [...targets].map((botId) => ({ botId, name: args.name, at: null })));
  skillLibraryEvents.emit("invalidate", { kind: "unshare", name: args.name, botIds: [...targets] });
  return { undone: true };
}

/** Whether a library skill is one this bot may update through sharing: a
 * learned skill assigned to it that no private skill shadows. */
export function sharedSkillEditable(botId: string, assigned: readonly string[] | undefined, name: string, root: string = skillsLibraryRoot()): boolean {
  if (!assigned?.includes(name)) return false;
  if (listSkills(botId).some((skill) => skill.name === name)) return false;
  const entry = readSkillLibraryIndex(root)[name];
  return Boolean(entry && entry.source.startsWith(LEARN_SOURCE_PREFIX) && entry.reviewState === "approved" && existsSync(join(root, "skills", name, "SKILL.md")));
}
