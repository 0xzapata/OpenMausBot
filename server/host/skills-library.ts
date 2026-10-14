// The skills library on the host (features.skillsLibrary): a bot's skills
// merged with its library assignments, and sharing learned skills with the
// team (features.shareLearnedSkills) as server/index.ts wires it into turns,
// the automatic skill review, skill_manage, receipts and their Undo. The
// library and assignment rules live in server/skill-library.ts and
// server/skill-share.ts; this module binds them to the store.
//
// Prompt-cache safety: a conversation's skills index lists only what was
// assigned before it started (conversationSkills), and a skill shared later
// reaches it once as a note on its next user turn (shareNote), recorded as
// delivered only after the provider accepted that turn.
import { randomUUID } from "node:crypto";

import type { SkillRequestCardData, SkillShareRecord } from "../../shared/skill-request.ts";
import { narrowestAudience, intersectAudience } from "../bot-visibility.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE, type DirectApply } from "../direct-apply.ts";
import { redactSecretsInText } from "../redact.ts";
import { readLibrarySkillFile, readSkillLibraryIndex, skillsLibraryEnabled } from "../skill-library.ts";
import {
  conversationAssignedSkills,
  prepareShareNote,
  shareLearnedSkill,
  shareLearnedSkillsMode,
  SHARED_REVISION_CHARS,
  sharedSkillEditable,
  undoSharedLearnedSkill,
  updateSharedLearnedSkill,
  type ShareBot,
} from "../skill-share.ts";
import { listSkills, readSkillFile, resolveBotSkills, type SkillListing } from "../skills.ts";
import type { BotRecord, Message, Store } from "../store.ts";

/** One receipt card, as appendSkillRequestCard writes it. */
type ReceiptArgs = {
  botId: string;
  threadId: string;
  applied?: boolean;
  previous?: SkillRequestCardData["previous"];
  shared?: SkillShareRecord;
  staged: {
    id: string;
    action: "create" | "update";
    name: string;
    gist: string;
    source: string;
    files: Array<{ path: string; content: string }>;
    sha256: string;
    warnings: string[];
  };
};

export interface SkillsLibraryHostDeps {
  store: Store;
  cfg: AppConfig;
  appendSkillRequestCard(args: ReceiptArgs): { requestId: string; summary: string };
}

