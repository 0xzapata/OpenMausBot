// The connected apps as one bot sees them, for the Simple bot panel: the
// account inventory the Access section already reads (which apps are
// connected), each app's name and mark from the catalog, and whether this bot
// may use it. Read-only here; switches write through the bot patch.
import { useEffect, useState } from "react";

import { botAppScope } from "@/lib/bot-app-access";
import { api, type Bot } from "@/state/store";
import type { ConnectorScope } from "../../../shared/connector-scopes";
import { preloadConnectedApps, type ConnectorInventory, type ToolkitCard } from "../PluginsPanel";

export interface BotApp {
  slug: string;
  label: string;
  blurb: string;
  /** What ServiceIcon draws from: logo, else the domain's favicon, else a monogram. */
  card: Pick<ToolkitCard, "logo" | "domain" | "label">;
  /** null: off for this bot */
  scope: ConnectorScope | null;
}

export interface BotApps {
  /** unknown: the server could not read the account store, so the list is
   * "we do not know" rather than "nothing is connected" */
  phase: "loading" | "ready" | "unknown";
  apps: BotApp[];
  connectedSlugs: string[];
}

// The catalog is the same for every bot and only names things here, so one
// request serves every panel opened in this window. A failed read is retried
// by the next panel; until then apps show under their slug.
let cardsRequest: Promise<Map<string, ToolkitCard>> | null = null;
function loadAppCards(): Promise<Map<string, ToolkitCard>> {
  cardsRequest ??= api("/api/connectors/catalog")
    .then((response: { cards?: ToolkitCard[] }) => new Map((response.cards ?? []).map((card) => [card.slug, card])))
    .catch(() => {
      cardsRequest = null;
      return new Map<string, ToolkitCard>();
    });
  return cardsRequest;
}

/** "googlecalendar" is all a slug gives us; the catalog's label wins when it loads. */
function slugLabel(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[_-]+/g, " ");
}

export function botAppsFrom(
  bot: Pick<Bot, "composio" | "connectorScopes">,
  inventory: ConnectorInventory | null,
  cards: ReadonlyMap<string, ToolkitCard>,
): BotApps {
  if (!inventory) return { phase: "loading", apps: [], connectedSlugs: [] };
  if (!inventory.authoritative) return { phase: "unknown", apps: [], connectedSlugs: [] };
  const connectedSlugs = Object.entries(inventory.services)
    .filter(([, status]) => status.connected)
    .map(([slug]) => slug)
    .sort((a, b) => a.localeCompare(b));
  const apps = connectedSlugs.map((slug) => {
    const card = cards.get(slug);
    const label = card?.label ?? slugLabel(slug);
    return {
      slug,
      label,
      blurb: card?.blurb ?? "",
      card: { logo: card?.logo ?? null, domain: card?.domain ?? null, label },
      scope: botAppScope(bot, slug),
    };
  });
  return { phase: "ready", apps, connectedSlugs };
}

export function useBotApps(bot: Bot): BotApps {
  const [inventory, setInventory] = useState<ConnectorInventory | null>(null);
  const [cards, setCards] = useState<ReadonlyMap<string, ToolkitCard>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    void preloadConnectedApps().then((result) => {
      if (!cancelled) setInventory(result);
    });
    void loadAppCards().then((result) => {
      if (!cancelled) setCards(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return botAppsFrom(bot, inventory, cards);
}
