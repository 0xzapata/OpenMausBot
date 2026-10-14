import type { Message } from "@/state/store";
import { isToolStep } from "@/lib/activity-runs";

export type CallRecordLine =
  | { kind: "step"; id: string; tool: NonNullable<Message["tool"]> }
  | { kind: "approval"; id: string; card: NonNullable<Message["card"]> };

export function callRecordLines(transcript: readonly Message[], callId: string): CallRecordLine[] {
  const requests = new Set<string>();
  for (const message of transcript) {
    if (message.role === "user" && message.callId === callId) requests.add(message.id);
  }
  if (requests.size === 0) return [];
  const lines: CallRecordLine[] = [];
  for (const message of transcript) {
    if (!message.requestMessageId || !requests.has(message.requestMessageId)) continue;
    const { card } = message;
    if (isToolStep(message)) {
      // Harness chips have no provider item id; listing them would show an auto-approved action twice.
      if (message.tool.itemId !== undefined) lines.push({ kind: "step", id: message.id, tool: message.tool });
    } else if (message.kind === "options" && card?.requestId && card.tool && !card.questionRequest) {
      lines.push({ kind: "approval", id: message.id, card });
    }
  }
  return lines;
}

export function callRecordIsPartial(transcript: readonly Message[], call: { startedAt: number }, hasMore: boolean): boolean {
  const oldest = transcript[0];
  return hasMore && oldest !== undefined && oldest.at > call.startedAt;
}
