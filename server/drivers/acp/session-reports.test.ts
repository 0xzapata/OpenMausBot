import { describe, expect, it } from "vitest";

import { readSessionReport, type UsageState } from "./session-reports.ts";

const turn = (usagePeak: number | null = null): UsageState => ({ usagePeak, usageLast: null, usageCompacted: false });
const usage = (fields: object) => ({ sessionUpdate: "usage_update", ...fields });

describe("readSessionReport: usage_update", () => {
  it("reads the context and, from an agent that names one, the window", () => {
    expect(readSessionReport(usage({ used: 48_000, size: 200_000 }), turn())).toEqual({ context: { contextTokens: 48_000, contextWindow: 200_000 } });
    // opencode nests its figures under `usage`
    expect(readSessionReport(usage({ usage: { used: 61_000, size: 128_000 } }), turn())).toEqual({ context: { contextTokens: 61_000, contextWindow: 128_000 } });
    for (const size of [undefined, 0, -200_000, "200000", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readSessionReport(usage({ used: 48_000, size }), turn()), String(size)).toStrictEqual({ context: { contextTokens: 48_000 } });
    }
  });

  it("takes a report that is not a positive count for no measurement at all", () => {
    for (const used of [0, -48_000, "48000", null, undefined, Number.NaN]) {
      const state = turn(100_000);
      expect(readSessionReport(usage({ used, size: 200_000 }), state), String(used)).toEqual({});
      expect(state).toEqual({ usagePeak: 100_000, usageLast: null, usageCompacted: false });
    }
  });

  it("keeps the turn's peak and marks a collapse below it as a compaction", () => {
    const state = turn();
    readSessionReport(usage({ used: 120_000 }), state);
    expect(state).toEqual({ usagePeak: 120_000, usageLast: 120_000, usageCompacted: false });
    // an ordinary dip stays above 60% of the peak
    readSessionReport(usage({ used: 100_000 }), state);
    expect(state).toEqual({ usagePeak: 120_000, usageLast: 100_000, usageCompacted: false });
    readSessionReport(usage({ used: 45_000 }), state);
    expect(state).toEqual({ usagePeak: 120_000, usageLast: 45_000, usageCompacted: true });
  });

  it("says nothing about updates it does not read", () => {
    const state = turn(100_000);
    for (const update of [undefined, null, "usage_update", {}, { sessionUpdate: "agent_message_chunk", used: 5 }]) {
      expect(readSessionReport(update, state), JSON.stringify(update)).toEqual({});
    }
    expect(state).toEqual({ usagePeak: 100_000, usageLast: null, usageCompacted: false });
  });
});
