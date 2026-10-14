// Observes only: counts a repeated tool call in one turn and says so; the person has Stop.

/** Null for a bare tool name: Claude's item.started carries only the name, and five "Bash" calls may be five commands. */
export function callKey(tool: string, args: string | undefined): string | null {
  const a = (args ?? "").replace(/\s+/g, " ").trim();
  if (!a || a === tool) return null;
  return `${tool}:${a}`;
}

/** A started tool item's key. A title with more than a bare identifier is
 * a call with arguments (ACP: "echo hi", "Read src/x.ts"); a bare "Bash" is
 * not countable. An adapter may title every call alike ("Running
 * list_directory") and keep what differs in the input, so the input, when
 * the item carries one, is part of the call: the pair is encoded whole, so
 * no title and input can run together into another call's, and kept
 * verbatim: "a b" and "a  b" are two paths. */
export function toolItemKey(title: string | undefined, input: string | undefined): string | null {
  const t = (title ?? "").trim();
  if (!/\s|\//.test(t)) return null;
  return input ? `tool:${JSON.stringify([t, input])}` : callKey("tool", t);
}

export class RepeatDetector {
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly thresholds: readonly number[];
  private readonly maxKeysPerThread: number;

  constructor(opts: { thresholds: readonly number[]; maxKeysPerThread?: number }) {
    this.thresholds = [...opts.thresholds].sort((a, b) => a - b);
    this.maxKeysPerThread = opts.maxKeysPerThread ?? 256;
    if (!Number.isInteger(this.maxKeysPerThread) || this.maxKeysPerThread < 1) {
      throw new Error("maxKeysPerThread must be a positive integer");
    }
  }

  record(threadId: string, key: string): { count: number; threshold?: number } {
    let per = this.counts.get(threadId);
    if (!per) this.counts.set(threadId, (per = new Map()));
    const previous = per.get(key);
    if (previous !== undefined) per.delete(key);
    else if (per.size >= this.maxKeysPerThread) per.delete(per.keys().next().value!);
    const count = (previous ?? 0) + 1;
    per.set(key, count);
    return this.thresholds.includes(count) ? { count, threshold: count } : { count };
  }

  settle(threadId: string) {
    this.counts.delete(threadId);
  }
}
