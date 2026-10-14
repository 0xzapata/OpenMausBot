import { useMemo } from "react";
import { AudioLines, Check, Minus, X } from "lucide-react";

import { formatCallDuration } from "../../shared/live-call";
import { callRecordIsPartial, callRecordLines, type CallRecordLine } from "@/lib/call-record";
import { t } from "@/lib/i18n";
import { activityStepLabel } from "@/lib/live-activity";
import type { Message } from "@/state/store";
import { approvalCardOutcome, toolLabel } from "./ApprovalCard";
import { WorkingDots } from "./WorkingIndicator";

type LineState = "done" | "stopped" | "open" | "neutral";

function lineState(line: CallRecordLine, busy: boolean): LineState {
  if (line.kind === "step") {
    if (line.tool.ok === undefined) return busy ? "open" : "neutral";
    return line.tool.ok ? "done" : "stopped";
  }
  if (line.card.expired) return "stopped";
  if (!line.card.answered) return "open";
  return line.card.answered === "allow" ? "done" : "stopped";
}

function stepStatus(state: LineState): string | null {
  if (state === "done") return t("toolDetail.completed");
  if (state === "stopped") return t("toolDetail.failed");
  if (state === "open") return t("toolDetail.running");
  return null;
}

function lineText(line: CallRecordLine): string {
  if (line.kind === "step") return activityStepLabel(line.tool);
  const outcome = line.card.expired === true
    ? t("chat.callRecord.expired")
    : approvalCardOutcome(line.card) ?? t("chat.callRecord.waiting");
  const text = t("chat.callRecord.approval", { outcome, action: toolLabel(line.card.tool) });
  return line.card.answeredBy?.via === "call" ? `${text} · ${t("approval.status.byVoice")}` : text;
}

export function CallRecordRow({ message, transcript, botName, busy, hasMore }: {
  message: Message;
  transcript: readonly Message[];
  botName: string;
  busy: boolean;
  hasMore: boolean;
}) {
  const call = message.call;
  const callId = call?.callId;
  const lines = useMemo(() => (callId === undefined ? [] : callRecordLines(transcript, callId)), [transcript, callId]);
  if (!call) return null;
  const title = call.title?.trim() || t("chat.callRecord.title", { name: botName });
  const duration = formatCallDuration(call.seconds);
  const partial = callRecordIsPartial(transcript, call, hasMore);
  // A labelled group, not a <section>: a named section is a landmark, and every call would add one.
  return (
    <div
      role="group"
      data-testid="call-record"
      aria-label={t("chat.callRecord.label", { title, duration })}
      title={new Date(call.endedAt).toLocaleString()}
      className="mx-auto flex w-fit max-w-[min(32rem,90%)] flex-col items-center gap-1 rounded-2xl border border-hairline/40 bg-panel px-4 py-2 text-[13px] text-ink-secondary"
    >
      <div className="flex max-w-full items-center gap-2">
        <AudioLines size={14} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="min-w-0 truncate font-medium text-ink">{title}</span>
        <span className="shrink-0 tabular-nums">{`· ${duration}`}</span>
      </div>
      {lines.length > 0 && (
        <ul className="flex max-w-full min-w-0 flex-col gap-0.5 text-[12.5px]">
          {lines.map((line) => {
            const state = lineState(line, busy);
            const status = line.kind === "step" ? stepStatus(state) : null;
            return (
              <li key={line.id} className="flex items-center gap-1.5">
                <span className="shrink-0" aria-hidden="true">
                  {state === "open" ? (
                    <WorkingDots size={3} />
                  ) : state === "done" ? (
                    <Check size={12} className="text-success" />
                  ) : state === "stopped" ? (
                    <X size={12} className="text-danger" />
                  ) : (
                    <Minus size={12} className="text-ink-tertiary" />
                  )}
                </span>
                <span className="min-w-0 truncate">
                  {lineText(line)}
                  {status && <span className="sr-only">{` (${status})`}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {partial && <p className="max-w-full text-center text-[12px] text-ink-tertiary">{t("chat.callRecord.partial")}</p>}
    </div>
  );
}
