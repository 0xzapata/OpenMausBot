// What the bot did on one Live call, for the call's record in the chat.
// A call's messages are the user lines carrying its id (each spoken request)
// and every message whose requestMessageId points at one of them: the
// activity, cards and answers of the turns those requests started. A typed
// line carries no call id, so a turn it started is never listed, even while
// a call runs. The whole transcript is read, not only what comes before the
// row: a turn still running at hang-up keeps adding steps.
// A line steered into a running turn starts no turn of its own: that turn
// keeps pointing at the request it began with. So with a typed line
// steered into a call's turn, the turn's work is still listed with the
// call; with a spoken line steered into a typed request's turn (or into
// another call's), none of that turn's work is listed with its own call.
import type { Message } from "@/state/store";
import { isToolStep } from "@/lib/activity-runs";

export type CallRecordLine =
  | { kind: "step"; id: string; tool: NonNullable<Message["tool"]> }
  | { kind: "approval"; id: string; card: NonNullable<Message["card"]> };

/** A call's steps and approval cards, in transcript order. A step is a tool
 * the provider ran, which is what carries an item id. Status rows, failed-turn
 * rows, chips that link to another conversation, the harness's own chips
 * (the receipt of an automatic approval, a notice, a rejected action, a retry)
 * and question cards are not work the bot did, so they are left out. */
export function callRecordLines(transcript: readonly Message[], callId: string): CallRecordLine[] {
  const requests = callRequests(transcript, callId);
  if (requests.size === 0) return [];
  const lines: CallRecordLine[] = [];
  for (const message of transcript) {
    if (!message.requestMessageId || !requests.has(message.requestMessageId)) continue;
    const line = callRecordLine(message);
    if (line) lines.push(line);
  }
  return lines;
}

/** One entry of a call's sheet: a request spoken on the call, the bot's
 * answer to one, or a line of its record. */
export type CallConversationEntry =
  | { kind: "said"; id: string; message: Message }
  | { kind: "answer"; id: string; message: Message }
  | CallRecordLine;

/** The whole call, in transcript order, for its sheet: each spoken request,
 * then what its turn did and answered. Built only from what the chat stores:
 * the voice's own words are not here, as they are nowhere. A turn's receipts
 * (its digest, a compaction) are about the turn, not the call, so they are
 * left out, and so is anything a record leaves out. */
export function callConversation(transcript: readonly Message[], callId: string): CallConversationEntry[] {
  const requests = callRequests(transcript, callId);
  if (requests.size === 0) return [];
  const entries: CallConversationEntry[] = [];
  for (const message of transcript) {
    if (requests.has(message.id)) {
      if (message.text?.trim()) entries.push({ kind: "said", id: message.id, message });
      continue;
    }
    if (!message.requestMessageId || !requests.has(message.requestMessageId)) continue;
    if (message.role === "bot" && message.kind === "text") {
      if (message.text?.trim()) entries.push({ kind: "answer", id: message.id, message });
      continue;
    }
    const line = callRecordLine(message);
    if (line) entries.push(line);
  }
  return entries;
}

/** The ids of the requests spoken on `callId`. */
function callRequests(transcript: readonly Message[], callId: string): Set<string> {
  const requests = new Set<string>();
  for (const message of transcript) {
    if (message.role === "user" && message.callId === callId) requests.add(message.id);
  }
  return requests;
}

/** A message of a call's turn as a line of its record, or null when it is
 * not work the bot did. */
function callRecordLine(message: Message): CallRecordLine | null {
  const { card } = message;
  if (isToolStep(message)) {
    // The harness writes chips of its own inside a turn. Each looks like a
    // step to the chat's fold, but none has a provider item behind it:
    // listing them would show an auto-approved action twice, or a note as
    // work.
    return message.tool.itemId !== undefined ? { kind: "step", id: message.id, tool: message.tool } : null;
  }
  if (message.kind === "options" && card?.requestId && card.tool && !card.questionRequest) {
    return { kind: "approval", id: message.id, card };
  }
  return null;
}

/** Whether a call's record may be missing lines because older messages are
 * not loaded: some remain on the server (`hasMore`), and the oldest message
 * loaded came after the call began, so a spoken request of the call, and the
 * work it started, may sit before it. Loading earlier messages settles it. */
export function callRecordIsPartial(transcript: readonly Message[], call: { startedAt: number }, hasMore: boolean): boolean {
  const oldest = transcript[0];
  return hasMore && oldest !== undefined && oldest.at > call.startedAt;
}
