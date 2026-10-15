import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudTrial } from "../../electron/cloud-home.mjs";
import { withTourFinished } from "@/lib/guided-tour";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, type WelcomeViewer } from "@/lib/onboarding";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, dispatch: null as any, brand: "default" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn(), identifyEmail: vi.fn() }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
vi.mock("@/lib/brand", () => ({ brandStatus: () => ({ brand: { name: "OpenMausBot" }, source: f.brand, file: "" }) }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { snapshot: { state: string; authenticated?: boolean } }) =>
  instance.snapshot.state === "available" && instance.snapshot.authenticated !== false }));
import { AppNotices } from "./AppNotices";
import { CLOUD_NOTICE_DISMISSED } from "./CloudNotice";
import { CLOUD_PRO_UPDATE_NOTICE, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, CLOUD_INTRO, localDay, STAR_NOTICE } from "@/lib/notices";
import { identifyEmail, track } from "@/lib/analytics";
import { api } from "@/state/store";

const DAY = 86_400_000, NOW = new Date(2026, 9, 9, 12).getTime();
const plans = [
  { tier: "personal", label: "Personal", amount: 2900, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", creditUsd: 5, refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const INTRO = "Keep your bots working when this computer is off";
const STAR = "Enjoying OpenMausBot?";
const signedOut: CloudAccountState = { status: "signed-out" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const ready = { status: "ready" as const, origin: "https://omb-u-1.fly.dev" };
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });

let storage: Map<string, string>;
let account: CloudAccountState;
let snapshot: CloudPlanSnapshot | Error;
let offer: CloudOffer | null;
let viewer: WelcomeViewer | null;
let bridges: { cloud: Record<string, ReturnType<typeof vi.fn>>; plan: Record<string, ReturnType<typeof vi.fn>> };
let now: number;

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices, { viewer, now: () => now })); };
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
const launch = () => { f.values = []; return settle(); };
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const tree = () => { f.index = 0; f.effects = []; return nodes(AppNotices({ viewer, now: () => now })); };
const press = (label: string) => {
  const button = tree().find(node => node.type === "button" && (renderToStaticMarkup(node).includes(`>${label}<`) || node.props["aria-label"] === label));
  expect(button, label).toBeTruthy(); button!.props.onClick();
};
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; };
const launchCardsSeen = () => { storage.set(CLOUD_PRO_UPDATE_NOTICE, "1"); storage.set(PRODUCT_HUNT_NOTICE, "1"); };
const hints = () => f.state.config.onboarding.hintsSeen as string[];

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  storage = new Map(); f.values = []; f.index = 0; f.effects = []; f.updater = null; f.brand = "default"; f.dispatch = vi.fn(); now = NOW;
  setLocale("en"); viewer = LOCAL_VIEWER; account = signedOut; snapshot = { status: "none" }; offer = TRIAL_OFFER;
  f.state = { connected: true, bots: [], groups: [], instances: [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }],
    config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const patch = JSON.parse(String((init as RequestInit).body));
    f.state.config.onboarding.hintsSeen = patch.onboarding.hintsSeen;
    return f.state.config;
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  // The Cloud Pro popup and the Product Hunt card come first; the tests before their own are about the cards after them.
  launchCardsSeen();
  bridges = {
    cloud: { state: vi.fn(async () => account), onState: vi.fn(() => () => {}), offer: vi.fn(async () => offer), begin: vi.fn(async () => account),
      signInAgain: vi.fn(async () => account), connectHome: vi.fn(async () => account), openDashboard: vi.fn(async () => account) },
    plan: { state: vi.fn(async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }), manage: vi.fn(async () => {}), useThisComputer: vi.fn(), noticeSeen: vi.fn(async () => {}) },
  };
  vi.stubGlobal("window", { ogb: { remoteClient: { active: false }, cloudAccount: bridges.cloud, cloudPlan: bridges.plan, openExternal: vi.fn(async () => true) },
    addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("the card after the update", () => {
  it("offers the free trial to someone signed out who has used the app before, in the Admin's numbers, with Start free trial and Show me how", async () => {
    returning();
    const html = await launch();
    const words = [INTRO, "Free for 7 days", "MausBot Cloud is your own always-on computer in the cloud.", "Routines run on time, day and night",
      "Reach your bots from your phone, even with this computer off", "$5 of Claude credit to start", "Then from $29/month + tax. Cancel any time.",
      "14-day money-back on every plan.", "Start free trial", "Show me how", "Sign in to your Cloud plan", "Not now"];
    for (const text of words) expect(html).toContain(text);
    for (let i = 1; i < words.length; i++) expect(html.indexOf(words[i - 1]!), words[i]).toBeLessThan(html.indexOf(words[i]!));
    for (const gone of ["launch price", "first 100", "$89", "New features first", "Get Pro", STAR]) expect(html).not.toContain(gone);
    expect(html).not.toContain('aria-modal="true"');
    expect(bridges.cloud.offer).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith("cloud_card_shown", { variant: "signed_out" });
    expect(JSON.parse(storage.get(`${CLOUD_INTRO}:days`)!)).toEqual([localDay(NOW)]);
    expect(hints()).toContain(`${CLOUD_INTRO}:day-1`);
    expect(await settle()).toContain(INTRO);
    expect(await launch()).toBe("");
    now = NOW + 3 * 3600_000; expect(await launch()).toBe("");
    now = NOW + DAY; account = free;
    const again = await launch();
    expect(again).toContain(INTRO); expect(again).not.toContain("Sign in to your Cloud plan");
    expect(track).toHaveBeenCalledWith("cloud_card_shown", { variant: "free" });
  });

  it("needs a trial: without one it waits (the star may show), and without money-back from the Admin it says none", async () => {
    returning(); offer = { ...PLAIN_OFFER };
    let html = await launch();
    expect(html).not.toContain(INTRO); expect(html).toContain(STAR);
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    offer = null; expect(await launch()).not.toContain(INTRO);
    offer = { ...TRIAL_OFFER, refundDays: undefined, creditUsd: undefined };
    html = await launch();
    expect(html).toContain(INTRO); expect(html).toContain("Cloud computers and voice included");
    expect(html).not.toContain("money-back"); expect(html).not.toContain("Claude credit");
  });

  it("never to someone new this launch, who pays or may pay, on a branded build, or a desktop signed in with an organization", async () => {
    expect(await launch()).toBe("");
    returning();
    for (const state of [paid(), paid({ trial: trial("active") }), { ...free, purchase: { state: "confirming" as const } },
      { status: "reauth-required" as const, lastPlan: { active: true } }, { status: "unavailable" as const }, { status: "connecting" as const }]) {
      account = state; expect(await launch(), JSON.stringify(state)).not.toContain(INTRO);
    }
    account = signedOut; f.brand = "file";
    expect(await launch()).toBe("");
    f.brand = "default";
    (window.ogb as Record<string, unknown>).organization = { state: async () => ({ status: "connected", organization: { id: "o", name: "Acme" } }), onState: () => () => {} };
    const org = await launch();
    expect(org).not.toContain(INTRO); expect(org).toContain(STAR);
  });

  it("Start free trial opens the Add a Cloud dialog from the card, and the card is done for good", async () => {
    returning(); await launch();
    press("Start free trial"); await flush();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_card" });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "start" });
    expect(storage.get(CLOUD_INTRO)).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
    expect(render()).toBe("");
    now = NOW + 5 * DAY; storage.clear(); launchCardsSeen(); expect(await launch()).not.toContain(INTRO);
  });

  it("Show me how starts the one-step tip; Not now, the X and Escape end it for good, then say where Add a Cloud lives", async () => {
    returning(); await launch();
    press("Show me how");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "cloudHowTo", open: true });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "howto" });
    expect(storage.get(CLOUD_INTRO)).toBe("1");
    for (const close of ["Not now", "Dismiss for good", "Escape"]) {
      storage.clear(); launchCardsSeen(); f.state.config.onboarding.hintsSeen = withTourFinished(undefined); now += DAY;
      expect(await launch(), close).toContain(INTRO);
      if (close === "Escape") {
        const card = tree().find(node => node.type === "aside")!;
        const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
        card.props.onKeyDown(event); expect(event.preventDefault).toHaveBeenCalled();
      } else press(close);
      expect(storage.get(CLOUD_INTRO), close).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
      expect(render()).toContain("You can add a Cloud any time from the menu at the top of the sidebar.");
    }
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "not_now" });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "close" });
  });

  it("Sign in to your Cloud plan starts today's sign-in and only hides the card for now", async () => {
    returning(); await launch();
    press("Sign in to your Cloud plan");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true });
    expect(storage.get(CLOUD_INTRO)).toBeUndefined(); expect(render()).toBe("");
    now = NOW + DAY; expect(await launch()).toContain(INTRO);
  });

  it("shows on at most three days, or one for someone who closed the earlier Pro card", async () => {
    returning();
    for (let day = 0; day < 3; day++) { now = NOW + day * DAY; expect(await launch(), `day ${day}`).toContain(INTRO); }
    now = NOW + 3 * DAY;
    const after = await launch();
    expect(after).not.toContain(INTRO); expect(after).toContain(STAR);
    storage.clear(); launchCardsSeen(); f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "pro-introduction-dismissed-v3"];
    now = NOW + 10 * DAY; expect(await launch()).toContain(INTRO);
    now = NOW + 11 * DAY; expect(await launch()).not.toContain(INTRO);
  });

  it("never over setup, a dialog, the Add a Cloud dialog or its tip, busy work, or an update being offered", async () => {
    returning();
    const waits: Array<() => void> = [
      () => { f.state.welcomeOpen = true; }, () => { f.state.tourOpen = true; }, () => { f.state.appSettingsOpen = true; },
      () => { f.state.cloudAdd = { source: "app_menu" }; }, () => { f.state.cloudHowTo = true; }, () => { f.updater = { status: "downloaded" }; },
      () => { f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; }, () => { f.state.connected = false; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).toBe("");
      f.state = saved; f.updater = null;
    }
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    expect(await launch()).toContain(INTRO);
  });
});

