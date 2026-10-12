import { t } from "./i18n";

export interface FeatureFlagConfig {
  features?: { skillAuthoring?: boolean; skillReview?: boolean; skillReviewSteps?: number; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; routinesInConversation?: boolean; llmThreadTitles?: boolean; skillsLibrary?: boolean; roomMemoryCapture?: boolean };
  browserEngine?: { kind: "engine" | "unavailable"; reason?: string; installable?: boolean; installing?: boolean; installError?: string };
}

/** Whether this server can give a bot a browser: the agent-browser engine is
 * installed there. Servers from before the engine report nothing: no browser. */
export function browserAvailable(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.browserEngine?.kind === "engine";
}

/** Why a bot cannot have a browser right now, in the user's words. */
export function browserUnavailableReason(config: FeatureFlagConfig | null | undefined): string {
  const engine = config?.browserEngine;
  if (engine?.kind === "unavailable" && engine.installable) return t("browser.notInstalled");
  if (engine?.kind === "unavailable" && engine.reason) return engine.reason;
  return t("browser.noEngine");
}

/** Bots may draft skills (the Verify card's Save as skill, /learn,
 * skill_manage) for the user's review. On unless the Settings toggle was
 * switched off — the same rule as the server's skillAuthoringEnabled. */
export function skillAuthoringEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillAuthoring !== false;
}

export const DEFAULT_SKILL_REVIEW_STEPS = 10;
export const MIN_SKILL_REVIEW_STEPS = 3;
export const MAX_SKILL_REVIEW_STEPS = 100;

/** Learn skills automatically: a background review after enough tool steps
 * may create or update the bot's own learned skills. Off unless switched
 * on, and never while skill authoring is off — mirrors the server's
 * skillReviewEnabled. */
export function skillReviewEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return skillAuthoringEnabled(config) && config?.features?.skillReview === true;
}

/** Tool steps between automatic reviews (server default 10, 3–100). */
export function skillReviewSteps(config: FeatureFlagConfig | null | undefined): number {
  const raw = config?.features?.skillReviewSteps;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_SKILL_REVIEW_STEPS;
  return Math.min(MAX_SKILL_REVIEW_STEPS, Math.max(MIN_SKILL_REVIEW_STEPS, value));
}

/** The engines bots on this server use that cannot run the skill review,
 * by name: it needs a quick background model call and the agents tools,
 * the same two the server checks (server/index.ts, createSkillReview). */
export function skillReviewUnavailableEngines(
  bots: ReadonlyArray<{ modelSelection?: { instanceId?: string } }>,
  instances: ReadonlyArray<{ instanceId: string; displayName: string; capabilities?: { backgroundText?: boolean; agentsMcp?: boolean } }>,
): string[] {
  const used = new Set(bots.map((bot) => bot.modelSelection?.instanceId).filter(Boolean));
  return [...new Set(instances
    .filter((instance) => used.has(instance.instanceId))
    .filter((instance) => instance.capabilities?.backgroundText !== true || instance.capabilities?.agentsMcp !== true)
    .map((instance) => instance.displayName))];
}

/** The review threshold the person typed, or null when it is not a whole
 * number in range. */
export function parseSkillReviewSteps(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const steps = Number(trimmed);
  return steps >= MIN_SKILL_REVIEW_STEPS && steps <= MAX_SKILL_REVIEW_STEPS ? steps : null;
}

/** The experimental built-in browser is unavailable until the person using
 * the app explicitly opts in. Each bot also has its own switch. */
export function builtInBrowserEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.browser === true;
}

/** Tool-run chips in the transcript. Off by default — the mascot already
 * shows that work is happening. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}

/** Routine turns are written into the conversation that receives the run card.
 * Off by default — the run stays in a hidden thread and the chat only gets the card. */
export function routinesInConversationEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.routinesInConversation === true;
}

/** Opt-in computer sharing — lending this desktop's folders, terminal or
 * computer control to a connected workspace. Off unless this server was
 * explicitly switched on in its config.json; there is no Settings toggle, so
 * the controls simply are not offered. */
export function sharedComputersEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.sharedComputers === true;
}

/** Claude bots also see the MCP servers of this machine's own Claude Code
 * setup (Plugins → MCP servers). Off by default — every extra tool costs
 * tokens on each message — and mirrors the server's claudeUserMcpEnabled. */
export function claudeUserMcpEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.claudeUserMcp === true;
}

/** Generated thread titles, and with them the thread menu's Regenerate
 * title. Off unless this server was switched on in its config.json; mirrors
 * the server's llmThreadTitlesEnabled. */
export function llmThreadTitlesEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.llmThreadTitles === true;
}

/** The Skills surface (a shared library of SKILL.md files every bot can be
 * assigned from) is off until the server's config.json switches it on —
 * mirroring the server's skillsLibraryEnabled. */
export function skillsLibraryEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillsLibrary === true;
}

/** Learn from group chats: memory upkeep also reads a member bot's room
 * turns. Off until switched on (a bot's Memory settings) — mirrors the
 * server's roomMemoryCaptureEnabled. */
export function roomMemoryCaptureEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.roomMemoryCapture === true;
}
