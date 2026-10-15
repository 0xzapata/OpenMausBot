import { createManagedDesktopStore, retryDelay, unreadableRecord } from "./managed-desktop.mjs";
import { CLOUD_MACHINE_CONNECTABLE, parseCloudCredit, parseCloudOffer, parseCloudPurchase, parseCloudSummary, parseCloudTrial, parsePairingGrant, parsePublicOffer, withoutTrial } from "./cloud-home.mjs";

export const CLOUD_ORIGIN = "https://cloud.openmausbot.com";
const TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const PRIVATE_CODE = /^[A-Za-z0-9_-]{43}$/;
const TIER = /^[a-z][a-z0-9-]{0,23}$/;
const REFRESH_MS = 60_000;
const STEADY_MS = 15 * 60_000;
const SETUP_REFRESH_MS = 15_000;
const CHECKING_AFTER = 2;
const MAX_ENROLL_SECONDS = 1800;
const OFFER_MS = 10 * 60_000, OFFER_RETRY_MS = 30_000;
const CHECKOUT_WATCH_MS = 30 * 60_000, CHECKOUT_KEPT_MS = 24 * 3600_000;
export const CHECKOUT_SOURCES = Object.freeze(["app_card", "app_howto", "app_menu", "app_settings", "app_routines"]);
const CHECKOUT_ORIGIN = "https://checkout.dodopayments.com", TEST_CHECKOUT_ORIGIN = "https://test.checkout.dodopayments.com";
/** Only Dodo's own HTTPS checkout origin, with no credentials and no fragment; anything else is never opened. */
export function checkoutDestination(value, { fixture = false } = {}) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const allowed = fixture ? [CHECKOUT_ORIGIN, TEST_CHECKOUT_ORIGIN] : [CHECKOUT_ORIGIN];
  if (!allowed.includes(url.origin) || url.username || url.password || url.hash || value.includes("#")) return null;
  return url.href;
}
// Never accept an address from the renderer.
export function cloudOrigin(value = CLOUD_ORIGIN, fixture = false) {
  const url = new URL(value);
  if (value !== url.origin || (value !== CLOUD_ORIGIN && !(fixture && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid MausBot Cloud address.");
  }
  return value;
}
export const createCloudAccountStore = createManagedDesktopStore;
// oxlint-disable-next-line no-control-regex
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0;
/** Display only: the last verified plan, never an entitlement. */
function planHint(value) {
  if (!value || typeof value !== "object" || typeof value.active !== "boolean") return null;
  return { ...(typeof value.tier === "string" && TIER.test(value.tier) ? { tier: value.tier } : {}), active: value.active };
}
/** Only the Admin's own JSON "invalid_token" ends a sign-in; a 401/403 page from Cloudflare or a proxy does not. */
const signInEnded = error => [401, 403].includes(error?.status) && error.code === "invalid_token";
const sameHint = (left, right) => (left?.tier ?? null) === (right?.tier ?? null) && (left?.active ?? null) === (right?.active ?? null);

export function createCloudAccountClient({ store, openBrowser, platform, deviceName, appVersion,
  origin = CLOUD_ORIGIN, fixture = false, fetch: fetcher = globalThis.fetch, now = Date.now, onState = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, warn = message => console.warn(message) }) {
  origin = cloudOrigin(origin, fixture);
  let grant = null, issued = null, cleanup = null, pending = null, cleanupNeeded = false;
  let value = { status: "signed-out", message: "restoring" }, generation = 0, timer = null, closed = false, clearing = null, refreshing = null;
  let verifiedUntil = 0, restoring = false, controller = new AbortController(), failures = 0;
  let plan = null, savedHint = null;
  let offerCache = null, offerPending = null;
  let opened = null;
  const newerPlans = new Set();
  const lastPlan = () => plan && grant && plan.accountId === grant.account.id ? { ...(plan.tier ? { tier: plan.tier } : {}), active: plan.active } : null;
  const view = (status, message) => {
    const known = status === "connected" ? null : lastPlan();
    return { status, ...(message ? { message } : {}), ...(grant ? { account: grant.account, deviceId: grant.device.id, expiresAt: grant.expiresAt } : {}), ...(known ? { lastPlan: known } : {}) };
  };
  const checkout = () => opened && now() - opened.startedAt < CHECKOUT_KEPT_MS ? { plan: opened.plan, startedAt: opened.startedAt, ...(opened.signIn ? { signIn: true } : {}) } : null;
  const withCheckout = current => { const open = checkout(); return open ? { ...current, checkout: open } : current; };
  const state = () => {
    if (value.status === "connected") {
      if (grant && grant.expiresAt <= now()) return structuredClone(withCheckout(view("reauth-required", "expired")));
      if (now() >= verifiedUntil) return structuredClone(withCheckout(view("unavailable", "verification-expired")));
      if (failures >= CHECKING_AFTER) return structuredClone(withCheckout({ ...value, checking: true }));
    }
    return structuredClone(withCheckout(value));
  };
  const watching = () => Boolean(opened && now() - opened.startedAt < CHECKOUT_WATCH_MS);
  const publish = next => { value = next; onState(state()); return state(); };
  const record = (saved, hint) => ({ ...saved, ...(hint ? { planHint: hint } : {}) });
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = (work, delay) => {
    stopTimer();
    if (!closed) { timer = setTimer(() => { timer = null; void work().catch(() => {}); }, Math.max(1, delay)); timer?.unref?.(); }
  };
  const reset = () => { generation++; stopTimer(); controller.abort(); controller = new AbortController(); pending = null; verifiedUntil = 0; failures = 0; return generation; };
  const current = stamp => !closed && generation === stamp;
  const versionHeader = text(appVersion, 40) && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(appVersion) ? { "x-openmausbot-version": appVersion } : {};
  async function request(route, { method = "GET", body, token, signal = controller.signal, path = `/api/cloud/desktop/${route}` } = {}) {
    const response = await fetcher(`${origin}${path}`, {
      method, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}`, ...versionHeader } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const reader = response.body?.getReader(), chunks = []; let size = 0;
    try {
      if (reader) while (true) {
        const { done, value: chunk } = await reader.read(); if (done) break;
        size += chunk.byteLength; if (size > 64 * 1024) throw new Error("Cloud response too large.");
        chunks.push(chunk);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      if (!response.ok) throw Object.assign(new Error("Cloud request failed."), { status: response.status, opaque: true });
      throw new Error("Invalid Cloud response.");
    }
    if (!response.ok) throw Object.assign(new Error("Cloud request failed."), { status: response.status, code: data?.error, interval: data?.interval });
    return data;
  }
  function identity(result) {
    if (result?.cloudContractVersion !== 1 || !timestamp(result.expiresAt) || !text(result.device?.id, 128) ||
      !text(result.account?.id, 128) || !text(result.account?.email, 254)) throw new Error("Invalid Cloud identity.");
    return { expiresAt: result.expiresAt, device: { id: result.device.id }, account: { id: result.account.id, email: result.account.email } };
  }
  function validateGrant(saved) {
    if (saved?.origin !== origin || !TOKEN.test(saved.token)) throw new Error("Invalid Cloud credential.");
    return { origin, token: saved.token, ...identity({ ...saved, cloudContractVersion: 1 }) };
  }
  /** A plan newer than this app is paid with its tier, never a lockout; a malformed tier is no tier. */
  function entitlement(input) {
    const newer = typeof input?.plan === "string" && !["free", "pro"].includes(input.plan) && TIER.test(input.plan);
    if (!input || !(newer || ["free", "pro"].includes(input.plan)) || !["active", "inactive"].includes(input.status) ||
      !(input.expiresAt === null || timestamp(input.expiresAt)) || !Number.isSafeInteger(input.version) || input.version < 0) throw new Error("Invalid Cloud entitlement.");
    const plan = input.plan === "free" ? "free" : "pro";
    if (input.status === "active" && (plan !== "pro" || input.expiresAt === null || input.expiresAt <= now())) throw new Error("Invalid active Cloud entitlement.");
    if (newer && !newerPlans.has(input.plan)) { newerPlans.add(input.plan); warn(`[cloud] OMB Cloud sent plan "${input.plan}", newer than this app; treating it as paid.`); }
    const tier = typeof input.tier === "string" && TIER.test(input.tier) ? input.tier : newer ? input.plan : undefined;
    return { plan, ...(tier ? { tier } : {}), status: input.status,
      expiresAt: input.expiresAt, version: input.version };
  }
  async function revoke(previous) {
    try { await request("session", { method: "DELETE", body: {}, token: previous.token, signal: AbortSignal.timeout(20_000) }); }
    catch (error) { if (![401, 403].includes(error?.status) || error.opaque) throw error; }
  }
  function homeTarget() {
    const current = state();
    const machine = current.status === "connected" ? current.machine : undefined;
    return machine?.origin && CLOUD_MACHINE_CONNECTABLE.includes(machine.status) ? { origin: machine.origin } : null;
  }
  function forget({ quiet = false } = {}) {
    if (clearing) return clearing;
    const previous = grant ?? issued ?? cleanup, stamp = reset();
    grant = null; issued = null; cleanup = previous; cleanupNeeded = true; plan = null; savedHint = null; opened = null;
    if (!quiet) publish({ status: "signed-out" });
    const operation = (async () => {
      const [persisted, revoked] = await Promise.allSettled([Promise.resolve().then(() => store.write(null)), previous ? revoke(previous) : Promise.resolve()]);
      if (persisted.status === "fulfilled") { cleanup = null; cleanupNeeded = false; }
      if (!current(stamp)) return state();
      if (persisted.status === "rejected") return publish({ status: "unavailable", message: "signout-storage-failed" });
      if (quiet) return state();
      return publish({ status: "signed-out", ...(revoked.status === "rejected" ? { message: "signout-local-only" } : {}) });
    })().finally(() => { if (clearing === operation) clearing = null; });
    clearing = operation; return operation;
  }
  const signOut = () => forget();
  async function synchronize(stamp) {
    if (!grant || !current(stamp)) return state();
    if (grant.expiresAt <= now()) { stopTimer(); return publish(view("reauth-required", "expired")); }
    try {
      const previous = grant, result = await request("session", { token: previous.token });
      if (!current(stamp) || grant !== previous) return state();
      const next = identity(result);
      if (next.device.id !== previous.device.id || next.account.id !== previous.account.id || next.account.email !== previous.account.email || next.expiresAt <= now()) {
        throw Object.assign(new Error("Cloud identity changed."), { status: 401, code: "invalid_token" });
      }
      const access = entitlement(result.entitlement);
      const machine = parseCloudSummary(result.cloud);
      const purchase = parseCloudPurchase(result.cloud?.purchase);
      const trial = parseCloudTrial(result.cloud?.trial), credit = parseCloudCredit(result.cloud?.credit), offer = parseCloudOffer(result.offer);
      const hint = access.plan === "pro" ? { ...(access.tier ? { tier: access.tier } : {}), active: access.status === "active" } : null;
      if (next.expiresAt !== previous.expiresAt) {
        const replacement = { ...previous, expiresAt: next.expiresAt };
        await store.write(record(replacement, hint));
        if (!current(stamp) || grant !== previous) return state();
        grant = replacement; savedHint = hint;
      } else if (!sameHint(savedHint, hint)) {
        try { await store.write(record(previous, hint)); savedHint = hint; } catch {}
        if (!current(stamp) || grant !== previous) return state();
      }
      plan = hint ? { accountId: grant.account.id, ...hint } : null;
      failures = 0;
      verifiedUntil = Math.min(grant.expiresAt, now() + STEADY_MS,
        access.status === "active" && access.expiresAt !== null ? access.expiresAt : Infinity);
      publish({ ...view("connected"), entitlement: access, ...(machine ? { machine } : {}), ...(purchase ? { purchase } : {}),
        ...(trial ? { trial } : {}), ...(credit ? { credit } : {}), ...(offer ? { offer } : {}), verifiedAt: now(), verifiedUntil });
      const settingUp = machine?.status === "provisioning" || (access.status === "active" && !machine) || Boolean(purchase)
        || (watching() && access.status !== "active");
      schedule(refresh, Math.min(settingUp ? SETUP_REFRESH_MS : REFRESH_MS, verifiedUntil - now()));
    } catch (error) {
      if (!current(stamp)) return state();
      if (signInEnded(error)) { verifiedUntil = 0; failures = 0; stopTimer(); return publish(view("reauth-required", "access-ended")); }
      failures++;
      if (value.status === "connected") publish(value);
      else publish(view("unavailable", "unreachable"));
      schedule(refresh, Math.min(retryDelay(failures), grant.expiresAt - now()));
    }
    return state();
  }
  function refresh() {
    if (clearing) return clearing;
    if (refreshing?.stamp === generation) return refreshing.operation;
    const entry = { stamp: generation, operation: null };
    entry.operation = synchronize(generation).finally(() => { if (refreshing === entry) refreshing = null; });
    refreshing = entry; return entry.operation;
  }
  async function poll() {
    const attempt = pending, stamp = generation;
    if (!attempt || !current(stamp)) return state();
    if (now() >= attempt.expiresAt) { pending = null; opened = null; return publish({ status: "signed-out", message: "enrollment-expired" }); }
    try {
      const result = await request("token", { method: "POST", body: { deviceCode: attempt.deviceCode } });
      const next = validateGrant({ origin, token: result.accessToken, ...identity(result) });
      if (!current(stamp)) { await revoke(next).catch(() => {}); return state(); }
      if (next.expiresAt <= now()) throw new Error("Expired Cloud credential.");
      issued = next;
      await store.write(next);
      if (!current(stamp)) return state();
      grant = next; issued = null; pending = null; savedHint = null;
      if (plan?.accountId !== next.account.id) plan = null;
      const intent = opened;
      const signedIn = await refresh();
      if (intent && current(stamp) && opened === intent && signedIn.status === "connected") {
        if (signedIn.entitlement?.plan !== "free" || signedIn.purchase || signedIn.machine) { opened = null; return publish(value); }
        if (!signedIn.offer) return (await openCheckout(intent.plan, intent.source).catch(() => ({ state: state() }))).state;
      }
      return signedIn;
    } catch (error) {
      if (!current(stamp)) return state();
      if (issued) return signOut();
      if (error?.code === "slow_down") attempt.interval = Math.min(60_000, Math.max(attempt.interval + 5000, Number.isSafeInteger(error.interval) ? error.interval * 1000 : 0));
      else if (["access_denied", "expired_token", "invalid_grant"].includes(error?.code)) { pending = null; opened = null; return publish({ status: "signed-out", message: "enrollment-ended" }); }
      else if (error?.status && !error.opaque && error.code !== "authorization_pending" && error.status !== 429) { pending = null; opened = null; return publish({ status: "signed-out", message: "signin-failed" }); }
      schedule(poll, Math.min(attempt.interval, attempt.expiresAt - now()));
      return state();
    }
  }
  async function begin(intent = null) {
    if (closed || restoring || clearing || grant || issued || cleanupNeeded) throw new Error("Sign out before starting another Cloud connection.");
    const stamp = reset();
    opened = intent ? { plan: intent.plan, source: intent.source, startedAt: now(), signIn: true } : null;
    publish({ status: "connecting" });
    try {
      if (!text(deviceName, 100) || !["darwin", "win32", "linux"].includes(platform)) throw new Error("Invalid desktop.");
      const result = await request("authorize", { method: "POST", body: { deviceName, platform, ...(text(appVersion, 40) ? { appVersion } : {}) } });
      if (!current(stamp)) return state();
      if (result.cloudContractVersion !== 1 || !PRIVATE_CODE.test(result.deviceCode) || !CODE.test(result.userCode) ||
        result.verificationUriComplete !== `${origin}/cloud/desktop?code=${result.userCode}` || !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > MAX_ENROLL_SECONDS ||
        !Number.isSafeInteger(result.interval) || result.interval < 5 || result.interval > 60) throw new Error("Invalid Cloud authorization.");
      const next = intent ? `&${new URLSearchParams({ next: "checkout", plan: intent.plan, src: intent.source })}` : "";
      pending = { deviceCode: result.deviceCode, verificationUri: `${result.verificationUriComplete}${next}`, expiresAt: now() + result.expiresIn * 1000, interval: result.interval * 1000 };
      publish({ status: "connecting", enrollment: { userCode: result.userCode, expiresAt: pending.expiresAt } });
      await openBrowser(pending.verificationUri);
      if (current(stamp)) schedule(poll, pending.interval);
    } catch { if (current(stamp)) { pending = null; opened = null; publish({ status: "signed-out", message: "signin-failed" }); } }
    return state();
  }
  async function openCheckout(plan, source) {
    if (typeof plan !== "string" || !TIER.test(plan) || !CHECKOUT_SOURCES.includes(source)) throw new Error("Invalid Cloud checkout.");
    const current = state();
    if (current.status === "signed-out" && !grant) return { outcome: "signing-in", state: await begin({ plan, source }) };
    if (current.status !== "connected" || !grant) throw new Error("Sign in to MausBot Cloud before choosing a plan.");
    const signedIn = grant;
    let destination;
    try {
      const result = await request("checkout", { method: "POST", body: { plan, source }, token: signedIn.token });
      destination = checkoutDestination(result?.url, { fixture });
      if (result?.cloudContractVersion !== 1 || !destination) return { outcome: "failed", state: state() };
    } catch (error) {
      if (!error?.opaque && error?.status === 409) return { outcome: "conflict", state: await refresh() };
      if (!error?.opaque && error?.status === 429) return { outcome: "rate-limited", state: state() };
      if (signInEnded(error)) return { outcome: "failed", state: await refresh() };
      if (![404, 405, 501].includes(error?.status)) return { outcome: "failed", state: state() };
      destination = `${origin}/cloud?${new URLSearchParams({ checkout: "start", plan, src: source })}`;
    }
    if (grant !== signedIn) return { outcome: "failed", state: state() };
    await openBrowser(destination);
    opened = { plan, source, startedAt: now() };
    publish(value);
    schedule(refresh, SETUP_REFRESH_MS);
    return { outcome: "opened", state: state() };
  }
  /** A sign-in that may only be locked in the keychain is kept, never removed, and read again shortly. */
  async function restoreFailed(stamp, unreadable) {
    cleanupNeeded = true;
    if (unreadable) {
      const removed = await store.write(null).then(() => true, () => false);
      if (!current(stamp)) return state();
      if (removed) { cleanupNeeded = false; failures = 0; return publish({ status: "signed-out", message: "restore-removed" }); }
    }
    failures++;
    if (value.message !== "restore-failed") publish({ status: "unavailable", message: "restore-failed" });
    schedule(start, retryDelay(failures));
    return state();
  }
  async function start() {
    const stamp = generation;
    restoring = true; verifiedUntil = 0;
    let saved, restored = null, failed = false, unreadable = false;
    try { saved = await store.read(); } catch (error) { failed = true; unreadable = unreadableRecord(error); }
    if (!failed) try { restored = saved ? validateGrant(saved) : null; } catch { failed = unreadable = true; }
    restoring = false;
    if (!current(stamp)) return state();
    if (failed) return restoreFailed(stamp, unreadable);
    grant = restored; cleanupNeeded = false; failures = 0;
    savedHint = grant ? planHint(saved.planHint) : null;
    plan = grant && savedHint ? { accountId: grant.account.id, ...savedHint } : null;
    if (!grant) return ["restoring", "restore-failed"].includes(value.message) ? publish({ status: "signed-out" }) : state();
    return refresh();
  }
  return {
    state,
    start,
    begin: () => begin(),
    checkout: openCheckout,
    checkoutPending: watching,
    async signInAgain() {
      if (state().status !== "reauth-required") throw new Error("This computer is still signed in to MausBot Cloud.");
      publish({ status: "connecting" });
      const forgotten = await forget({ quiet: true });
      if (forgotten.status === "unavailable") return forgotten;
      return begin();
    },
    async reopen() {
      if (pending && value.status === "connecting" && pending.expiresAt > now()) await openBrowser(pending.verificationUri);
      return state();
    },
    cancel: () => { if (!pending && value.status !== "connecting") return Promise.resolve(state()); opened = null; return signOut(); },
    refresh, signOut,
    async openDashboard() { await openBrowser(`${origin}/cloud`); return state(); },
    async offer() {
      const current = state();
      if (current.status === "connected" && current.offer) return current.offer;
      if (!offerCache || now() >= offerCache.until) {
        offerPending ??= request(null, { path: "/api/public/config", signal: AbortSignal.timeout(10_000) }).then(
          config => { const offer = parsePublicOffer(config); offerCache = { value: offer, until: now() + (offer ? OFFER_MS : OFFER_RETRY_MS) }; return offer; },
          () => { offerCache = { value: null, until: now() + OFFER_RETRY_MS }; return null; },
        ).finally(() => { offerPending = null; });
        await offerPending;
      }
      return current.status === "connected" ? withoutTrial(offerCache.value) : offerCache.value;
    },
    async interest(kind) {
      if (kind !== "another_cloud") throw new Error("Invalid Cloud interest.");
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") throw new Error("Sign in to MausBot Cloud first.");
      const result = await request("interest", { method: "POST", body: { kind }, token: signedIn.token });
      if (result?.ok !== true) throw new Error("Invalid Cloud response.");
    },
    homeTarget,
    async growDisk(sizeGb) {
      const current = grant;
      if (!current || state().status !== "connected") throw new Error("My Cloud is not ready yet.");
      if (!Number.isSafeInteger(sizeGb) || sizeGb < 1 || sizeGb > 10_000) throw new Error("Invalid Cloud disk size.");
      let result;
      try { result = await request("disk", { method: "POST", body: { sizeGb }, token: current.token }); } catch (error) {
        if ([404, 405, 501].includes(error?.status)) return { supported: false };
        if ([409, 422].includes(error?.status)) return { supported: true, refused: true };
        throw error;
      }
      const disk = result?.disk;
      if (!disk || !Number.isSafeInteger(disk.gb) || !Number.isSafeInteger(disk.maxGb) || disk.gb < 1 || disk.maxGb < disk.gb) throw new Error("Invalid Cloud disk response.");
      return { supported: true, disk: { gb: disk.gb, maxGb: disk.maxGb } };
    },
    /** The code goes to main only, for one navigation, and is not kept. */
    async pairHome() {
      const target = homeTarget(), current = grant;
      if (!target || !current) throw new Error("My Cloud is not ready to connect yet.");
      const result = await request("pairing", { method: "POST", body: {}, token: current.token });
      const pairing = parsePairingGrant(result, target.origin, now());
      if (!pairing) throw new Error("Invalid Cloud pairing response.");
      return pairing;
    },
    close() { closed = true; reset(); },
  };
}

export function cloudMenuSublabel(state, date) {
  if (state?.status !== "connected") return null;
  const trial = state.trial;
  if (state.entitlement?.plan === "pro" && state.entitlement.status === "active") {
    return (trial?.state === "active" || trial?.state === "ending") ? `Free trial until ${date(trial.endsAt)}` : "Always on";
  }
  return state.machine || trial ? "Stopped" : null;
}

/** What the person's own Cloud page may show of the plan: never the account, a credential or an address. */
export function cloudPlanSnapshot(state, { notice = null } = {}) {
  const tier = state?.status === "connected" ? state.entitlement?.tier : state?.lastPlan?.tier;
  const named = typeof tier === "string" ? { tier } : {};
  const trial = state?.status === "connected"
    ? { ...(state.trial ? { trial: state.trial } : {}), ...(state.credit ? { credit: state.credit } : {}), ...(notice && state.trial ? { notice } : {}) } : {};
  if (state?.status === "connected" && state.entitlement?.plan === "pro") return { status: state.entitlement.status === "active" ? "paid" : "attention", ...named, ...trial };
  if (state?.status === "reauth-required") return { status: "signin", ...(state.lastPlan ? { tier: state.lastPlan.tier ?? "pro" } : {}) };
  if (state?.status !== "connected" && state?.lastPlan) return { status: "checking", ...named };
  return { status: "none", ...trial };
}
