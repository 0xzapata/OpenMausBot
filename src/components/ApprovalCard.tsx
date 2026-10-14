import { useState } from "react";
import { Check, ShieldCheck, Undo2, X } from "lucide-react";
import { api, ApiError, type Bot, type Message, type OptionCardData } from "@/state/store";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { composioActionPhrase, outboundSummary } from "@/lib/approval-summary";
import { niceDate, niceTime, scheduleLabel } from "@/lib/schedule-label";
import { cronScheduleLabel } from "../../shared/cron-label";
import { PROFILE_REQUEST_FIELDS, type ProfileRequestField } from "../../shared/profile-request";
import type { RoutineRequestSchedule } from "../../shared/routine-request";

interface ToolLabels {
  [tool: string]: LocaleKey;
}

const ROUTINE_SETTLED_LABEL = {
  create: "approval.status.routineScheduled",
  update: "approval.status.routineUpdated",
  pause: "approval.status.routinePaused",
  resume: "approval.status.routineResumed",
  run_now: "approval.status.routineRunQueued",
  delete: "approval.status.routineDeleted",
} as const;

const SKILL_SETTLED_LABEL = {
  create: "approval.status.skillEnabled",
  update: "approval.status.skillUpdated",
} as const;

const ROUTINE_APPLIED_LINE = {
  create: "approval.applied.routine.create",
  update: "approval.applied.routine.update",
  pause: "approval.applied.routine.pause",
  resume: "approval.applied.routine.resume",
  run_now: "approval.applied.routine.runNow",
  delete: "approval.applied.routine.delete",
} as const;

const SKILL_APPLIED_LINE = {
  create: "approval.applied.skill.create",
  update: "approval.applied.skill.update",
} as const;

const PROFILE_FIELD_LABEL: Record<ProfileRequestField, LocaleKey> = {
  name: "approval.applied.field.name",
  title: "approval.applied.field.title",
  description: "approval.applied.field.description",
  soul: "approval.applied.field.soul",
  cwd: "approval.applied.field.cwd",
  notifications: "approval.applied.field.notifications",
  speakReplies: "approval.applied.field.speakReplies",
};

export function approvalCardOutcome(card: OptionCardData): string | undefined {
  if (card.expired === true) return t("approval.status.expired");
  if (!card.answered) return undefined;
  if (card.undone === true) return t("approval.status.undone");
  const isProposal = Boolean(card.routineRequest || card.skillRequest || card.profileRequest || card.modelRequest || card.teamSetupRequest);
  if (card.answered !== "allow") return card.teamSetupRequest?.suggestion ? t("approval.status.notNow") : isProposal ? t("approval.status.cancelled") : t("approval.status.denied");
  if (card.teamSetupRequest) return card.teamSetupRequest.deletion ? "Bot deleted" : "Team setup applied";
  const routineAction = card.routineRequest?.operation.action;
  if (routineAction) return t(ROUTINE_SETTLED_LABEL[routineAction]);
  const skillAction = card.skillRequest?.action;
  if (skillAction) return t(SKILL_SETTLED_LABEL[skillAction]);
  if (card.profileRequest) return t("approval.status.profileUpdated");
  if (card.modelRequest) return t("approval.status.modelChanged");
  if (card.routineRequest) return t("approval.status.routineConfirmed");
  if (card.skillRequest) return t("approval.status.skillConfirmed");
  return t("approval.status.allowed");
}

export function toolLabel(tool?: string): string {
  if (!tool) return t("approval.tool.takeAction");
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ToolLabels = {
    Bash: "approval.tool.runCommand",
    Read: "approval.tool.readFile",
    Write: "approval.tool.writeFile",
    Edit: "approval.tool.editFile",
    WebFetch: "approval.tool.fetchWebPage",
    WebSearch: "approval.tool.searchWeb",
    schedule_routine: "approval.tool.scheduleRoutine",
    manage_routine: "approval.tool.changeRoutine",
    stage_skill: "approval.tool.enableSkill",
    update_skill: "approval.tool.updateSkill",
    update_profile: "approval.tool.updateProfile",
    // ACP drivers may send the protocol's toolCall kind as the tool, so every kind maps to a phrase ("shell" is
    // execute; "tool" is no kind at all).
    shell: "approval.tool.runCommand",
    edit: "approval.tool.editFile",
    read: "approval.tool.readFile",
    fetch: "approval.tool.fetchWebPage",
    delete: "approval.tool.deleteFile",
    think: "approval.tool.think",
    other: "approval.tool.takeAction",
    tool: "approval.tool.useTool",
  };
  const key = nice[tool];
  if (key) return t(key);
  return composioActionPhrase(tool.replace(/^mcp__[^_]+__/, "")) ?? bare;
}

