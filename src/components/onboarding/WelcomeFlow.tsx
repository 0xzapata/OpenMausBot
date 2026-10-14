import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { MausAvatar } from "@/components/Avatar";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { setEmailGateDone, track } from "@/lib/analytics";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausMotion, MausState } from "@/lib/mascot";
import {
  beatWidth,
  beatsFor,
  completionPatch,
  flowDotsShown,
  nextBeat,
  previousBeat,
  type BeatId,
} from "@/lib/onboarding";
import { api, useStore, type Bot } from "@/state/store";
import { EnginesBeat } from "./beats/EnginesBeat";
import { HelloBeat } from "./beats/HelloBeat";
import { MeetYourBotBeat } from "./beats/MeetYourBotBeat";
import { PermissionsBeat } from "./beats/PermissionsBeat";
import { PhoneBeat } from "./beats/PhoneBeat";
import { QuietButton } from "./beats/shared";
import { withViewTransition } from "./view-transition";
import { ProgressDots } from "./ProgressDots";
import { FeatureReel } from "./reel/FeatureReel";

const MASCOT_FOR_BEAT: Record<BeatId, MausState> = {
  hello: "happy",
  reel: "curious",
  engines: "searching",
  permissions: "listening",
  phone: "sending",
  bot: "celebrate",
};

function beatTitle(beat: BeatId): string | null {
  switch (beat) {
    case "hello":
      return t("onboarding.welcome", { app: brand().name });
    case "engines":
      return t("onboarding.engines.title");
    case "permissions":
      return t("onboarding.perms.title");
    case "bot":
      return t("onboarding.bot.title");
    case "reel":
      return t("onboarding.reel.title");
    case "phone":
      return t("onboarding.phone.title");
  }
}

type Motion = Exclude<MausMotion, "none">;

export function WelcomeFlow({
  bot,
  onDone,
  replay = false,
  initialBeat,
  embedded = false,
  reel = true,
  dictation,
  entrance = "arrive",
  hosted = false,
  onOpenOrganisation,
}: {
  bot: Bot | null;
  onDone: () => void;
  replay?: boolean;
  initialBeat?: BeatId;
  embedded?: boolean;
  reel?: boolean;
  dictation?: boolean;
  entrance?: Motion;
  hosted?: boolean;
  onOpenOrganisation?: () => void;
}) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const beats = beatsFor({ dictation: dictation ?? capabilities.dictation.available, reel, hosted });
  const [beat, setBeat] = useState<BeatId>(() => (initialBeat && beats.includes(initialBeat) ? initialBeat : "hello"));
  const [mascot, setMascot] = useState<MausState>(MASCOT_FOR_BEAT[beat]);
  const [motion, setMotion] = useState<{ kind: Motion; key: number }>({ kind: "blink", key: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const finishing = useRef(false);

  const bump = useCallback((kind: Motion) => setMotion((m) => ({ kind, key: m.key + 1 })), []);

  // One frame late: a motion issued in the avatar's mounting commit is lost.
  useEffect(() => {
    const frame = requestAnimationFrame(() => bump(entrance));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    track("onboarding_step", { step: beat, replay });
  }, [beat, replay]);

  const go = useCallback(
    (target: BeatId) => {
      withViewTransition(() => {
        setBeat(target);
        setMascot(MASCOT_FOR_BEAT[target]);
      });
      bump("switch");
    },
    [bump],
  );

  const finish = useCallback(
    async (reason: "completed" | "skipped") => {
      if (finishing.current) return;
      finishing.current = true;
      track("onboarding_completed", { reason, at: beat, replay });
      setEmailGateDone("submitted");
      onDone();
      try {
        const config = await api("/api/config", { method: "PUT", body: JSON.stringify(completionPatch()), signal: AbortSignal.timeout(10_000) });
        dispatch({ type: "configStatus", config });
      } catch {
      }
    },
    [beat, dispatch, onDone, replay],
  );

  const next = nextBeat(beats, beat);
  const previous = previousBeat(beats, beat);
  const advance = useCallback(() => {
    if (next) go(next);
    else void finish("completed");
  }, [next, go, finish]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void finish("skipped");
      return;
    }
    if (event.key !== "Tab" || !cardRef.current) return;
    const focusable = Array.from(
      cardRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const card = cardRef.current;
    if (!card || card.contains(document.activeElement)) return;
    const target =
      card.querySelector<HTMLElement>("[autofocus], input, textarea, select") ??
      card.querySelector<HTMLElement>("[data-primary]") ??
      card;
    target.focus({ preventScroll: true });
  }, [beat]);

  const hello = beat === "hello";
  const title = beatTitle(beat);
  const logo = hello ? brand().logo : undefined;
  const beatProps = { onNext: advance, onSkip: advance, setMascot, bump };
  const current = beats.indexOf(beat) + 1;

  return (
    <div
      className={cn(
        "flex items-center justify-center bg-app p-3 sm:p-8",
        embedded ? "relative h-full w-full" : "fixed inset-0 z-50",
      )}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("onboarding.dialog")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="welcome-card relative flex max-h-full w-full flex-col overflow-y-auto rounded-2xl border border-hairline/40 bg-panel p-5 sm:p-8 shadow-[0_30px_80px_-28px_rgba(0,0,0,0.45),0_8px_24px_-12px_rgba(0,0,0,0.25)] outline-none"
        style={{ maxWidth: beatWidth(beat) }}
      >
        <QuietButton onClick={() => void finish("skipped")} className="absolute right-4 top-4">
          {t("onboarding.skipTour")}
        </QuietButton>

        <div className={cn("flex shrink-0", hello ? "flex-col items-center" : "items-center gap-3")}>
          <div className="welcome-maus flex shrink-0">
            {logo ? (
              <img src={logo} alt="" width={72} height={72} className="h-[72px] w-[72px] object-contain" />
            ) : (
              <MausAvatar
                color="green"
                state={mascot}
                motion={motion.kind}
                motionKey={motion.key}
                size={hello ? 72 : 40}
                label={brand().name}
              />
            )}
          </div>
          {title && (
            <h1 className={cn("welcome-title font-semibold text-ink", hello ? "mt-4 text-[20px]" : "text-[18px]")}>
              {title}
            </h1>
          )}
        </div>

        <div key={beat} className={cn("flex flex-col", beat === "engines" ? "min-h-0" : "shrink-0")}>
          {beat === "hello" && <HelloBeat {...beatProps} hosted={hosted} />}
          {beat === "reel" && <FeatureReel {...beatProps} />}
          {beat === "engines" && <EnginesBeat {...beatProps} hosted={hosted} onOpenOrganisation={onOpenOrganisation} />}
          {beat === "permissions" && <PermissionsBeat {...beatProps} />}
          {beat === "phone" && <PhoneBeat {...beatProps} />}
          {beat === "bot" && (
            <MeetYourBotBeat
              bot={bot}
              onFinish={() => void finish("completed")}
              setMascot={setMascot}
              bump={bump}
            />
          )}
        </div>

        <div className="mt-6 flex shrink-0 items-center justify-between">
          {previous ? (
            <QuietButton onClick={() => go(previous)}>{t("onboarding.back")}</QuietButton>
          ) : (
            <span />
          )}
          {flowDotsShown(beat) ? <ProgressDots items={beats.map((id) => ({ id }))} index={current - 1} /> : <span />}
          <span className="text-[11px] text-ink-secondary" aria-live="polite">
            {t("onboarding.progress", { current, total: beats.length })}
          </span>
        </div>
      </div>
    </div>
  );
}
