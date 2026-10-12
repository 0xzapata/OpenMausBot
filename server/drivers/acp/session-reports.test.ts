import { describe, expect, it } from "vitest";

import { hermesCompaction, readSessionReport, type UsageState } from "./session-reports.ts";

const turn = (usagePeak: number | null = null): UsageState => ({ usagePeak, usageLast: null, usageCompacted: false });
/** A pooled process's session record, as far as the reader looks at it. */
const live = (sessionId: string | null = "session-1") => ({ sessionId });
const usage = (fields: object) => ({ sessionUpdate: "usage_update", ...fields });

describe("readSessionReport: usage_update", () => {
  it("reads the context and, from an agent that names one, the window", () => {
    expect(readSessionReport(usage({ used: 48_000, size: 200_000 }), undefined, turn(), live())).toEqual({ context: { contextTokens: 48_000, contextWindow: 200_000 } });
    // opencode nests its figures under `usage`
    expect(readSessionReport(usage({ usage: { used: 61_000, size: 128_000 } }), undefined, turn(), live())).toEqual({ context: { contextTokens: 61_000, contextWindow: 128_000 } });
    for (const size of [undefined, 0, -200_000, "200000", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readSessionReport(usage({ used: 48_000, size }), undefined, turn(), live()), String(size)).toStrictEqual({ context: { contextTokens: 48_000 } });
    }
  });

  it("takes a report that is not a positive count for no measurement at all", () => {
    for (const used of [0, -48_000, "48000", null, undefined, Number.NaN]) {
      const state = turn(100_000);
      expect(readSessionReport(usage({ used, size: 200_000 }), undefined, state, live()), String(used)).toEqual({});
      expect(state).toEqual({ usagePeak: 100_000, usageLast: null, usageCompacted: false });
    }
  });

  it("keeps the turn's peak and marks a collapse below it as a compaction", () => {
    const state = turn();
    readSessionReport(usage({ used: 120_000 }), undefined, state, live());
    expect(state).toEqual({ usagePeak: 120_000, usageLast: 120_000, usageCompacted: false });
    // an ordinary dip stays above 60% of the peak
    readSessionReport(usage({ used: 100_000 }), undefined, state, live());
    expect(state).toEqual({ usagePeak: 120_000, usageLast: 100_000, usageCompacted: false });
    readSessionReport(usage({ used: 45_000 }), undefined, state, live());
    expect(state).toEqual({ usagePeak: 120_000, usageLast: 45_000, usageCompacted: true });
  });

  it("says nothing about updates it does not read", () => {
    const state = turn(100_000);
    for (const update of [undefined, null, "usage_update", {}, { sessionUpdate: "agent_message_chunk", used: 5 }]) {
      expect(readSessionReport(update, undefined, state, live()), JSON.stringify(update)).toEqual({});
    }
    expect(state).toEqual({ usagePeak: 100_000, usageLast: null, usageCompacted: false });
  });
});

const meta = (sessionProvenance: unknown) => ({ hermes: { sessionProvenance } });

describe("hermesCompaction", () => {
  it("takes a stated compression as a compaction, with or without a depth", () => {
    expect(hermesCompaction(meta({ reason: "compression", compressionDepth: 1, sessionKind: "continuation" }), 0))
      .toEqual({ compacted: true, depth: 1 });
    expect(hermesCompaction(meta({ reason: "compression" }), 3)).toEqual({ compacted: true, depth: 3 });
    // a restated depth still counts while Hermes names the reason
    expect(hermesCompaction(meta({ reason: "compression", compressionDepth: 2 }), 2)).toEqual({ compacted: true, depth: 2 });
  });

  it("takes a depth above the last one seen as a compaction, once per rise", () => {
    expect(hermesCompaction(meta({ compressionDepth: 1 }), 0)).toEqual({ compacted: true, depth: 1 });
    expect(hermesCompaction(meta({ compressionDepth: 1 }), 1)).toEqual({ compacted: false, depth: 1 });
    expect(hermesCompaction(meta({ compressionDepth: 3 }), 1)).toEqual({ compacted: true, depth: 3 });
    // a root session, or a depth that went back down, is remembered and is no compaction
    expect(hermesCompaction(meta({ sessionKind: "root", compressionDepth: 0 }), 0)).toEqual({ compacted: false, depth: 0 });
    expect(hermesCompaction(meta({ compressionDepth: 0 }), 2)).toEqual({ compacted: false, depth: 0 });
  });

  it("keeps the last depth when the reported one is not a whole count", () => {
    for (const compressionDepth of ["3", 2.5, -1, null, Number.NaN, [3], { depth: 3 }]) {
      expect(hermesCompaction(meta({ compressionDepth }), 1), JSON.stringify(compressionDepth)).toEqual({ compacted: false, depth: 1 });
    }
    expect(hermesCompaction(meta({ reason: "rename" }), 1)).toEqual({ compacted: false, depth: 1 });
    expect(hermesCompaction(meta({ reason: ["compression"] }), 1)).toEqual({ compacted: false, depth: 1 });
  });

  it("reads nothing from meta that carries no provenance", () => {
    for (const value of [undefined, null, "compression", 7, [], {}, { hermes: null }, { hermes: "compression" },
      { hermes: {} }, meta(null), meta("compression"), meta(["compression"]),
      { other: { sessionProvenance: { reason: "compression" } } }]) {
      expect(hermesCompaction(value, 0), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("readSessionReport: session_info_update", () => {
  const info = (sessionProvenance?: unknown) => ({
    sessionUpdate: "session_info_update", ...(sessionProvenance === undefined ? {} : { _meta: meta(sessionProvenance) }),
  });

  it("marks the turn compacted from the update's meta or the notification's", () => {
    const inside = turn();
    expect(readSessionReport(info({ reason: "compression" }), undefined, inside, live())).toEqual({});
    expect(inside.usageCompacted).toBe(true);
    const beside = turn();
    readSessionReport(info(), meta({ reason: "compression" }), beside, live());
    expect(beside.usageCompacted).toBe(true);
    const neither = turn();
    readSessionReport(info(), { isReplay: false }, neither, live());
    expect(neither.usageCompacted).toBe(false);
  });

  it("remembers the depth per native session, across turns of one pooled process", () => {
    const session = live("session-1");
    const first = turn();
    readSessionReport(info({ compressionDepth: 1 }), undefined, first, session);
    expect(first.usageCompacted).toBe(true);
    // the next turn on the same session: the same depth is no new compaction
    const second = turn();
    readSessionReport(info({ compressionDepth: 1 }), undefined, second, session);
    expect(second.usageCompacted).toBe(false);
    // the process moved to another native session: its depth starts over
    session.sessionId = "session-2";
    const third = turn();
    readSessionReport(info({ compressionDepth: 1 }), undefined, third, session);
    expect(third.usageCompacted).toBe(true);
    // and another pooled process never shares what this one remembered
    const other = turn();
    readSessionReport(info({ compressionDepth: 1 }), undefined, other, live("session-2"));
    expect(other.usageCompacted).toBe(true);
  });
});
