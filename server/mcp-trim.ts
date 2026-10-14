export const DEFAULT_RESULT_BUDGET = 8_000;

const MIN_BUDGET = 512;

export interface TrimOutcome {
  text: string;
  trimmed: boolean;
  originalChars: number;
}

export interface TrimInput {
  text: string;
  budget?: number;
  spillPath?: string;
  spillHint?: boolean;
  toolName?: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function serialize(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}

function fitArray(items: readonly unknown[], budget: number): unknown[] {
  const kept: unknown[] = [];
  let used = 2;
  for (const item of items) {
    const json = serialize(item);
    if (json === null) break;
    const cost = json.length + (kept.length ? 1 : 0);
    if (kept.length && used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  return kept;
}

function arrayFields(value: unknown): Array<{ key: string; items: readonly unknown[] }> {
  if (Array.isArray(value)) return [{ key: "", items: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([key, items]) => ({ key, items }));
}

/** Never mid-surrogate-pair: half an emoji is an invalid string some providers reject outright. */
function cutAt(text: string, chars: number): string {
  const cut = text.slice(0, Math.max(0, chars));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function marker(input: {
  originalChars: number;
  keptChars: number;
  dropped: Array<{ key: string; kept: number; total: number }>;
  spillPath?: string;
  spillHint?: boolean;
  structural: boolean;
}): string {
  const counts = input.dropped
    .filter((d) => d.kept < d.total)
    .map((d) => `${d.key || "items"} ${fmt(d.kept)} of ${fmt(d.total)}`)
    .join(", ");
  const what = input.structural
    ? counts ? ` Kept ${counts}.` : ""
    : " Cut mid-text, so what is above may be incomplete JSON.";
  const where = input.spillHint && input.spillPath
    ? ` The whole result is at ${JSON.stringify(input.spillPath)}; reading it costs as much as not trimming, so narrow the call first.`
    : " If you need more, call the tool again with a narrower query, a filter, or the next page.";
  return `\n\n[OpenMausBot trimmed this tool result to fit the conversation: ${fmt(input.originalChars)} → ${fmt(input.keptChars)} characters.${what}${where}]`;
}

export function trimStructured(parsed: unknown, budget: number): { value: unknown; dropped: Array<{ key: string; kept: number; total: number }> } | null {
  const room = Math.max(MIN_BUDGET, budget);
  const current = serialize(parsed);
  if (current !== null && current.length <= room) return null;
  const fields = arrayFields(parsed);
  if (!fields.length) return null;
  const skeleton = Array.isArray(parsed)
    ? 2
    : (serialize({ ...(parsed as Record<string, unknown>), ...Object.fromEntries(fields.map((f) => [f.key, []])) })?.length ?? Infinity);
  const share = Math.floor((room - skeleton) / fields.length);
  if (!Number.isFinite(skeleton) || share <= 0) return null;
  const dropped: Array<{ key: string; kept: number; total: number }> = [];
  let value: unknown;
  if (Array.isArray(parsed)) {
    const kept = fitArray(parsed, share);
    dropped.push({ key: "", kept: kept.length, total: parsed.length });
    value = kept;
  } else {
    const next: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    for (const field of fields) {
      const kept = fitArray(field.items, share);
      dropped.push({ key: field.key, kept: kept.length, total: field.items.length });
      next[field.key] = kept;
    }
    value = next;
  }
  if (!dropped.some((d) => d.kept < d.total)) return null;
  const json = serialize(value);
  return json !== null && json.length <= room ? { value, dropped } : null;
}

export function trimResultText(input: TrimInput): TrimOutcome {
  const { text } = input;
  const budget = Math.max(MIN_BUDGET, input.budget ?? DEFAULT_RESULT_BUDGET);
  if (text.length <= budget) return { text, trimmed: false, originalChars: text.length };

  const room = Math.max(MIN_BUDGET, budget - 400);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  const fields = parsed === undefined ? [] : arrayFields(parsed);
  if (fields.length) {
    const skeleton = Array.isArray(parsed)
      ? 2
      : (serialize({ ...(parsed as Record<string, unknown>), ...Object.fromEntries(fields.map((f) => [f.key, []])) })?.length ?? Infinity);
    const share = Math.floor((room - skeleton) / fields.length);
    if (Number.isFinite(skeleton) && share > 0) {
      const dropped: Array<{ key: string; kept: number; total: number }> = [];
      let value: unknown;
      if (Array.isArray(parsed)) {
        const kept = fitArray(parsed, share);
        dropped.push({ key: "", kept: kept.length, total: parsed.length });
        value = kept;
      } else {
        const next: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
        for (const field of fields) {
          const kept = fitArray(field.items, share);
          dropped.push({ key: field.key, kept: kept.length, total: field.items.length });
          next[field.key] = kept;
        }
        value = next;
      }
      const json = serialize(value);
      if (json !== null && json.length <= room) {
        return {
          text: json + marker({ originalChars: text.length, keptChars: json.length, dropped, spillPath: input.spillPath, spillHint: input.spillHint, structural: true }),
          trimmed: true,
          originalChars: text.length,
        };
      }
    }
  }

  const cut = cutAt(text, room);
  return {
    text: cut + marker({ originalChars: text.length, keptChars: cut.length, dropped: [], spillPath: input.spillPath, spillHint: input.spillHint, structural: false }),
    trimmed: true,
    originalChars: text.length,
  };
}
