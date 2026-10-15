import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsEnabled, initAnalytics, optAction, setAnalyticsEnabled } from "./analytics";
import { appVersion } from "./app-links";

// `loads` counts evaluations of posthog-js (an opted-out session must leave it at 0); `calls` is what would reach PostHog.
const ph = vi.hoisted(() => {
  const ph = {
    loads: 0,
    fail: false,
    initThrows: false,
    calls: [] as string[],
    options: [] as Record<string, unknown>[],
    registered: [] as Record<string, unknown>[],
    module: () => {
      if (ph.fail) throw new Error("chunk failed to load");
      ph.loads += 1;
      let optedOut = false;
      return {
        default: {
          init: (_token: string, options: Record<string, unknown>) => {
            if (ph.initThrows) throw new Error("init failed");
            ph.calls.push("init");
            ph.options.push(options);
          },
          has_opted_out_capturing: () => optedOut,
          opt_in_capturing: () => {
            optedOut = false;
            ph.calls.push("opt_in_capturing");
          },
          opt_out_capturing: () => {
            optedOut = true;
            ph.calls.push("opt_out_capturing");
          },
          register: (properties: Record<string, unknown>) => { ph.calls.push("register"); ph.registered.push(properties); },
          capture: (event: string) => void ph.calls.push(`capture ${event}`),
          identify: (id: string) => void ph.calls.push(`identify ${id}`),
        },
      };
    },
  };
  return ph;
});
vi.mock("posthog-js", () => ph.module());

// The suite runs on the node environment, which has no localStorage.
const store = new Map<string, string>();
const baseStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", baseStorage);

beforeEach(() => {
  store.clear();
  ph.loads = 0;
  ph.fail = false;
  ph.initThrows = false;
  ph.calls = [];
  ph.options = [];
  ph.registered = [];
});
// Restored in afterEach: an inline restore would be skipped when an assertion fails mid-test.
afterEach(() => vi.stubGlobal("localStorage", baseStorage));

// resetModules keeps the mocked posthog-js cached, so it is registered again and `loads` counts this graph only.
async function freshAnalytics() {
  vi.resetModules();
  vi.doMock("posthog-js", () => ph.module());
  return import("./analytics");
}

const OPENED = ["init", "register", "capture app_first_open", "capture app_opened"];

describe("optAction", () => {
  it("initialises on the first opt-in of a session that started off", () => {
    expect(optAction(true, false)).toBe("init");
  });

  it("opts a running client back in rather than initialising twice", () => {
    expect(optAction(true, true)).toBe("opt-in");
  });

  it("stops a running client without waiting for a restart", () => {
    expect(optAction(false, true)).toBe("opt-out");
  });

  it("does nothing when there is no client to stop", () => {
    expect(optAction(false, false)).toBe("none");
  });
});

describe("the stored choice", () => {
  it("is on for a fresh install", () => {
    expect(analyticsEnabled()).toBe(true);
  });

  it("survives a restart once opted out", () => {
    setAnalyticsEnabled(false);
    expect(analyticsEnabled()).toBe(false);
  });

  it("can be turned back on", async () => {
    setAnalyticsEnabled(false);
    setAnalyticsEnabled(true);
    expect(analyticsEnabled()).toBe(true);
    // Let init finish here rather than write the install marker into the next test.
    await initAnalytics();
  });

  it("holds an opt-out for the session even when the write is rejected", async () => {
    const fresh = await freshAnalytics();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });

    fresh.setAnalyticsEnabled(false);
    expect(fresh.analyticsEnabled()).toBe(false);
    await fresh.initAnalytics();
    expect(ph.loads).toBe(0);
    expect(store.get("omb-installed")).toBeUndefined();
  });

  it("treats unusable storage as a fresh install rather than failing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(analyticsEnabled()).toBe(true);
    expect(() => setAnalyticsEnabled(false)).not.toThrow();
  });
});

describe("initAnalytics while opted out", () => {
  it("returns before loading the client or touching the install marker", async () => {
    store.set("omb-analytics-opt-out", "1");
    const fresh = await freshAnalytics();

    expect(fresh.analyticsEnabled()).toBe(false);
    await fresh.initAnalytics();
    fresh.track("onboarding_step");
    fresh.identifyEmail("someone@example.com");

    expect(ph.loads).toBe(0);
    expect(ph.calls).toEqual([]);
    expect(store.get("omb-installed")).toBeUndefined();
  });
});

