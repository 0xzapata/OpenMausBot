import type { ModelCatalog } from "./contracts.ts";
import { contextWindowFor } from "./context-budget.ts";

export const DEFAULT_ROOM_COMPACT_AT = 0.9;

export type RoomMemberContext = { tokens: number; window: number; compactRequested?: true };

export function roomCompactTokens(window: number, settings: { autoCompact?: boolean; roomCompactAt?: number } | undefined): number | null {
  if (settings?.autoCompact === false) return null;
  const at = settings?.roomCompactAt;
  const value = typeof at === "number" && Number.isFinite(at) && at > 0 ? at : DEFAULT_ROOM_COMPACT_AT;
  return value < 1 ? Math.floor(window * value) : Math.floor(value);
}

export class RoomContextTracker {
  private threads = new Map<string, Map<string, RoomMemberContext>>();

  record(threadId: string, botId: string, reading: { tokens?: number; window?: number } | undefined, model: string | undefined, catalog?: ModelCatalog): void {
    const tokens = reading?.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
    const members = this.threads.get(threadId) ?? new Map<string, RoomMemberContext>();
    const previous = members.get(botId);
    members.set(botId, {
      tokens: Math.trunc(tokens),
      window: contextWindowFor(model, catalog, reading?.window),
      ...(previous?.compactRequested ? { compactRequested: true as const } : {}),
    });
    this.threads.set(threadId, members);
  }

  request(threadId: string, botId: string): boolean {
    const current = this.threads.get(threadId)?.get(botId);
    if (!current) return false;
    current.compactRequested = true;
    return true;
  }

  forThread(threadId: string): Record<string, RoomMemberContext> | undefined {
    const members = this.threads.get(threadId);
    if (!members?.size) return undefined;
    return Object.fromEntries([...members].map(([botId, value]) => [botId, { ...value }]));
  }

  takeReset(threadId: string, botId: string, settings: { autoCompact?: boolean; roomCompactAt?: number } | undefined):
    { reason: "requested" | "threshold"; percent: number } | null {
    const members = this.threads.get(threadId);
    const current = members?.get(botId);
    if (!members || !current) return null;
    const percent = Math.round((current.tokens / current.window) * 100);
    const limit = roomCompactTokens(current.window, settings);
    const reason = current.compactRequested ? "requested" : limit !== null && current.tokens >= limit ? "threshold" : null;
    if (!reason) return null;
    members.delete(botId);
    if (!members.size) this.threads.delete(threadId);
    return { reason, percent };
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
  }
}
