// The names of the agents catalog's tools, and the name a call made through
// the tool bridge (drivers/agents-bridge.ts) is read as: the tool it ran.
//
// Kept apart from the switch (agents-bridge-switch.ts), which reads engine
// drivers to decide. The Activity log loads this, and nothing here imports a
// driver.
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../shared/options-card.ts";

import { bridgedCallTitle } from "./drivers/agents-bridge.ts";
import { availableTools } from "./drivers/agents-catalog.ts";

/** Every tool of today's catalog, whoever may call it. */
export const CATALOG_TOOL_NAMES: ReadonlySet<string> = new Set(availableTools({
  skillAuthoring: true, sharedComputers: true, voiceNotes: true, cloudHome: false, chief: true, botId: WATCHER_OPTIONS_CARD_BOT_ID,
}).map((tool) => tool.name));

/** A tool call's name with a bridged call read as the tool it ran, from what
 * the call itself carries: its title and its arguments, or the preview of
 * them an event keeps. A use_tool call that names one of the catalog's tools
 * reads as that tool, in the engine's own spelling; anything else keeps its
 * name.
 *
 * `serverNamed` asks for a title that itself says the agents server
 * (`mcp__agents__use_tool`, `agents_use_tool`). A reader that knows nothing
 * else about the call (the Activity log, built from the event log after the
 * fact) passes it, and leaves a bare `use_tool` alone: on an engine that
 * names a tool without its server (Codex) that could be any server's. */
export function bridgedCallName(title: string, input: unknown, options: { serverNamed?: boolean } = {}): string {
  return bridgedCallTitle(title, input, (name) => CATALOG_TOOL_NAMES.has(name), options.serverNamed !== true);
}
