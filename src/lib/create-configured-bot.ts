import { api, desktopApprovalBridge, persistBotUpdate, persistTaskApproval, type Bot } from "@/state/store";
import type { Routine } from "./routines";
import type { BotCreationDraft } from "./bot-creation-draft";
import { imageAttachmentFromFile } from "./composer-attachments";
import type { BotVisibility } from "../../shared/wire";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";

export async function preparedBotTemplate(draft: BotCreationDraft) {
  const template = draft.export();
  if (template.profile.avatarUrl?.startsWith("blob:")) {
    if (!draft.avatarFile) throw new Error("Choose the avatar image again");
    const uploaded = await imageAttachmentFromFile(draft.avatarFile);
    const avatarUrl = uploaded && botAvatarUrlFromStoredPath(uploaded.path);
    if (!avatarUrl) throw new Error("Could not store the avatar image");
    template.profile.avatarUrl = avatarUrl;
  }
  return template;
}

/** Create only after the user commits. File setup and native consent finish
 * before Chief handover or routine activation can affect other work. */
export async function createConfiguredBot(
  draft: BotCreationDraft,
  request: typeof api = api,
  update: typeof persistBotUpdate = persistBotUpdate,
  approvals = desktopApprovalBridge(),
  visibility?: BotVisibility,
): Promise<{ bot: Bot; warnings: string[] }> {
  const template = await preparedBotTemplate(draft);
  const { chiefOfStaff, managedSections, toolScope, ...profile } = template.profile;
  if (!profile.name?.trim()) throw new Error("Give the bot a name");
  // The server adds a chosen preset's skills (switched on only for an
  // organization's preset) and starter notes; for the same skill name or
  // note file, the preset's wins over the draft's.
  const preset = draft.preset;
  const response = await request<{ bot: Bot }>("/api/bots", {
    method: "POST", body: JSON.stringify({ name: profile.name, title: profile.title,
      description: profile.description, modelSelection: profile.modelSelection, section: profile.section,
      requireAvailableModel: true, useDefaults: false, ...(visibility !== undefined ? { visibility } : {}),
      ...(Object.hasOwn(template.profile, "toolScope") ? { settings: { toolScope } } : {}),
      ...(preset ? { preset: preset.id } : {}) }),
  });
  let bot = response.bot;
  const routines: Array<{ id: string; enabled: boolean }> = [];
  const warnings: string[] = [];
  try {
    // The create endpoint already validated the chosen model and completed
    // workspace effort defaults. Do not overwrite those with the raw draft.
    const patched = await update(bot.id, { ...profile, modelSelection: bot.modelSelection, ...draft.consent }, new AbortController().signal,
      request, approvals, bot);
    bot = { ...bot, ...patched };
    if (profile.approvalMode === "full" || profile.approvalMode === "custom") {
      // persistBotUpdate sets the bot default first. An initial thread is
      // already present, so it takes the level in its own write: through the
      // desktop's private bridge when there is one, over the API for Full
      // when there is not (Custom cannot get this far without the bridge).
      if (patched.approvalMode !== profile.approvalMode) {
        throw new Error("The bot's requested approval level was not granted");
      }
      const granted = await persistTaskApproval(bot.id, bot.threadId, {
        approvalMode: profile.approvalMode,
        acknowledgeLocalAuto: draft.consent.acknowledgeLocalAuto === true,
      }, approvals, request);
      if (granted.approvalMode !== profile.approvalMode) {
        throw new Error("The initial thread's requested approval level was not granted");
      }
    }
    for (const [path, text] of Object.entries(template.memory)) {
      if (preset?.notes.includes(path)) continue;
      await request(`/api/bots/${bot.id}/memory/file`, {
        method: "PUT", body: JSON.stringify({ path, text }),
      });
    }
    for (const skill of template.skills) {
      if (preset?.skills.includes(skill.name)) continue;
      await request(`/api/bots/${bot.id}/skill-template`, { method: "POST", body: JSON.stringify(skill) });
    }
    for (const routine of template.routines) {
      const result = await request<{ routine: Routine }>("/api/routines", {
        method: "POST", body: JSON.stringify({ ...routine, botId: bot.id, enabled: false }),
      });
      routines.push({ id: result.routine.id, enabled: routine.enabled !== false });
    }
  } catch (error) {
    const cleanup: string[] = [];
    for (const routine of routines) {
      try { await request(`/api/routines/${routine.id}`, { method: "DELETE" }); }
      catch { cleanup.push(`routine ${routine.id}`); }
    }
    try { await request(`/api/bots/${bot.id}`, { method: "DELETE" }); }
    catch { cleanup.push(`bot ${bot.name} (${bot.id})`); }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(cleanup.length ? `${message}. Cleanup failed for ${cleanup.join(", ")}; remove them before retrying.` : message);
  }
  // Creation is complete. Activation failures leave a visible, configured
  // bot with paused routines; never delete a bot whose routine may have run,
  // undo a Chief handover, or invite a duplicate creation retry.
  if (chiefOfStaff) {
    try {
      const result = await request<{ bot: Bot }>(`/api/bots/${bot.id}`, {
        method: "PATCH", body: JSON.stringify({ chiefOfStaff, managedSections, acknowledgePeerScope: true }),
      });
      bot = { ...bot, ...result.bot };
    } catch (error) {
      warnings.push(`Review this bot's Chief of Staff setting: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const routine of routines.filter(routine => routine.enabled)) {
    try { await request(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }); }
    catch (error) { warnings.push(`Could not activate a routine: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { bot, warnings };
}
