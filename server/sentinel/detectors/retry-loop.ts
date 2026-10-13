// retry_loop: the same tool failing the same way again and again inside one
// turn — the bot retrying something that will not start working. Counted
// over the whole scan window, so a loop that spans two scans still adds up.
import { normalizeSignatureText, signatureOf, toolOrigin } from "../normalize.ts";
import type { Detector, Observation, SentinelRecord } from "../types.ts";

type ToolRecord = Extract<SentinelRecord, { type: "tool" }>;

export const retryLoop: Detector = {
  name: "retry_loop",
  detect(records, config) {
    const loops = new Map<string, { signature: string; calls: ToolRecord[] }>();
    for (const record of records) {
      if (record.type !== "tool" || record.ok || !record.turnId) continue;
      const signature = signatureOf("retry_loop", record.tool, normalizeSignatureText(record.text));
      const key = `${record.turnId}\n${signature}`;
      const loop = loops.get(key) ?? { signature, calls: [] };
      loop.calls.push(record);
      loops.set(key, loop);
    }
    const observations: Observation[] = [];
    for (const { signature, calls } of loops.values()) {
      if (calls.length < config.retryLoopMin) continue;
      const last = calls.reduce((a, b) => (b.at >= a.at ? b : a));
      const origin = toolOrigin(last.tool);
      observations.push({
        kind: "retry_loop",
        signature,
        origin,
        severity: origin === "harness" ? "high" : "medium",
        tool: last.tool,
        threadId: last.threadId,
        turnId: last.turnId!,
        at: last.at,
        // one loop per turn, however long it grows
        occurrence: `retry:${last.turnId}:${signature}`,
        evidence: { source: "messages", id: last.id },
        ...(last.botId ? { botId: last.botId } : {}),
      });
    }
    return observations;
  },
};
