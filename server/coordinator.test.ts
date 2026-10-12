// The seam: createCoordinator returns the runtime coordinator, and the
// test helper reads the same rows the server works from.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createCoordinator, type CoordinatorHost, type HandoffView } from "./coordinator.ts";
import { RuntimeCoordinator } from "./runtime-coordinator.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

function fakeHost(): CoordinatorHost {
  return {
    validate: vi.fn(() => undefined),
    busy: vi.fn(() => false),
    run: vi.fn(async (node: HandoffView) => ({ ok: true, text: `${node.botId} done` })),
    report: vi.fn(),
    changed: vi.fn(),
    names: vi.fn((node: HandoffView) => ({ requester: "Chief", assignee: node.botId })),
    park: vi.fn(),
    levelOf: vi.fn(() => ({ level: "ask" as const })),
    chiefOf: vi.fn(() => false),
  };
}

describe("createCoordinator", () => {
  it("returns the runtime coordinator, whose rows the test helper reads back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-"));
    try {
      const coordinator = createCoordinator({ dataDir: dir, host: fakeHost(), log: () => {} });
      expect(coordinator).toBeInstanceOf(RuntimeCoordinator);
      const chief = { botId: "chief", threadId: "chief-chat" };
      const { node, duplicate } = coordinator.enqueue(chief, "gen-1", undefined, { botId: "builder", threadId: "builder-work" },
        "Build it", { sourceText: "Ship it", origin: { kind: "user", request: "Ship it" } });
      expect(duplicate).toBe(false);
      expect(node).toMatchObject({ status: "queued", botId: "builder", parentId: "gen-1", kind: "work" });
      const { node: asked } = coordinator.enqueue(chief, "gen-1", undefined, { botId: "tester", threadId: "tester-work" },
        "Is staging up?", { mode: "consult", doneWhen: "a yes or a no" });
      const { node: told } = coordinator.enqueue(chief, "gen-1", undefined, { botId: "ops", threadId: "ops-work" }, "FYI", { mode: "notify" });
      const rows = readHandoffs(dir);
      expect(rows.map((row) => [row.id, row.status])).toEqual([["gen-1", "source"], [node.id, "queued"], [asked.id, "queued"], [told.id, "queued"]]);
      expect(rows[0]).toMatchObject({ origin: { kind: "user", request: "Ship it" }, mode: "work", reply: "resume" });
      // the view's mode and reply fields come through the helper; the optional ones only when set
      expect(rows[1]).toMatchObject({ mode: "work", reply: "resume" });
      expect(rows[2]).toMatchObject({ mode: "consult", reply: "resume" });
      expect(rows[3]).toMatchObject({ mode: "notify", reply: "none" });
      for (const absent of ["outcome", "outcomeDetail", "question"]) expect(absent in rows[1]!).toBe(false);
      coordinator.close();
    } finally {
      removeTempDir(dir);
    }
  });
});
