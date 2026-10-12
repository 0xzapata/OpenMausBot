import { describe, expect, it } from "vitest";

import { OUTCOME_TEXT_MAX, RepeatStreak, outcomeDigest } from "./repeat-streak.ts";
import { toolDetailPreview } from "./tool-summary.ts";

const FAILING = "FAIL src/x.test.ts\nexpected 1 to be 2";

describe("outcomeDigest", () => {
  it("is the same for the same result and different for any other", () => {
    expect(outcomeDigest(false, FAILING)).toBe(outcomeDigest(false, FAILING));
    expect(outcomeDigest(false, FAILING)).not.toBe(outcomeDigest(true, FAILING));
    expect(outcomeDigest(false, FAILING)).not.toBe(outcomeDigest(false, `${FAILING} `));
    expect(outcomeDigest(true, "ok")).not.toBe(outcomeDigest(false, "ok"));
  });

  it("is a digest: the text is not in it, and its size does not follow the text's", () => {
    const digest = outcomeDigest(false, FAILING)!;
    expect(digest).not.toContain("FAIL");
    expect(digest).not.toContain("expected");
    expect(outcomeDigest(true, "x".repeat(3_000))).toHaveLength(digest.length);
  });

  it("is nothing when the engine reported no output", () => {
    expect(outcomeDigest(true, undefined)).toBeNull();
    expect(outcomeDigest(false, undefined)).toBeNull();
    expect(outcomeDigest(true, "")).toBeNull();
    expect(outcomeDigest(true, " \n\t")).toBeNull();
  });

  it("is nothing when the output is not all there: two results cut alike are not the same result", () => {
    // a long test log: the head is the same every run, the failures are at the end
    expect(outcomeDigest(false, toolDetailPreview(`${"PASS src/a.test.ts\n".repeat(400)}FAIL src/x.test.ts`))).toBeNull();
    expect(outcomeDigest(true, toolDetailPreview("x".repeat(256_001)))).toBeNull();
    expect(outcomeDigest(true, toolDetailPreview({ output: "done", password: "short" }))).toBeNull();
    expect(outcomeDigest(true, `token ghp_ → «redacted 40 chars»`)).toBeNull();
    // Muse cuts at 4,000 characters without a marker
    expect(outcomeDigest(true, "x".repeat(OUTCOME_TEXT_MAX))).toBeNull();
    expect(outcomeDigest(true, "x".repeat(OUTCOME_TEXT_MAX - 1))).not.toBeNull();
  });
});