type UndoResult =
  | { claimed: true; state: "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

/** A turn's share note: its text, and a wrapper for the provider dispatch
 * that records the note as delivered once the provider accepted it. */
export interface TurnShareNote {
  text: string;
  after<T>(dispatch: Promise<T>): Promise<T>;
}

const NO_TURN_NOTE: TurnShareNote = { text: "", after: (dispatch) => dispatch };

export function createSkillsLibraryHost(deps: SkillsLibraryHostDeps) {
  const { store, cfg } = deps;
  const mode = () => shareLearnedSkillsMode(cfg);

  // Skills library (features.skillsLibrary). While the flag is off both
  // helpers reduce exactly to today's per-bot calls; assignments recorded on
  // bot records stay inert until it is on.
  const listBotSkills = (bot: BotRecord) =>
    skillsLibraryEnabled(cfg) ? resolveBotSkills(bot.id, bot.assignedSkills) : listSkills(bot.id);
  const readBotSkillFile = (bot: BotRecord, name: string): string | null => {
    const own = readSkillFile(bot.id, name);
    if (own !== null || !skillsLibraryEnabled(cfg)) return own;
    // A private listing whose stored bytes no longer verify must not fall
    // through to a same-named library skill: private wins collisions, so a
    // broken private file stays unreadable instead of exporting another
    // bot's library instructions under this bot's name.
    if (listSkills(bot.id).some((skill) => skill.name === name)) return null;
    // The library fallback is by assignment only, never by name alone.
    if (!bot.assignedSkills?.includes(name)) return null;
    return readLibrarySkillFile(name);
  };

  const shareBotsNow = (): ShareBot[] =>
    store.bots.map((bot) => ({ id: bot.id, name: bot.name, section: bot.section, assignedSkills: bot.assignedSkills, visibility: bot.visibility }));
  const patchAssigned = (botId: string, assignedSkills: string[]) => {
    store.patchBot(botId, { assignedSkills });
  };
  /** Who could see the conversation a skill came from: the bot's audience,
   * narrowed to the room's (its bots and its floor) when it is a room. */
  const sourceAudience = (bot: { visibility?: unknown }, threadId?: string): unknown => {
    const room = threadId ? store.groupByThread(threadId) : undefined;
    if (!room) return bot.visibility;
    const members = room.memberIds.flatMap((id) => {
      const member = store.bot(id);
      return member ? [member.visibility] : [];
    });
    return intersectAudience(bot.visibility, narrowestAudience([room.audienceFloor, ...members]));
  };
  /** When a conversation started: its first message's time; none = new. */
  const conversationStartedAt = (threadId: string): number | undefined => store.messagesFor(threadId)[0]?.at;
  // read live: an assignment PUT during awaited turn setup still counts
  const liveAssigned = (bot: BotRecord) => store.bot(bot.id)?.assignedSkills ?? bot.assignedSkills;

  /** Whether an update to `name` goes to the shared library copy. */
  const editable = (botId: string, name: string): boolean =>
    mode() !== "off" && sharedSkillEditable(botId, store.bot(botId)?.assignedSkills, name);

  /** The share as one sentence, for the bot that learned the skill. */
  function summaryLine(share: SkillShareRecord): string {
    const mates = share.assigned.map((bot) => bot.name);
    const skipped = share.skipped.map((bot) => `${bot.name} (${bot.reason})`);
    return [
      mates.length ? `Shared with ${mates.join(", ")}.` : "No teammate needed it assigned.",
      skipped.length ? `Not shared with ${skipped.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
  }

  /** Share one of a bot's learned skills with its team and, given its
   * receipt, record the outcome there so Undo reverts it too. */
  function shareFromBot(
    botId: string,
    name: string,
    receipt?: { threadId: string; messageId: string; expectSha256?: string },
  ): SkillShareRecord | { error: string; stale?: true } {
    const bots = shareBotsNow();
    const author = bots.find((bot) => bot.id === botId);
    if (!author) return { error: "unknown bot" };
    const shared = shareLearnedSkill({
      author, bots, name, patchAssigned,
      audience: sourceAudience(author, receipt?.threadId),
      ...(receipt?.expectSha256 ? { expectSha256: receipt.expectSha256 } : {}),
    });
    // a receipt for a version that changed since keeps its card as it was
    if (receipt && !("stale" in shared)) {
      const message = store.messagesFor(receipt.threadId).find((candidate) => candidate.id === receipt.messageId);
      const card = message?.card;
      const request = card?.skillRequest;
      if (card && request) {
        const { shareError: _shareError, ...rest } = request;
        store.patchMessage(receipt.threadId, receipt.messageId, {
          card: { ...card, skillRequest: "error" in shared ? { ...request, shareError: shared.error } : { ...rest, shared } },
        });
      }
    }
    return shared;
  }

  /** Update a shared learned skill through its library copy, with the same
   * one-line receipt and Undo a private update gets. */
  function applySharedUpdate(
    from: BotRecord,
    threadId: string,
    change: { name: string; skillMd: string; gist?: string; expectSha256: string | undefined },
    direct: DirectApply,
  ): { name: string; summary: string; shared: string } | { error: string } {
    const bots = shareBotsNow();
    const self = bots.find((bot) => bot.id === from.id);
    if (!self) return { error: "unknown bot" };
    if (!change.expectSha256) {
      return { error: `skill "${change.name}" is shared with your team: call skills_list, read the skill, and pass the revision it lists as base_revision` };
    }
    const updated = updateSharedLearnedSkill({
      bot: self,
      bots,
      name: change.name,
      skillMd: change.skillMd,
      expectSha256: change.expectSha256,
      patchAssigned,
      assignOnward: mode() === "auto",
      audience: sourceAudience(self, threadId),
    });
    if ("error" in updated) return updated;
    const gist = redactSecretsInText(change.gist ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || updated.description.slice(0, 240);
    const receipt = deps.appendSkillRequestCard({
      botId: from.id,
      threadId,
      applied: true,
      previous: { preview: updated.previous.skillMd, source: updated.previous.source },
      shared: updated.share,
      staged: {
        id: randomUUID(),
        action: "update",
        name: change.name,
        gist,
        source: updated.previous.source,
        files: [{ path: "SKILL.md", content: updated.content }],
        sha256: updated.sha256,
        warnings: updated.warnings,
      },
    });
    appendDecision(DATA_DIR, { threadId, requestId: receipt.requestId, botId: from.id, botName: from.name,
      tool: "stage_skill", summary: receipt.summary, decision: "auto-approved", source: direct });
    return { name: change.name, summary: `Shared skill ${change.name} updated.`, shared: summaryLine(updated.share) };
  }

  return {
    listBotSkills,
    readBotSkillFile,

    /** features.shareLearnedSkills: "off" | "ask" | "auto". */
    mode,

    /** The library assignments one conversation's skills index lists. A
     * skill shared into this bot after the conversation started stays out,
     * so a teammate's share never changes this conversation's system prompt
     * and its cached prefix survives. Flag off: undefined, the per-bot
     * listing exactly as before. */
    /** When the conversation began, for skillsSystemPrompt: a library skill
     * keeps the description it had then. */
    conversationStartedAt,

    conversationSkills(bot: BotRecord, threadId: string): string[] | undefined {
      if (!skillsLibraryEnabled(cfg)) return undefined;
      return conversationAssignedSkills(bot.id, liveAssigned(bot), conversationStartedAt(threadId));
    },

    /** The one-time "new team skill" note for this turn's user text; empty
     * where the turn has no workspace (`enabled` false). */
    shareNote(bot: BotRecord, threadId: string, enabled: boolean): TurnShareNote {
      if (!enabled || !skillsLibraryEnabled(cfg)) return NO_TURN_NOTE;
      try {
        const note = prepareShareNote(bot.id, threadId, liveAssigned(bot), conversationStartedAt(threadId), listSkills(bot.id).map((skill) => skill.name));
        if (!note.text) return NO_TURN_NOTE;
        return { text: note.text, after: (dispatch) => dispatch.then((value) => { commitNote(note.commit); return value; }) };
      } catch (error) {
        console.warn(`[skills-library] could not prepare the shared-skill note: ${errorText(error)}`);
        return NO_TURN_NOTE;
      }
    },

    /** The automatic review's skill list plus the shared team skills it may
     * improve (an update rewrites the library copy). */
    reviewSkills<T extends { name: string }>(botId: string, own: T[]): Array<T | {
      name: string; description: string; editable: boolean; enabled: boolean; sha256: string; body?: string | null;
    }> {
      const bot = store.bot(botId);
      if (mode() === "off" || !bot?.assignedSkills?.length) return own;
      const ownNames = new Set(own.map((skill) => skill.name));
      const shared = resolveBotSkills(botId, bot.assignedSkills)
        .filter((skill) => !ownNames.has(skill.name))
        .map((skill) => {
          const canEdit = editable(botId, skill.name);
          return { name: skill.name, description: skill.description, editable: canEdit, enabled: skill.enabled, sha256: skill.sha256,
            ...(canEdit ? { body: readLibrarySkillFile(skill.name) } : {}) };
        });
      return [...own, ...shared];
    },

    /** A shared skill's current library hash, for the review's stale check. */
    sharedSha: (botId: string, name: string): string | null =>
      editable(botId, name) ? readSkillLibraryIndex()[name]?.sha256 ?? null : null,

    editable,

    /** The automatic review's update of a shared skill. */
    applyReviewUpdate(bot: BotRecord, threadId: string, change: { name: string; skillMd: string; gist: string; baseSha256?: string }, direct: DirectApply):
      { ok: true } | { ok: false; error: string } {
      const updated = applySharedUpdate(bot, threadId, {
        name: change.name, skillMd: change.skillMd, gist: change.gist || undefined, expectSha256: change.baseSha256,
      }, direct);
      return "error" in updated ? { ok: false, error: updated.error } : { ok: true };
    },

    /** skill_manage's update of a shared skill (`editable`): the response's
     * status and body. */
    harnessUpdate(from: BotRecord, threadId: string, name: string, skillMd: string, gist: unknown, baseRevision: unknown, direct: DirectApply | null):
      [status: number, body: Record<string, unknown>] {
      if (!direct) return [422, { state: "failed", error: "this conversation cannot update a shared team skill" }];
      const updated = applySharedUpdate(from, threadId, {
        name, skillMd, gist: typeof gist === "string" ? gist : undefined, expectSha256: typeof baseRevision === "string" ? baseRevision : undefined,
      }, direct);
      if ("error" in updated) return [422, { state: "failed", error: updated.error }];
      return [201, { state: "applied", name: updated.name, action: "update", summary: updated.summary, shared: updated.shared }];
    },

    /** skill_manage's list: shared team skills this bot may update are
     * editable, with the revision an update must name (base_revision). */
    harnessListing(botId: string, skills: SkillListing[]): Array<SkillListing & { revision?: string }> {
      if (mode() === "off") return skills;
      return skills.map((skill) => !skill.editable && editable(botId, skill.name)
        ? { ...skill, editable: true, revision: skill.sha256.slice(0, SHARED_REVISION_CHARS) }
        : skill);
    },

    /** After a bot's own learned skill applied: features.shareLearnedSkills
     * "auto" shares it now. A settlement still pending keeps its stage record
     * bound to the private copy, so that one waits for the receipt's Share
     * button instead. */
    afterOwnApply<T extends { settlementPending?: boolean }>(botId: string, threadId: string, staged: { id: string; name: string }, applied: T):
      T & { shared?: string; shareError?: string } {
      if (mode() !== "auto" || applied.settlementPending) return applied;
      const receipt = store.messagesFor(threadId).findLast((message) => message.card?.skillRequest?.stagedId === staged.id);
      const shared = shareFromBot(botId, staged.name, receipt ? { threadId, messageId: receipt.id } : undefined);
      return "error" in shared ? { ...applied, shareError: shared.error } : { ...applied, shared: summaryLine(shared) };
    },

    /** "Share with team" on a learned-skill receipt (features.shareLearnedSkills
     * "ask"): the receipt's own skill at the version it applied, once, while
     * it is not undone. */
    shareFromReceipt(threadId: string, requestId: string):
      | { ok: true; shared: SkillShareRecord }
      | { ok: false; status: number; error: string } {
      if (mode() === "off") return { ok: false, status: 404, error: "sharing learned skills is not enabled" };
      const message = store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId);
      const card = message?.card;
      const request = card?.skillRequest;
      if (!message || !card || !request) return { ok: false, status: 404, error: "this skill is no longer in the conversation" };
      if (!card.autoApplied || card.answered !== "allow" || card.undone) {
        return { ok: false, status: 409, error: "only a skill change that applied and was not undone can be shared" };
      }
      if (request.shared) return { ok: true, shared: request.shared };
      const botId = message.from?.botId ?? store.botByThread(threadId)?.id;
      if (!botId || botId !== request.botId) return { ok: false, status: 403, error: "this skill belongs to a different bot" };
      const shared = shareFromBot(botId, request.name, { threadId, messageId: message.id, expectSha256: request.sha256 });
      if ("stale" in shared) return { ok: false, status: 409, error: shared.error };
      return "error" in shared ? { ok: false, status: 422, error: shared.error } : { ok: true, shared };
    },

    shareFromBot,

    /** Undo of a shared skill's receipt: revert the library write and every
     * assignment the share made. Its private copy stays archived. */
    undoReceipt(botId: string, threadId: string, message: Message, request: SkillRequestCardData & { shared: SkillShareRecord }): UndoResult {
      const undone = undoSharedLearnedSkill({
        authorId: botId,
        name: request.name,
        action: request.action,
        share: request.shared,
        ...(request.previous ? { previous: { skillMd: request.previous.preview, source: request.previous.source } } : {}),
        bots: shareBotsNow(),
        patchAssigned,
      });
      if ("stale" in undone) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
      if ("error" in undone) return { claimed: true, state: "invalid", error: undone.error, status: 409 };
      if (message.card) store.patchMessage(threadId, message.id, { card: { ...message.card, undone: true } });
      return { claimed: true, state: "undone" };
    },
  };
}

export type SkillsLibraryHost = ReturnType<typeof createSkillsLibraryHost>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Recording a delivered note never fails the turn that carried it. */
function commitNote(commit: () => void): void {
  try {
    commit();
  } catch (error) {
    console.warn(`[skills-library] could not record the shared-skill note: ${errorText(error)}`);
  }
}
