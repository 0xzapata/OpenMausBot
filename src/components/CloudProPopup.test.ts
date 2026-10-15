// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

vi.mock("@/components/EngineLibrary", () => ({ engineReady: () => true }));
const ph = vi.hoisted(() => {
  const ph = {
    loads: 0,
    calls: [] as unknown[][],
    module: () => {
      ph.loads += 1;
      return { default: {
        init: () => {}, has_opted_out_capturing: () => false, opt_in_capturing: () => {}, opt_out_capturing: () => {},
        register: () => {}, unregister: () => {},
        capture: (event: string, props?: unknown) => void ph.calls.push(["capture", event, props]),
        identify: (id: string, props?: unknown) => void ph.calls.push(["identify", id, props]),
      } };
    },
  };
  return ph;
});
vi.mock("posthog-js", () => ph.module());
import { CloudProPopup, cloudProPopupView, otherDialogOpen, useOtherDialogOpen, type CloudProPopupView } from "./CloudProPopup";

const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 16);
const plans = [
  { tier: "personal", label: "Personal", amount: 2900, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", creditUsd: 5, refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const onPlan = (tier: string | undefined, extra: Partial<CloudAccountState> = {}): CloudAccountState =>
  ({ ...free, entitlement: { plan: "pro", ...(tier ? { tier } : {}), status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const running = { state: "active" as const, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none" as const };

beforeEach(() => setLocale("en"));

describe("what the popup offers, by plan", () => {
  it("waits while the plan or the offer loads, and for a later launch when the Cloud can't be reached", () => {
    for (const account of [null, { status: "signed-out", message: "restoring" }, { status: "connecting" }] as const) {
      expect(cloudProPopupView(account as CloudAccountState | null, TRIAL_OFFER), JSON.stringify(account)).toBe("loading");
    }
    expect(cloudProPopupView({ status: "signed-out" }, undefined)).toBe("loading");
    expect(cloudProPopupView({ status: "signed-out" }, null)).toBe("offline");
    expect(cloudProPopupView({ status: "unavailable", lastPlan: { tier: "pro", active: true } }, TRIAL_OFFER)).toBe("offline");
  });

  it("no plan: the in-app checkout, with the trial, prices, credit and money-back from the live offer", () => {
    const signedOut = cloudProPopupView({ status: "signed-out" }, TRIAL_OFFER) as CloudProPopupView;
    expect(signedOut).toMatchObject({ primary: { action: "upgrade", via: "checkout", label: "Start free trial" }, plan: "none", signedIn: false, email: null,
      badge: "Free for 7 days", price: "Then from $29/month + tax. Cancel any time.", moneyBack: "14-day money-back on every plan.", current: null });
    expect(signedOut.points).toContain("$5 of Claude credit to start");
    const costlier = { ...PLAIN_OFFER, plans: PLAIN_OFFER.plans.map(plan => ({ ...plan, amount: plan.amount + 1000 })) };
    expect(cloudProPopupView(free, costlier)).toMatchObject({ primary: { action: "upgrade", via: "checkout", label: "Upgrade to Cloud Pro" },
      plan: "none", signedIn: true, email: "person@example.test", badge: null, price: "MausBot Cloud plans from $39/month + tax.", moneyBack: null });
    expect((cloudProPopupView(free, costlier) as CloudProPopupView).points).toContain("Cloud computers and voice included");
  });

  it("a plan: Manage plan in Settings → MausBot Cloud for every plan, no Compare plans, never a checkout, a price or the browser", () => {
    const cases: Array<[CloudAccountState, string, string, string | null]> = [
      [onPlan("personal"), "personal", "Manage plan", "Personal active · verified by MausBot Cloud"],
      [onPlan("pro", { trial: running }), "trial", "Manage plan", "Pro free trial · verified by MausBot Cloud"],
      [onPlan("pro"), "pro", "Manage plan", "Pro active · verified by MausBot Cloud"],
      [onPlan(undefined), "pro", "Manage plan", "Pro active · verified by MausBot Cloud"],
      [onPlan("max"), "max", "Manage plan", "Max active · verified by MausBot Cloud"],
      [onPlan("ultra"), "other", "Manage plan", "Cloud active · verified by MausBot Cloud"],
      [{ ...free, purchase: { state: "confirming" } }, "none", "Manage plan", "MausBot Cloud · payment received"],
      [{ ...free, entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 3 } }, "none", "Manage plan", "Pro · not active right now"],
      [{ status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }, "unknown", "Manage plan", "Sign in again to use My Cloud on this computer. Your plan is not affected."],
      [{ status: "signed-out", message: "restore-removed" }, "none", "Manage plan", null],
    ];
    for (const [account, plan, label, current] of cases) {
      const view = cloudProPopupView(account, TRIAL_OFFER) as CloudProPopupView;
      expect(view, plan).toMatchObject({ primary: { via: "settings", label, action: "manage" }, seePlans: false, plan, current, badge: null, price: null, moneyBack: null });
      expect(view.signedIn, plan).toBe(account.status === "connected");
    }
  });
});

describe("the popup as a dialog", () => {
  let root: Root, container: HTMLElement, opener: HTMLButtonElement;
  const view = cloudProPopupView({ status: "signed-out" }, TRIAL_OFFER) as CloudProPopupView;
  const actions = { onPrimary: vi.fn(), onSeePlans: vi.fn(), onNotNow: vi.fn(), onClose: vi.fn() };
  const show = (props: Partial<Parameters<typeof CloudProPopup>[0]> = {}) => flushSync(() => root.render(createElement(CloudProPopup, { view, ...actions, ...props })));
  const press = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    return event;
  };
  const focused = () => (document.activeElement as HTMLElement).textContent || document.activeElement!.getAttribute("aria-label");
  beforeEach(() => {
    vi.clearAllMocks();
    opener = document.body.appendChild(document.createElement("button"));
    opener.textContent = "composer"; opener.focus();
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });
  afterEach(() => { root.unmount(); document.body.replaceChildren(); });

  it("is a labelled modal dialog that takes focus at its title, keeps Tab inside and gives focus back when it goes", () => {
    show();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("MausBot Cloud Pro");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toContain("Then from $29/month + tax.");
    expect(document.activeElement!.id).toBe("cloud-pro-popup-title");
    const order: Array<string | null> = [];
    for (let i = 0; i < 5; i++) { expect(press("Tab").defaultPrevented).toBe(true); order.push(focused()); }
    expect(order).toEqual(["Start free trial", "Compare plans", "Not now", "Close", "Start free trial"]);
    press("Tab", true); expect(focused()).toBe("Close");
    flushSync(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it("Escape, the X and a press outside close it; a press inside does not; each button does its own thing", () => {
    show();
    const escape = press("Escape");
    expect(escape.defaultPrevented).toBe(true); expect(actions.onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.firstElementChild!, dialog = container.querySelector('[role="dialog"]')!;
    dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(actions.onClose).toHaveBeenCalledTimes(1);
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(actions.onClose).toHaveBeenCalledTimes(2);
    const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name || item.getAttribute("aria-label") === name)!;
    button("Close").click(); expect(actions.onClose).toHaveBeenCalledTimes(3);
    button("Start free trial").click(); expect(actions.onPrimary).toHaveBeenCalledOnce();
    button("Compare plans").click(); expect(actions.onSeePlans).toHaveBeenCalledOnce();
    button("Not now").click(); expect(actions.onNotNow).toHaveBeenCalledOnce();
    // A payer has no plans to compare in the app yet: no Compare plans link.
    show({ view: cloudProPopupView(onPlan("pro"), TRIAL_OFFER) as CloudProPopupView });
    expect([...container.querySelectorAll("button")].map(item => item.textContent)).not.toContain("Compare plans");
  });

  it("knows when another dialog is open, and notices it opening and closing", () => {
    vi.useFakeTimers();
    try {
      const seen: boolean[] = [];
      const Probe = () => { seen.push(useOtherDialogOpen(true)); return null; };
      show();
      expect(otherDialogOpen()).toBe(false);
      flushSync(() => createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(Probe)));
      expect(seen.at(-1)).toBe(false);
      const other = document.body.appendChild(document.createElement("div"));
      other.setAttribute("aria-modal", "true");
      expect(otherDialogOpen()).toBe(true);
      flushSync(() => vi.advanceTimersByTime(1_000));
      expect(seen.at(-1)).toBe(true);
      other.remove();
      flushSync(() => vi.advanceTimersByTime(1_000));
      expect(seen.at(-1)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe("who clicked, through the app's analytics", () => {
  async function fresh(enabled: boolean) {
    const stored = new Map<string, string>(enabled ? [] : [["omb-analytics-opt-out", "1"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
    vi.resetModules();
    vi.doMock("posthog-js", () => ph.module());
    ph.loads = 0; ph.calls = [];
    const analytics = await import("@/lib/analytics");
    await analytics.initAnalytics();
    const { reportCloudProPopup } = await import("./CloudProPopup");
    return reportCloudProPopup;
  }
  const sent = () => ph.calls.filter(([kind, event]) => kind === "identify" || event === "cloud_pro_popup" || event === "email_submitted");
  const person = { plan: "none" as const, signedIn: true, email: "person@example.test" };
  afterEach(() => vi.unstubAllGlobals());

  it("a click by someone signed in is tied to their Cloud account's email first; showing, Not now and close never are", async () => {
    const report = await fresh(true);
    for (const action of ["upgrade", "manage", "see_plans"] as const) report(action, person);
    for (const action of ["shown", "not_now", "close"] as const) report(action, person);
    report("upgrade", { plan: "none", signedIn: false, email: null });
    const identify = ["identify", "person@example.test", { email: "person@example.test" }];
    const event = (action: string, signedIn = true) => ["capture", "cloud_pro_popup", { action, plan: "none", signed_in: signedIn }];
    expect(sent()).toEqual([identify, event("upgrade"), identify, event("manage"), identify, event("see_plans"),
      event("shown"), event("not_now"), event("close"), event("upgrade", false)]);
  });

  it("sends nothing at all with usage analytics off", async () => {
    const report = await fresh(false);
    for (const action of ["shown", "upgrade", "manage", "see_plans", "not_now", "close"] as const) report(action, person);
    expect(ph.loads).toBe(0);
    expect(ph.calls).toEqual([]);
  });
});