describe("loading the client", () => {
  it("leaves posthog-js out of the startup bundle until initAnalytics runs", async () => {
    const fresh = await freshAnalytics();
    expect(ph.loads).toBe(0);
    await fresh.initAnalytics();
    expect(ph.loads).toBe(1);
  });

  it("says which app sent every event, and from which page, before the first one", async () => {
    const fresh = await freshAnalytics();
    await fresh.initAnalytics();
    expect(ph.registered).toEqual([{ app_version: appVersion(), surface: "server" }]);
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(ph.calls.indexOf("register")).toBeLessThan(ph.calls.indexOf("capture app_first_open"));
    vi.stubGlobal("window", { ogb: { environments: {} } });
    try { expect(fresh.analyticsSurface()).toBe("local"); } finally { vi.unstubAllGlobals(); vi.stubGlobal("localStorage", baseStorage); }
    expect(fresh.analyticsSurface()).toBe("server");
  });

  it("initialises once, with autocapture and surveys off", async () => {
    const fresh = await freshAnalytics();
    const first = fresh.initAnalytics();
    expect(fresh.initAnalytics()).toBe(first);
    await first;
    await fresh.initAnalytics();

    expect(ph.calls).toEqual(OPENED);
    expect(ph.options).toHaveLength(1);
    expect(ph.options[0]).toMatchObject({ autocapture: false, disable_surveys: true });
  });

  it("delivers calls made while it loads once each, after app_opened, in order", async () => {
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.track("onboarding_step", { step: "hello" });
    fresh.identifyEmail("someone@example.com");
    fresh.track("onboarding_done");
    await loading;

    expect(ph.calls).toEqual([
      ...OPENED,
      "capture onboarding_step",
      "identify someone@example.com",
      "capture email_submitted",
      "capture onboarding_done",
    ]);
  });

  it("drops calls made before initAnalytics, as before", async () => {
    const fresh = await freshAnalytics();
    fresh.track("too_early");
    await fresh.initAnalytics();
    expect(ph.calls).toEqual(OPENED);
  });

  it("never initialises, and drops the queued email, when switched off mid-load", async () => {
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.identifyEmail("someone@example.com");
    fresh.track("onboarding_step");
    fresh.setAnalyticsEnabled(false);
    await loading;

    expect(ph.calls).toEqual([]);
    expect(store.get("omb-installed")).toBeUndefined();

    fresh.setAnalyticsEnabled(true);
    await fresh.initAnalytics();
    expect(ph.calls).toEqual(OPENED);
  });

  it("initialises once when switched off and on again mid-load", async () => {
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.track("before_off");
    fresh.setAnalyticsEnabled(false);
    fresh.setAnalyticsEnabled(true);
    fresh.track("after_on");
    await loading;
    await fresh.initAnalytics();

    expect(ph.loads).toBe(1);
    expect(ph.calls).toEqual([...OPENED, "capture after_on"]);
  });

  it("stops a running client when switched off", async () => {
    const fresh = await freshAnalytics();
    await fresh.initAnalytics();
    fresh.setAnalyticsEnabled(false);
    fresh.track("after_off");
    fresh.identifyEmail("someone@example.com");

    expect(ph.calls).toEqual([...OPENED, "opt_out_capturing"]);
  });

  it("stays off without throwing when the library fails to load", async () => {
    ph.fail = true;
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.track("onboarding_step");
    await expect(loading).resolves.toBeUndefined();
    fresh.track("after_failure");
    expect(ph.calls).toEqual([]);

    ph.fail = false;
    fresh.setAnalyticsEnabled(true);
    await fresh.initAnalytics();
    expect(ph.calls).toEqual(OPENED);
  });

  it("settles quietly, and drops the queue, when the library throws while starting", async () => {
    ph.initThrows = true;
    const fresh = await freshAnalytics();
    const loading = fresh.initAnalytics();
    fresh.identifyEmail("someone@example.com");
    await expect(loading).resolves.toBeUndefined();
    fresh.track("after_failure");
    expect(ph.calls).toEqual([]);

    ph.initThrows = false;
    await fresh.initAnalytics();
    expect(ph.calls).toEqual(OPENED);
  });
});
