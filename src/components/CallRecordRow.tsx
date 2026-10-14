// A finished Live call's record in its chat: what the call was (its title,
// or "Call with <bot>"), how long it lasted, and one line per thing the bot
// did on it: its steps by name (never their arguments) and its approvals
// with their outcomes. The call's spoken requests and the bot's answers stay
// inline where they were; this row only sums the call up, and opens the
// call's sheet, which shows the whole call in one place.
import { useMemo, useState } from "react";
import { AudioLines, ChevronRight } from "lucide-react";

import { formatCallDuration } from "../../shared/live-call";
import { callRecordIsPartial, callRecordLines } from "@/lib/call-record";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { CallLineItem, CallSheet } from "./CallSheet";

export function CallRecordRow({ message, transcript, botName, threadId, busy, hasMore }: {
  message: Message;
  /** The chat's active branch. The call's lines come from all of it, also
   * from steps that landed after this row (a turn still running at hang-up). */
  transcript: readonly Message[];
  botName: string;
  /** The chat the row is in: the sheet's answers resolve their files in it. */
  threadId?: string;
  /** The chat is working on something now: only then does a step that never
   * reported how it went read as running. */
  busy: boolean;
  /** Older messages remain on the server, beyond what the transcript holds. */
  hasMore: boolean;
}) {
  const [open, setOpen] = useState(false);
  const call = message.call;
  const callId = call?.callId;
  // Each call's lines are worked out again only when the transcript changes
  // (a message or a patch, not a streamed delta), not on every render: the
  // chat holds a row per call, and each walks the whole transcript.
  const lines = useMemo(() => (callId === undefined ? [] : callRecordLines(transcript, callId)), [transcript, callId]);
  if (!call) return null;
  const title = call.title?.trim() || t("chat.callRecord.title", { name: botName });
  const duration = formatCallDuration(call.seconds);
  const partial = callRecordIsPartial(transcript, call, hasMore);
  // A labelled group, not a <section>: a section with a name is a landmark,
  // and every call in a chat would add one to the page's landmark list.
  // A click anywhere on it opens the sheet; the title line is the button a
  // keyboard reaches, since a list cannot sit inside a button.
  return (
    <>
      <div
        role="group"
        data-testid="call-record"
        aria-label={t("chat.callRecord.label", { title, duration })}
        title={new Date(call.endedAt).toLocaleString()}
        onClick={() => setOpen(true)}
        className="mx-auto flex w-fit max-w-[min(32rem,90%)] cursor-pointer flex-col items-center gap-1 rounded-2xl border border-hairline/40 bg-panel px-4 py-2 text-[13px] text-ink-secondary transition-colors hover:border-hairline hover:bg-raised"
      >
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={t("chat.callRecord.open", { title })}
          className="flex max-w-full items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <AudioLines size={14} aria-hidden="true" className="shrink-0 text-accent" />
          <span className="min-w-0 truncate font-medium text-ink">{title}</span>
          <span className="shrink-0 tabular-nums">{`· ${duration}`}</span>
          <ChevronRight size={13} aria-hidden="true" className="-mr-1 shrink-0 text-ink-tertiary" />
        </button>
        {lines.length > 0 && (
          <ul className="flex max-w-full min-w-0 flex-col gap-0.5 text-[12.5px]">
            {lines.map((line) => <CallLineItem key={line.id} line={line} busy={busy} />)}
          </ul>
        )}
        {partial && <p className="max-w-full text-center text-[12px] text-ink-tertiary">{t("chat.callRecord.partial")}</p>}
      </div>
      {open && (
        <CallSheet
          message={message}
          transcript={transcript}
          botName={botName}
          threadId={threadId}
          busy={busy}
          partial={partial}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
