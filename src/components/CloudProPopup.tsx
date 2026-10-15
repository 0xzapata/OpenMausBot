import { useEffect, useState } from "react";
import { Check, Crown, X } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { identifyEmail, track } from "@/lib/analytics";
import { buyOfferAllowed, cloudIntroView, cloudPlanLine, cloudPlanView, moneyBackLine, usd, type CloudSource } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { cloudPlanFromAccount, type CloudPlanFacts } from "@/lib/usage-snapshot";
import { NotNowButton } from "./NoticeCard";

export const CLOUD_PRO_POPUP_SOURCE = "update_popup" satisfies CloudSource;

export type CloudProPopupAction = "shown" | "upgrade" | "manage" | "see_plans" | "not_now" | "close";

export interface CloudProPopupView {
  /** Everything stays in the app: buyers go to the Add a Cloud dialog, payers to Settings → MausBot Cloud. */
  primary: { action: "upgrade" | "manage"; label: string; via: "checkout" | "settings" };
  /** Compare plans, for someone who can buy: the dialog lists every plan. A payer has nothing to compare there yet. */
  seePlans: boolean;
  plan: CloudPlanFacts["plan"] | "trial";
  signedIn: boolean;
  email: string | null;
  badge: string | null;
  points: string[];
  price: string | null;
  moneyBack: string | null;
  current: string | null;
}

export function cloudProPopupView(account: CloudAccountState | null, offer: CloudOffer | null | undefined): CloudProPopupView | "loading" | "offline" {
  const view = cloudPlanView(account);
  if (view.kind === "unknown" || view.kind === "connecting") return "loading";
  if (view.kind === "unverified") return "offline";
  const facts = cloudPlanFromAccount(account);
  const signedIn = account?.status === "connected";
  const who = { plan: facts.trial ? "trial" as const : facts.plan, signedIn, email: signedIn ? account?.account?.email ?? null : null };
  const included = [t("cloudIntro.routines"), t("cloudIntro.phone"), t("cloudIntro.included")];
  if (buyOfferAllowed(view)) {
    if (offer === undefined) return "loading";
    if (offer === null) return "offline";
    const intro = cloudIntroView(offer);
    return {
      ...who,
      primary: { action: "upgrade", via: "checkout", label: t(intro ? "cloudIntro.start" : "cloudProPopup.upgrade") },
      seePlans: true,
      badge: intro?.badge ?? null,
      points: intro?.points ?? included,
      price: intro?.price ?? t("pro.fromPrice", { price: usd(Math.min(...offer.plans.map(plan => plan.amount)) / 100) }),
      moneyBack: moneyBackLine(offer),
      current: null,
    };
  }
  return {
    ...who,
    // Every plan manages in the app. Personal → Pro is not self-serve yet, so no "Upgrade" that ends at "email us".
    primary: { action: "manage", via: "settings", label: t("cloudProPopup.manage") },
    seePlans: false,
    badge: null,
    points: included,
    price: null,
    moneyBack: null,
    current: view.kind === "reauth" ? t("pro.reauthShort") : cloudPlanLine(view),
  };
}

const CLICKS: ReadonlySet<CloudProPopupAction> = new Set(["upgrade", "manage", "see_plans"]);

export function reportCloudProPopup(action: CloudProPopupAction, who: Pick<CloudProPopupView, "plan" | "signedIn" | "email">) {
  if (who.email && CLICKS.has(action)) identifyEmail(who.email, { submitted: false });
  track("cloud_pro_popup", { action, plan: who.plan, signed_in: who.signedIn });
}

const TITLE = "cloud-pro-popup-title";

export function otherDialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]:not([data-cloud-pro-popup])') !== null;
}

export function useOtherDialogOpen(watch: boolean): boolean {
  const [, setOpen] = useState(false);
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => setOpen(otherDialogOpen()), 1_000);
    return () => clearInterval(timer);
  }, [watch]);
  return watch && otherDialogOpen();
}

const PRIMARY = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function CloudProPopup({ view, onPrimary, onSeePlans, onNotNow, onClose }: {
  view: CloudProPopupView; onPrimary: () => void; onSeePlans: () => void; onNotNow: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    document.getElementById(TITLE)?.focus();
    return () => { if (opener?.isConnected && opener !== document.body) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(document.querySelector("[data-cloud-pro-popup]")?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement), step = event.shiftKey ? -1 : 1;
      controls[at === -1 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={TITLE} aria-describedby="cloud-pro-popup-body" data-cloud-pro-popup={view.plan}
      className="relative max-h-full w-full max-w-[440px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-6 text-ink shadow-2xl">
      <div className="flex items-center gap-2.5 pe-8">
        <Crown size={18} className="shrink-0 text-accent-text" aria-hidden="true" />
        <h2 id={TITLE} tabIndex={-1} className="text-[17px] font-semibold outline-none">{t("cloudProPopup.title")}</h2>
      </div>
      {view.badge && <p className="mt-3 inline-flex rounded-full bg-accent/15 px-2 py-0.5 text-[12px] font-medium text-accent-text">{view.badge}</p>}
      <div id="cloud-pro-popup-body">
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-secondary">{t("cloudIntro.body")}</p>
        <ul className="mt-3 flex flex-col gap-2 text-[13px]">
          {view.points.map(point => <li key={point} className="flex items-start gap-2"><Check size={15} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />{point}</li>)}
        </ul>
        {view.current && <p className="mt-3 text-[13px] font-medium">{view.current}</p>}
        {view.price && <p className="mt-3 text-[12.5px] text-ink-secondary">{view.price}</p>}
        {view.moneyBack && <p className="text-[12.5px] text-ink-secondary">{view.moneyBack}</p>}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" className={PRIMARY} onClick={onPrimary}>{view.primary.label}</button>
        {view.seePlans && <button type="button" className="inline-flex items-center gap-1 py-2 text-[13px] text-ink-secondary underline underline-offset-2 hover:text-ink" onClick={onSeePlans}>
          {t("pro.seePlans")}
        </button>}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11.5px] text-ink-secondary">{t("pro.disclaimer")}</p>
        <NotNowButton onClick={onNotNow} />
      </div>
      <button type="button" onClick={onClose} aria-label={t("cloudAdd.close")} className="ui-icon-button absolute end-4 top-4"><X size={16} /></button>
    </div>
  </div>;
}