function plainWhen(schedule: RoutineRequestSchedule): string {
  if (schedule.type === "once") {
    return new Date(schedule.at).toDateString() === new Date().toDateString()
      ? t("approval.applied.today", { time: niceTime(schedule.at) })
      : `${niceDate(schedule.at)}, ${niceTime(schedule.at)}`;
  }
  if (schedule.type === "cron") {
    const label = cronScheduleLabel(schedule);
    return label.startsWith("Cron ") ? "" : label;
  }
  if (schedule.type === "interval") return scheduleLabel({ ...schedule, anchorAt: schedule.anchorAt ?? 0 });
  return scheduleLabel(schedule);
}

export function appliedChange(card: OptionCardData, name: string): { line: string; canUndo: boolean } | undefined {
  const routine = card.routineRequest;
  if (routine) {
    const operation = routine.operation;
    const undo = routine.undo;
    const when = undo?.schedule && operation.action !== "pause" && operation.action !== "delete" && operation.action !== "run_now"
      ? plainWhen(undo.schedule)
      : "";
    const title = [
      undo?.name ?? (operation.action === "create" ? operation.routine.name : ""),
      operation.forBot ? t("approval.applied.forBot", { target: `@${operation.forBot.name}` }) : "",
    ].filter(Boolean).join(" · ") + (when ? `, ${when}` : "");
    const canUndo = operation.action === "create" ? Boolean(routine.resultId)
      : operation.action === "update" ? Boolean(undo?.before && undo.appliedUpdatedAt !== undefined)
        : operation.action === "pause" || operation.action === "resume" ? undo?.appliedUpdatedAt !== undefined
          : operation.action === "delete" ? Boolean(undo?.before)
            : false;
    return { line: t(ROUTINE_APPLIED_LINE[operation.action], { name, title }), canUndo };
  }
  const skill = card.skillRequest;
  if (skill) {
    return {
      line: t(SKILL_APPLIED_LINE[skill.action], { name, title: skill.name }),
      canUndo: skill.action === "create" || Boolean(skill.previous),
    };
  }
  const profile = card.profileRequest;
  if (profile) {
    const title = PROFILE_REQUEST_FIELDS.filter((field) => profile.changes[field] !== undefined)
      .map((field) => t(PROFILE_FIELD_LABEL[field])).join(", ");
    const line = profile.targetBotId === profile.botId
      ? t("approval.applied.profileOwn", { name, title })
      : t("approval.applied.profileOther", { name, target: `@${profile.targetName}`, title });
    return { line, canUndo: Boolean(profile.undo) };
  }
  const model = card.modelRequest;
  if (model) {
    const title = model.selection.model;
    const line = model.targetBotId === model.botId
      ? t("approval.applied.modelOwn", { name, title })
      : t("approval.applied.modelOther", { name, target: `@${model.targetName}`, title });
    return { line, canUndo: true };
  }
  return undefined;
}