describe("the free trial's notice, here and on My Cloud", () => {
  it("shows the notice main says is due, tells main once, and stays up until it is closed", async () => {
    account = paid({ trial: trial("active") }); snapshot = { status: "paid", tier: "pro", trial: trial("active"), notice: "active", credit: { grantedUsd: 5, remainingUsd: 3.2, state: "active" } };
    offer = { ...PLAIN_OFFER };
    const html = await launch();
    expect(html).toContain("Your free trial ends on"); expect(html).toContain("Includes $5 of Claude credit: $3.20 left.");
    expect(html).toContain("Prefer Personal at $29?");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    snapshot = { ...snapshot, notice: undefined };
    expect(await settle()).toContain("Your free trial ends on");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    press("Manage subscription"); await flush();
    expect(bridges.plan.manage).toHaveBeenCalledOnce();
    expect(render()).toBe("");
    expect(await launch()).not.toContain("Your free trial");
  });

  it("on My Cloud's own page, only the trial's notice, after its sign-in and setup checklist", async () => {
    viewer = { hosted: false, canSave: true, cloudHome: true };
    vi.stubGlobal("window", { ogb: { cloudPlan: bridges.plan }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    returning();
    snapshot = { status: "none", trial: trial("ended", { deleteAt: NOW + 3 * DAY, keep: "checkout" }), notice: "ended" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"];
    expect(await launch()).toContain("Your free trial has ended");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: false } }];
    expect(await launch()).toBe("");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }];
    snapshot = { status: "none" };
    expect(await launch()).toBe("");
    expect(bridges.cloud.offer).not.toHaveBeenCalled();
    snapshot = new Error("only available in this app's window");
    expect(await launch()).toBe("");
  });
});

