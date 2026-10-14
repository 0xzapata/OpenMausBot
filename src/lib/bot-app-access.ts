// Which connected apps one bot may use, as the Simple bot panel's Vault reads
// and writes it: one on/off switch per app. The record underneath is the same
// connectorScopes the Access section edits (shared/connector-scopes.ts), so
// the two views never disagree: absent means every app, read and write; a
// present record lists the apps that are on, and an app missing from it is off.
import type { ConnectorScope, ConnectorScopes } from "../../shared/connector-scopes";

interface AccessBot {
  composio?: boolean;
  connectorScopes?: ConnectorScopes;
}

/** What this bot may do with a connected app, or null when the app is off
 * for it (its own switch, or the bot's connected apps as a whole). */
export function botAppScope(bot: AccessBot, slug: string): ConnectorScope | null {
  if (bot.composio === false) return null;
  if (!bot.connectorScopes) return "write";
  return bot.connectorScopes.apps[slug] ?? null;
}

/** The record after switching one app on or off, or undefined when the
 * switch already says that. Switching the first app off turns "every app"
 * into a list of the other connected apps, so nothing else changes for the
 * bot. From then on the list stays a list: an app connected later is off
 * until it is switched on here. A read-only app keeps its scope. */
export function withBotApp(
  scopes: ConnectorScopes | undefined,
  connected: readonly string[],
  slug: string,
  on: boolean,
): ConnectorScopes | undefined {
  if (!scopes) {
    if (on) return undefined;
    const apps: Record<string, ConnectorScope> = {};
    for (const other of connected) if (other !== slug) apps[other] = "write";
    return { apps };
  }
  const apps = { ...scopes.apps };
  if (on) {
    if (apps[slug]) return undefined;
    apps[slug] = "write";
  } else {
    if (!apps[slug]) return undefined;
    delete apps[slug];
  }
  return { apps };
}
