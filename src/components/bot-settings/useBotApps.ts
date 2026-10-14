import { useEffect, useState } from "react";

import { botAppScope } from "@/lib/bot-app-access";
import { api, type Bot } from "@/state/store";
import type { ConnectorScope } from "../../../shared/connector-scopes";
import { preloadConnectedApps, type ConnectorInventory, type ToolkitCard } from "../PluginsPanel";

export interface BotApp {
  slug: string;
  label: string;
  blurb: string;
  card: Pick<ToolkitCard, "logo" | "domain" | "label">;
  scope: ConnectorScope | null;
}

export interface BotApps {
  phase: "loading" | "ready" | "unknown";
  apps: BotApp[];
  connectedSlugs: string[];
}

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
