// The phc_ token is a write-only public key, safe to ship in the client.
// posthog-js loads on demand: a static import would put ~240 kB into the startup bundle.
import type { PostHog } from "posthog-js";
import { appVersion } from "@/lib/app-links";

const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";

// Read before init(): an opted-out install must never call posthog.init(), so no request leaves the machine.
const OPT_OUT_KEY = "omb-analytics-opt-out";

let client: PostHog | undefined;
let loading: Promise<void> | undefined;
let pending: Array<(ph: PostHog) => void> = [];

// Outranks storage, so a rejected write cannot lose an opt-out.
let choice: boolean | undefined;

export function analyticsEnabled(): boolean {
  if (choice !== undefined) return choice;
  try {
    return localStorage.getItem(OPT_OUT_KEY) !== "1";
  } catch {
    return true;
  }
}

export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(enabled: boolean, running: boolean): OptAction {
  if (!enabled) return running ? "opt-out" : "none";
  return running ? "opt-in" : "init";
}

export function setAnalyticsEnabled(enabled: boolean) {
  choice = enabled;
  try {
    localStorage.setItem(OPT_OUT_KEY, enabled ? "0" : "1");
  } catch {
  }
  if (!enabled) pending = [];
  switch (optAction(enabled, client !== undefined)) {
    case "opt-out":
      client?.opt_out_capturing();
      break;
    case "opt-in":
      client?.opt_in_capturing();
      break;
    case "init":
      void initAnalytics();
      break;
    case "none":
      break;
  }
}

export function initAnalytics(): Promise<void> {
  if (client || !analyticsEnabled()) return Promise.resolve();
  loading ??= import("posthog-js")
    .then(({ default: posthog }) => start(posthog))
    .catch(() => {
      pending = [];
    })
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

function start(posthog: PostHog) {
  if (!analyticsEnabled()) {
    pending = [];
    return;
  }
  posthog.init(TOKEN, {
    api_host: "https://us.i.posthog.com",
    autocapture: false, // never capture clicked-element text (conversation leak)
    capture_pageview: false,
    person_profiles: "identified_only",
    persistence: "localStorage",
    // PostHog's remote config `surveys: false` still fetches surveys.js.
    disable_surveys: true,
  });
  // opt_out_capturing() persists in PostHog's own storage, so a later opt-in would boot opted out.
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
  client = posthog;
  posthog.register({ app_version: appVersion(), surface: analyticsSurface() });
  const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
  if (!localStorage.getItem("omb-installed")) {
    localStorage.setItem("omb-installed", new Date().toISOString());
    posthog.capture("app_first_open", { platform });
  }
  posthog.capture("app_opened", { platform });
  for (const call of pending.splice(0)) call(posthog);
}

export function analyticsSurface(): "local" | "server" {
  return globalThis.window?.ogb?.environments ? "local" : "server";
}

function whenReady(call: (ph: PostHog) => void) {
  if (!analyticsEnabled()) return;
  if (client) call(client);
  else if (loading) pending.push(call);
}

export function track(event: string, props?: Record<string, unknown>) {
  whenReady((ph) => ph.capture(event, props));
}

// Sends a personal identifier, so it is gated on analyticsEnabled(), not on opt_out_capturing() alone.
export function identifyEmail(email: string) {
  whenReady((ph) => {
    ph.identify(email, { email });
    ph.capture("email_submitted");
  });
}

const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