describe("This computer's My Cloud card and the star", () => {
  it("someone with a ready My Cloud is told once where the always-on bots are; Not now is kept", async () => {
    account = paid({ machine: ready }); returning();
    const html = await launch();
    expect(html).toContain("Your always-on bots are on My Cloud"); expect(html).not.toContain(STAR);
    press("Open My Cloud"); await flush();
    expect(bridges.cloud.connectHome).toHaveBeenCalledOnce();
    press("Not now");
    expect(storage.get(CLOUD_NOTICE_DISMISSED)).toBe("1"); expect(hints()).toContain(CLOUD_NOTICE_DISMISSED);
    expect(await launch()).toContain(STAR);
  });

  it("an ended sign-in on a paid plan asks to sign in again; the star comes last and is for good", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }; returning();
    expect(await launch()).toContain("Sign in again to reach My Cloud");
    press("Sign in again"); await flush();
    expect(bridges.cloud.signInAgain).toHaveBeenCalledOnce();
    account = { ...free }; offer = { ...PLAIN_OFFER };
    expect(await launch()).toContain(STAR);
    press("Not now");
    expect(storage.get(STAR_NOTICE)).toBe("1"); expect(await launch()).toBe("");
  });
});

describe("the Product Hunt launch card", () => {
  const PH = "live on Product Hunt";
  const fresh = () => { storage.delete(PRODUCT_HUNT_NOTICE); };

  it("comes first, for everyone (new or not, any plan), and the upvote opens the launch and ends it for good", async () => {
    fresh(); account = paid({ machine: ready });
    const html = await launch();
    expect(html).toContain(PH); expect(html).toContain("Upvote on Product Hunt");
    expect(html).not.toContain(STAR); expect(html).not.toContain("Your always-on bots are on My Cloud");
    press("Upvote on Product Hunt"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith(PRODUCT_HUNT_URL);
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "upvote" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1"); expect(hints()).toContain(PRODUCT_HUNT_NOTICE);
    expect(await launch()).toContain("Your always-on bots are on My Cloud");
  });

  it("Not now, the X and Escape end it for good too", async () => {
    fresh();
    expect(await launch()).toContain(PH);
    press("Not now");
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "not_now" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1");
    expect(await launch()).not.toContain(PH);
  });

  it("never on a branded build or an organization's desktop, never after the launch window, never over setup or an update", async () => {
    fresh(); f.brand = "file";
    expect(await launch()).not.toContain(PH);
    f.brand = "default"; now = PRODUCT_HUNT_UNTIL;
    expect(await launch()).not.toContain(PH);
    now = NOW; f.updater = { status: "available", version: "9.9.9" };
    expect(await launch()).not.toContain(PH);
  });
});

describe("the Cloud Pro popup after the update", () => {
  const POPUP = "MausBot Cloud Pro";
  let modal: boolean;
  const popupEvents = (action: string) => vi.mocked(track).mock.calls.filter(([event, props]) => event === "cloud_pro_popup" && (props as { action?: string }).action === action);
  const lastOrder = (calls: { mock: { invocationCallOrder: number[] } }) => calls.mock.invocationCallOrder.at(-1)!;
  const fresh = () => { storage.delete(CLOUD_PRO_UPDATE_NOTICE); f.state.config.onboarding.hintsSeen = withTourFinished(undefined); };
  const keydown = (key: string, shiftKey = false) => {
    const handler = vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === "keydown").at(-1)![1] as (event: unknown) => void;
    const event = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    handler(event);
    return event;
  };
  const tierPlan = (tier: string, extra: Partial<CloudAccountState> = {}) =>
    paid({ entitlement: { plan: "pro", tier, status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });

  beforeEach(() => {
    fresh(); modal = false;
    vi.stubGlobal("document", { activeElement: null, body: null, getElementById: () => null,
      querySelector: (selector: string) => modal && selector.startsWith('[aria-modal="true"]') ? {} : null });
  });

  it("every install gets it once, before every other card, as a modal dialog with the Admin's offer; Start free trial opens Add a Cloud from it", async () => {
    returning(); storage.delete(PRODUCT_HUNT_NOTICE);
    const html = await launch();
    const words = [POPUP, "Free for 7 days", "MausBot Cloud is your own always-on computer in the cloud.", "Routines run on time, day and night",
      "Reach your bots from your phone, even with this computer off", "$5 of Claude credit to start", "Then from $29/month + tax. Cancel any time.",
      "14-day money-back on every plan.", "Start free trial", "Compare plans", "OpenMausBot on this computer stays free and open source.", "Not now"];
    for (const text of words) expect(html).toContain(text);
    for (let i = 1; i < words.length; i++) expect(html.indexOf(words[i - 1]!), words[i]).toBeLessThan(html.indexOf(words[i]!));
    for (const part of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="cloud-pro-popup-title"', 'aria-describedby="cloud-pro-popup-body"']) expect(html).toContain(part);
    for (const other of ["live on Product Hunt", INTRO, STAR]) expect(html).not.toContain(other);
    expect(popupEvents("shown")).toEqual([["cloud_pro_popup", { action: "shown", plan: "none", signed_in: false }]]);
    expect(await settle()).toContain(POPUP);
    expect(popupEvents("shown")).toHaveLength(1);
    expect(storage.get(CLOUD_PRO_UPDATE_NOTICE)).toBeUndefined();

    press("Start free trial");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "update_popup" });
    expect(popupEvents("upgrade")).toEqual([["cloud_pro_popup", { action: "upgrade", plan: "none", signed_in: false }]]);
    expect(identifyEmail).not.toHaveBeenCalled();
    expect(storage.get(CLOUD_PRO_UPDATE_NOTICE)).toBe("1"); await flush(); expect(hints()).toContain(CLOUD_PRO_UPDATE_NOTICE);
    expect(render()).toBe("");
    const next = await launch();
    expect(next).not.toContain(POPUP); expect(next).toContain("live on Product Hunt");
  });

  it("a new install gets it once onboarding is done, never in the middle of it", async () => {
    f.state.config.onboarding = { ...EMPTY_ONBOARDING };
    expect(await launch()).toBe("");
    f.state.config.onboarding = { ...EMPTY_ONBOARDING, completedAt: "2026-10-16", version: 1, hintsSeen: [] };
    expect(await launch()).toBe("");
    f.state.config.onboarding.hintsSeen = withTourFinished(undefined); f.state.welcomeOpen = true;
    expect(await launch()).toBe("");
    f.state.welcomeOpen = false;
    const html = await launch();
    expect(html).toContain(POPUP); expect(html).not.toContain(INTRO);
    expect(popupEvents("shown")).toHaveLength(1);
  });

  it("someone signed in with no plan: each click is tied to their Cloud account's email before it is counted, and only once across reloads", async () => {
    account = free; offer = { ...PLAIN_OFFER };
    const html = await launch();
    expect(html).toContain("Upgrade to Cloud Pro"); expect(html).toContain("MausBot Cloud plans from $29/month + tax.");
    for (const gone of ["Free for", "Start free trial", "Claude credit"]) expect(html).not.toContain(gone);
    expect(popupEvents("shown")).toEqual([["cloud_pro_popup", { action: "shown", plan: "none", signed_in: true }]]);
    expect(identifyEmail).not.toHaveBeenCalled();

    press("Compare plans"); await flush();
    // Compare plans stays in the app: the Add a Cloud dialog lists every plan.
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "update_popup" });
    expect(window.ogb?.openExternal).not.toHaveBeenCalled();
    expect(identifyEmail).toHaveBeenCalledWith("person@example.test", { submitted: false });
    expect(popupEvents("see_plans")).toEqual([["cloud_pro_popup", { action: "see_plans", plan: "none", signed_in: true }]]);
    expect(lastOrder(vi.mocked(identifyEmail))).toBeLessThan(lastOrder(vi.mocked(track)));
    expect(render()).toBe("");
    storage.clear(); storage.set(PRODUCT_HUNT_NOTICE, "1");
    expect(await launch()).not.toContain(POPUP);

    vi.clearAllMocks(); fresh(); await launch();
    press("Upgrade to Cloud Pro");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "update_popup" });
    expect(identifyEmail).toHaveBeenCalledWith("person@example.test", { submitted: false });
    expect(popupEvents("upgrade")).toEqual([["cloud_pro_popup", { action: "upgrade", plan: "none", signed_in: true }]]);
    expect(lastOrder(vi.mocked(identifyEmail))).toBeLessThan(lastOrder(vi.mocked(track)));
  });

  it("a trial or any plan gets Manage plan in Settings → MausBot Cloud, in the app; no Compare plans, never a checkout or the browser", async () => {
    const cases = [
      { state: paid({ trial: trial("active") }), plan: "trial", label: "Manage plan", action: "manage", line: "Pro free trial · verified by MausBot Cloud" },
      { state: paid(), plan: "pro", label: "Manage plan", action: "manage", line: "Pro active · verified by MausBot Cloud" },
      { state: tierPlan("max"), plan: "max", label: "Manage plan", action: "manage", line: "Max active · verified by MausBot Cloud" },
      { state: tierPlan("personal"), plan: "personal", label: "Manage plan", action: "manage", line: "Personal active · verified by MausBot Cloud" },
    ];
    for (const { state, plan, label, action, line } of cases) {
      vi.clearAllMocks(); fresh(); account = state;
      const html = await launch();
      expect(html, plan).toContain(POPUP); expect(html, plan).toContain(label); expect(html, plan).toContain(line);
      for (const gone of ["Start free trial", "Free for", "/month", "Compare plans", "Upgrade to Cloud Pro"]) expect(html, plan).not.toContain(gone);
      expect(popupEvents("shown"), plan).toEqual([["cloud_pro_popup", { action: "shown", plan, signed_in: true }]]);
      press(label); await flush();
      expect(f.dispatch, plan).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
      expect(bridges.cloud.openDashboard, plan).not.toHaveBeenCalled(); expect(window.ogb?.openExternal, plan).not.toHaveBeenCalled();
      expect(f.dispatch, plan).not.toHaveBeenCalledWith(expect.objectContaining({ type: "openCloudAdd" }));
      expect(identifyEmail, plan).toHaveBeenCalledWith("person@example.test", { submitted: false });
      expect(popupEvents(action), plan).toEqual([["cloud_pro_popup", { action, plan, signed_in: true }]]);
      expect(storage.get(CLOUD_PRO_UPDATE_NOTICE), plan).toBe("1"); expect(render(), plan).toBe("");
      expect(bridges.cloud.offer, plan).not.toHaveBeenCalled();
    }
  });

  it("never shows one account's offer for another while the new one loads", async () => {
    offer = TRIAL_OFFER;
    expect(await launch()).toContain("Start free trial");
    account = free; let answer!: (next: CloudOffer) => void;
    bridges.cloud.offer.mockImplementation(() => new Promise<CloudOffer>(resolve => { answer = resolve; }));
    expect(await settle(), "the signed-out trial is not shown for the signed-in account").not.toContain("Free for 7 days");
    answer({ ...PLAIN_OFFER }); await flush();
    const html = await settle();
    expect(html).toContain("Upgrade to Cloud Pro"); expect(html).not.toContain("Free for 7 days");
  });

  it("Not now, the X, Escape and a click outside end it for good and never say who it was", async () => {
    account = free; offer = { ...PLAIN_OFFER };
    for (const how of ["Not now", "Close", "Escape", "outside"] as const) {
      fresh();
      expect(await launch(), how).toContain(POPUP);
      if (how === "Escape") expect(keydown("Escape").preventDefault, how).toHaveBeenCalled();
      else if (how === "outside") {
        const backdrop = tree().find(node => typeof node.props.onMouseDown === "function")!;
        backdrop.props.onMouseDown({ target: {}, currentTarget: backdrop });
        expect(render(), "a press inside the dialog").toContain(POPUP);
        backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
      } else press(how);
      expect(storage.get(CLOUD_PRO_UPDATE_NOTICE), how).toBe("1"); await flush(); expect(hints(), how).toContain(CLOUD_PRO_UPDATE_NOTICE);
      expect(render(), how).toBe("");
      expect(await launch(), how).not.toContain(POPUP);
    }
    expect(popupEvents("not_now")).toEqual([["cloud_pro_popup", { action: "not_now", plan: "none", signed_in: true }]]);
    expect(popupEvents("close")).toHaveLength(3);
    expect(identifyEmail).not.toHaveBeenCalled();
  });

  it("never on a remote client's window, a Cloud home or a branded build", async () => {
    (window.ogb as Record<string, any>).remoteClient.active = true;
    expect(await launch()).not.toContain(POPUP);
    (window.ogb as Record<string, any>).remoteClient.active = false;
    f.state.config.cloudHome = true;
    expect(await launch()).not.toContain(POPUP);
    delete f.state.config.cloudHome; f.brand = "file";
    expect(await launch()).not.toContain(POPUP);
    f.brand = "default";
    viewer = { hosted: false, canSave: true, cloudHome: true };
    vi.stubGlobal("window", { ogb: { cloudPlan: bridges.plan }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    snapshot = { status: "none", trial: trial("ended", { deleteAt: NOW + 3 * DAY, keep: "checkout" }), notice: "ended" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"];
    const home = await launch();
    expect(home).toContain("Your free trial has ended"); expect(home).not.toContain(POPUP);
    expect(popupEvents("shown")).toEqual([]);
    expect(storage.get(CLOUD_PRO_UPDATE_NOTICE)).toBeUndefined();
  });

  it("waits, and holds back the cards after it, while the plan or the offer loads, a dialog or a call is open, or the app is busy or updating", async () => {
    returning(); storage.set(CLOUD_INTRO, "1");
    const waits: Array<() => void> = [
      () => { account = { status: "signed-out", message: "restoring" }; }, () => { account = { status: "connecting" }; },
      () => { bridges.cloud.offer.mockImplementation(() => new Promise(() => {})); },
      () => { modal = true; }, () => { f.state.liveCall = { status: "live" }; },
      () => { f.state.appSettingsOpen = true; }, () => { f.state.cloudAdd = { source: "app_menu" }; }, () => { f.updater = { status: "downloaded" }; },
      () => { f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).toBe("");
      f.state = saved; f.updater = null; account = signedOut; modal = false; bridges.cloud.offer.mockImplementation(async () => offer);
    }
    expect(popupEvents("shown")).toEqual([]);
    expect(storage.get(CLOUD_PRO_UPDATE_NOTICE)).toBeUndefined();
    f.state.liveCall = { status: "ended" };
    expect(await launch()).toContain(POPUP);
    modal = true;
    expect(render(), "a dialog that opens over it hides it").not.toContain(POPUP);
    modal = false;
    expect(await settle(), "and it comes back when that dialog closes").toContain(POPUP);
    expect(popupEvents("shown")).toHaveLength(1);
  });

  it("offline, it waits for a later launch and lets the other cards show meanwhile", async () => {
    returning(); account = { status: "unavailable" };
    const offline = await launch();
    expect(offline).not.toContain(POPUP); expect(offline).toContain(STAR);
    account = signedOut; offer = null;
    const unreachable = await launch();
    expect(unreachable).not.toContain(POPUP); expect(unreachable).toContain(STAR);
    expect(storage.get(CLOUD_PRO_UPDATE_NOTICE)).toBeUndefined();
    offer = TRIAL_OFFER;
    expect(await launch()).toContain(POPUP);
  });
});