function AppliedChangeLine({
  card,
  name,
  threadId,
  summary,
}: {
  card: OptionCardData;
  name: string;
  threadId?: string;
  summary: { line: string; canUndo: boolean };
}) {
  const [open, setOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string>();
  const undone = card.undone === true;
  const undo = () => {
    if (!threadId || !card.requestId || undoing) return;
    setUndoing(true);
    setError(undefined);
    api(`/api/threads/${threadId}/undo`, { method: "POST", body: JSON.stringify({ requestId: card.requestId }) })
      .catch((failure: unknown) => {
        setError(failure instanceof ApiError && failure.body?.code === "changed-since"
          ? t("approval.applied.changedSince")
          : t("approval.applied.undoFailed", { error: failure instanceof Error ? failure.message : String(failure) }));
      })
      .finally(() => setUndoing(false));
  };
  return (
    <div className="w-full max-w-[840px] text-[13px] text-ink-secondary" data-applied-change={name}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {undone ? <Undo2 size={14} className="shrink-0" /> : <Check size={14} className="shrink-0 text-success" />}
        <span className="min-w-0 break-words">
          {summary.line}
          {undone && <span> · {t("approval.applied.undone")}</span>}
        </span>
        {!undone && summary.canUndo && threadId && (
          <button
            type="button"
            onClick={undo}
            disabled={undoing}
            className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-inset disabled:opacity-60"
          >
            {undoing ? t("approval.applied.undoing") : t("approval.applied.undo")}
          </button>
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="rounded-md px-1.5 py-0.5 text-ink-tertiary hover:bg-inset hover:text-ink-secondary"
        >
          {open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
        </button>
      </div>
      {error && <div role="alert" className="mt-1 text-[12.5px] text-warning">{error}</div>}
      {open && (
        <pre
          tabIndex={0}
          aria-label={t("approval.aria.appliedDetails")}
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink"
        >
          {card.subtitle}
        </pre>
      )}
    </div>
  );
}

export function ApprovalCard({
  bot,
  message,
  threadId,
}: {
  bot?: Pick<Bot, "name">;
  message: Message;
  threadId?: string;
}) {
  const card = message.card;
  if (!card) return null;
  const applied = card.autoApplied === true && card.answered === "allow" && !card.held
    ? appliedChange(card, bot?.name ?? t("approval.someone"))
    : undefined;
  if (applied) return <AppliedChangeLine card={card} name={bot?.name ?? t("approval.someone")} threadId={threadId} summary={applied} />;
  const settled = card.answered;
  const expired = card.expired === true;
  const byVoice = card.answeredBy?.via === "call" ? <span className="text-ink-tertiary">· {t("approval.status.byVoice")}</span> : null;
  const isRoutineRequest = Boolean(card.routineRequest);
  const isSkillRequest = Boolean(card.skillRequest);
  const isProfileRequest = Boolean(card.profileRequest);
  const isTeamSetup = Boolean(card.teamSetupRequest);
  const routineAction = card.routineRequest?.operation.action;
  const skillAction = card.skillRequest?.action;
  const heldNote = tFromServer(card.heldCode, card.held);
  const outcome = approvalCardOutcome(card);
  const outbound = outboundSummary(card);
  const displayTool = isRoutineRequest
    ? routineAction === "create" ? "schedule_routine" : "manage_routine"
    : isSkillRequest
      ? skillAction === "update" ? "update_skill" : "stage_skill"
    : isProfileRequest
      ? "update_profile"
    : card.tool;
  const profileHeader = isProfileRequest && card.profileRequest
    ? card.profileRequest.targetBotId === card.profileRequest.botId
      ? t("approval.card.profileWantsToOwn", { name: bot?.name ?? t("approval.someone") })
      : t("approval.card.profileWantsToOther", {
          name: bot?.name ?? t("approval.someone"),
          target: card.profileRequest.targetName,
        })
    : undefined;

  return (
    <div
      data-tour={settled || expired ? undefined : "approval"}
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        settled || expired ? "border-hairline/30 opacity-70" : "border-accent/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">
          {isTeamSetup ? card.title : outbound ? outbound.headline : profileHeader ?? (
            <>
              {bot
                ? t("approval.card.namedWantsTo", { name: bot.name, action: toolLabel(displayTool) })
                : t("approval.card.wantsTo", { action: toolLabel(displayTool) })}
            </>
          )}
        </div>
        {displayTool && !isTeamSetup && !outbound && <span className="shrink-0 font-mono text-[11px] text-ink-secondary">{displayTool}</span>}
      </div>
      {outbound?.summary && <div className="mt-0.5 text-[13px] text-ink-secondary">{outbound.summary}</div>}

      <pre
        tabIndex={0}
        aria-label={
          isRoutineRequest
            ? t("approval.aria.routineDetails")
            : isSkillRequest
              ? t("approval.aria.skillDetails")
              : isProfileRequest
                ? t("approval.aria.profileChange")
                : t("approval.aria.details")
        }
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink"
      >
        {card.subtitle}
      </pre>

      {card.skillRequest && <SkillRequestPreview request={card.skillRequest} />}

      {heldNote && (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          {heldNote}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
        {outcome ? (
          <>
            {settled === "allow" && !expired ? <Check size={14} className="text-success" /> : <X size={14} />} {outcome}
            {byVoice}
          </>
        ) : (
          <>
            <ShieldCheck size={14} className="text-accent" />
            {isRoutineRequest || isSkillRequest || isProfileRequest || isTeamSetup
              ? t("approval.status.waitingConfirmation")
              : t("approval.status.waitingAnswer")}
          </>
        )}
      </div>
    </div>
  );
}