describe("RepeatStreak", () => {
  type Call = { key: string };
  const SAME = outcomeDigest(false, FAILING)!;
  const OTHER = outcomeDigest(false, "FAIL src/x.test.ts\nexpected 1 to be 3")!;

  function rig(maxPending?: number) {
    const streak = new RepeatStreak<Call>(maxPending === undefined ? {} : { maxPending });
    let n = 0;
    return {
      streak,
      /** One shell command from start to finish; the streak it leaves, or null. */
      run: (command: string | null, outcome: string | null, threadId = "t1") => {
        const id = `item-${++n}`;
        streak.started(threadId, id, command === null ? null : { key: command });
        return streak.completed(threadId, id, outcome)?.streak ?? null;
      },
    };
  }

  it("grows while the same command comes back with the same outcome, back to back", () => {
    const r = rig();
    expect([1, 2, 3, 4, 5].map(() => r.run("pnpm test", SAME))).toEqual([1, 2, 3, 4, 5]);
  });

  it("hands back the call it was started with", () => {
    const streak = new RepeatStreak<{ key: string; label: string }>();
    streak.started("t1", "a", { key: "pnpm test", label: "Bash: pnpm test" });
    expect(streak.completed("t1", "a", SAME)).toEqual({ call: { key: "pnpm test", label: "Bash: pnpm test" }, streak: 1 });
  });

  it("starts over when the same command comes back different: editing and re-running tests is not a loop", () => {
    const r = rig();
    const runs = Array.from({ length: 30 }, (_, index) => r.run("pnpm test", outcomeDigest(false, `${FAILING} (${index} failed)`)));
    expect(runs).toEqual(Array.from({ length: 30 }, () => 1));
    expect(r.run("pnpm test", SAME)).toBe(1);
    expect(r.run("pnpm test", SAME)).toBe(2);
    expect(r.run("pnpm test", OTHER)).toBe(1);
    expect(r.run("pnpm test", SAME)).toBe(1);
  });

  it("starts over when another command completes in between", () => {
    const r = rig();
    expect(r.run("pnpm test", SAME)).toBe(1);
    expect(r.run("pnpm test", SAME)).toBe(2);
    expect(r.run("git status", SAME)).toBe(1);
    expect(r.run("pnpm test", SAME)).toBe(1);
    expect(r.run("pnpm test", SAME)).toBe(2);
  });

  it("proves nothing without an outcome, and the streak in progress ends there", () => {
    const r = rig();
    expect(Array.from({ length: 30 }, () => r.run("pnpm test", null))).toEqual(Array.from({ length: 30 }, () => null));
    expect(r.run("pnpm test", SAME)).toBe(1);
    expect(r.run("pnpm test", SAME)).toBe(2);
    expect(r.run("pnpm test", null)).toBeNull();
    expect(r.run("pnpm test", SAME)).toBe(1);
  });

  it("ends the streak at a shell command the harness could not see whole", () => {
    const r = rig();
    expect(r.run("pnpm test", SAME)).toBe(1);
    expect(r.run("pnpm test", SAME)).toBe(2);
    expect(r.run(null, SAME)).toBeNull();
    expect(r.run("pnpm test", SAME)).toBe(1);
  });

  it("ends the streak at a shell command that started without an id: its end can never be seen", () => {
    const r = rig();
    expect(r.run("pnpm test", SAME)).toBe(1);
    r.streak.started("t1", undefined, { key: "pnpm test" });
    expect(r.run("pnpm test", SAME)).toBe(1);
  });

  it("leaves the streak alone when something that is not a tracked command completes", () => {
    const r = rig();
    expect(r.run("pnpm test", SAME)).toBe(1);
    // an edit, a read: never started here
    expect(r.streak.completed("t1", "edit-1", SAME)).toBeNull();
    expect(r.streak.completed("t1", undefined, SAME)).toBeNull();
    expect(r.run("pnpm test", SAME)).toBe(2);
  });

  it("goes by the order commands complete in, and counts each completion once", () => {
    const r = rig();
    r.streak.started("t1", "a", { key: "pnpm test" });
    r.streak.started("t1", "b", { key: "pnpm test" });
    expect(r.streak.completed("t1", "b", SAME)?.streak).toBe(1);
    expect(r.streak.completed("t1", "a", SAME)?.streak).toBe(2);
    expect(r.streak.completed("t1", "a", SAME)).toBeNull();
  });

  it("keeps threads apart, and forgets a thread on settle", () => {
    const r = rig();
    expect(r.run("pnpm test", SAME, "t1")).toBe(1);
    expect(r.run("pnpm test", SAME, "t2")).toBe(1);
    expect(r.run("pnpm test", SAME, "t1")).toBe(2);
    r.streak.started("t1", "open", { key: "pnpm test" });
    r.streak.settle("t1");
    expect(r.streak.completed("t1", "open", SAME)).toBeNull();
    expect(r.run("pnpm test", SAME, "t1")).toBe(1);
    expect(r.run("pnpm test", SAME, "t2")).toBe(2);
  });

  it("bounds the commands it waits on, dropping the one that started first", () => {
    const r = rig(2);
    r.streak.started("t1", "a", { key: "one" });
    r.streak.started("t1", "b", { key: "two" });
    r.streak.started("t1", "c", { key: "three" });
    expect(r.streak.completed("t1", "a", SAME)).toBeNull();
    expect(r.streak.completed("t1", "b", SAME)?.streak).toBe(1);
    expect(r.streak.completed("t1", "c", SAME)?.streak).toBe(1);
    expect(() => new RepeatStreak({ maxPending: 0 })).toThrow(/positive integer/);
  });
});
