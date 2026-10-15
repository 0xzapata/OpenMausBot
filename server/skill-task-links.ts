import { syncSkillLinks } from "./skills.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

export function syncTaskSkillLinks(
  botId: string,
  threadId: string,
  options: { beforeRemove?: (link: string) => void } = {},
): void {
  syncSkillLinks(botId, { ...options, task: { threadId, folder: ensureTaskWorkspace(botId, threadId) } });
}

/** The turn's task folder, with the bot's enabled skills linked in. A failed
 * link only loses native discovery; the prompt index still lists them. */
export function ensureTaskWorkspaceWithSkills(botId: string, threadId: string): string {
  try {
    syncTaskSkillLinks(botId, threadId);
  } catch (error) {
    console.warn(`[skills] linking skills into the task folder failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ensureTaskWorkspace(botId, threadId);
}
