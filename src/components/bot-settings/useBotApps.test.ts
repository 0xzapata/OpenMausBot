import { afterAll, describe, expect, it, vi } from "vitest";

import type { ToolkitCard } from "../PluginsPanel";

// PluginsPanel reads `window` when it loads; the src suite runs without one.
vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterAll(() => vi.unstubAllGlobals());

const { botAppsFrom } = await import("./useBotApps");

const card = (slug: string, label: string): ToolkitCard => ({ slug, label, blurb: `${label} things`, logo: `https://logo.test/${slug}.png`, domain: `${slug}.com` });
const cards = new Map([card("gmail", "Gmail"), card("slack", "Slack")].map((entry) => [entry.slug, entry]));
const inventory = (connected: Record<string, boolean>, authoritative = true) => ({
  authoritative,
  services: Object.fromEntries(Object.entries(connected).map(([slug, on]) => [slug, { connected: on }])),
});

describe("the connected apps as one bot sees them", () => {
  it("is still checking until the account list has loaded", () => {
    expect(botAppsFrom({}, null, cards)).toEqual({ phase: "loading", apps: [], connectedSlugs: [] });
  });

  it("says it does not know, rather than nothing is connected, when the account store could not be read", () => {
    expect(botAppsFrom({}, inventory({ gmail: true }, false), cards)).toEqual({ phase: "unknown", apps: [], connectedSlugs: [] });
  });

  it("lists only connected apps, in name order, with the catalog's name and mark", () => {
    const { phase, apps, connectedSlugs } = botAppsFrom({}, inventory({ slack: true, notion: false, gmail: true }), cards);
    expect(phase).toBe("ready");
    expect(connectedSlugs).toEqual(["gmail", "slack"]);
    expect(apps.map((app) => [app.slug, app.label, app.blurb, app.scope])).toEqual([
      ["gmail", "Gmail", "Gmail things", "write"],
      ["slack", "Slack", "Slack things", "write"],
    ]);
    expect(apps[0]!.card).toEqual({ logo: "https://logo.test/gmail.png", domain: "gmail.com", label: "Gmail" });
  });

  it("names an app by its slug until the catalog knows it", () => {
    const [app] = botAppsFrom({}, inventory({ google_calendar: true }), new Map()).apps;
    expect(app).toMatchObject({ slug: "google_calendar", label: "Google calendar", blurb: "", card: { logo: null, domain: null } });
  });

  it("reads each app's switch from the bot: scoped, read-only, or all off", () => {
    const connected = inventory({ gmail: true, slack: true });
    const scoped = botAppsFrom({ connectorScopes: { apps: { gmail: "read" } } }, connected, cards).apps;
    expect(scoped.map((app) => app.scope)).toEqual(["read", null]);
    const off = botAppsFrom({ composio: false }, connected, cards).apps;
    expect(off.map((app) => app.scope)).toEqual([null, null]);
  });
});
