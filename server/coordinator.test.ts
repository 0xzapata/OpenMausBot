// The seam: the legacy coordinator is the room-handoff tree behind the
// Coordinator interface, method for method, and createCoordinator picks the
// implementation by kind.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createCoordinator, LegacyCoordinator, type CoordinatorHost, type HandoffView } from "./coordinator.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fakeHost(): CoordinatorHost & { runs: Array<{ node: HandoffView; resumed: boolean; composed: unknown }> } {
  const host = {
    runs: [] as Array<{ node: HandoffView; resumed: boolean; composed: unknown }>,
    validate: vi.fn(() => undefined),
    busy: vi.fn(() => false),
    run: vi.fn(async (node: HandoffView, resumed: boolean, _signal: AbortSignal, composed?: unknown) => {
      host.runs.push({ node, resumed, composed });
      return { ok: true, text: `${node.botId} done` };
    }),
    report: vi.fn(),
    changed: vi.fn(),
    names: vi.fn((node: HandoffView) => ({ requester: "Chief", assignee: node.botId })),
    park: vi.fn(),
    levelOf: vi.fn(() => ({ level: "ask" as const })),
    chiefOf: vi.fn(() => false),
  };
  return host;
}

describe("LegacyCoordinator", () => {
  it("delegates every method to the room-handoff tree, with the host's hooks and no composed turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordinator-legacy-"));
    try {
      const host = fakeHost();
      const coordinator = createCoordinator("legacy", { dataDir: dir, host });
      expect(coordinator).toBeInstanceOf(LegacyCoordinator);
      expect(coordinator.kind).toBe("legacy");
      const chief = { botId: "chief", threadId: "chief-chat" };
      const builder = { botId: "builder", threadId: "builder-work" };
      const { node, duplicate } = coordinator.enqueue(chief, "gen-1", undefined, builder, "builder", "Build it", true, false, "Ship it", undefined,
        { kind: "user", request: "Ship it" });
      expect(duplicate).toBe(false);
      expect(node).toMatchObject({ status: "queued", botId: "builder", parentId: "gen-1", approvalGranted: true, kind: "work" });
      expect(host.validate).toHaveBeenCalledWith(expect.objectContaining({ id: node.id }), expect.objectContaining({ id: "gen-1", status: "source" }));
      expect(host.changed).toHaveBeenCalledWith(new Set(), new Set(["builder-work", "chief-chat"]));
      expect(coordinator.has("gen-1")).toBe(true);
      expect(coordinator.node("gen-1")).toMatchObject({ status: "source", origin: { kind: "user", request: "Ship it" } });
      expect(coordinator.all().map(n => n.id).sort()).toEqual(["gen-1", node.id].sort());
      expect(coordinator.children("gen-1").map(n => n.id)).toEqual([node.id]);
      expect(coordinator.enqueue(chief, "gen-1", undefined, builder, "builder", "Build it")).toMatchObject({ duplicate: true, node: { id: node.id } });
      expect(coordinator.sharedRequest(node)).toEqual({ id: node.id, botIds: ["builder"] });
      expect(coordinator.activeDirect("builder-work")).toBe(true);
      expect(coordinator.assignerOf("builder-work")?.id).toBe("gen-1");
      expect(coordinator.outstandingDirect("chief-chat").map(n => n.id)).toEqual([node.id]);
      expect(coordinator.liveEdges()).toEqual([{ sourceBotId: "chief", targetBotId: "builder", state: "queued", threadId: "builder-work" }]);
      expect(coordinator.continuesAfterRestart("chief-chat")).toBe(true);
      expect(coordinator.restartNote(node, id => id)).toBe("");
      // the runtime-only entry points are no-ops here
      coordinator.progress("builder-work");
      expect(coordinator.answer("builder-work", "yes")).toBe(false);
      coordinator.tick(); await flush();
      expect(host.runs).toHaveLength(1);
      expect(host.runs[0]).toMatchObject({ node: { id: node.id }, resumed: false, composed: undefined });
      expect(host.busy).toHaveBeenCalled();
      expect(coordinator.node(node.id)?.status).toBe("completed");
      coordinator.tick();
      expect(host.report).toHaveBeenCalledWith(expect.objectContaining({ id: node.id, status: "completed" }), expect.objectContaining({ id: "gen-1" }));
      coordinator.sourceSettled("gen-1", true);
      expect(coordinator.node("gen-1")?.status).toBe("waiting");
      coordinator.tick(); await flush();
      expect(host.runs).toHaveLength(2);
      expect(host.runs[1]).toMatchObject({ node: { id: "gen-1" }, resumed: true });
      expect(coordinator.node("gen-1")?.status).toBe("completed");
      // stops reach the tree too
      const other = coordinator.enqueue(chief, "gen-2", undefined, { botId: "tester", threadId: "tester-work" }, "tester", "Test it").node;
      coordinator.cancelDirect("tester-work", "The source conversation was deleted");
      expect(coordinator.node(other.id)).toMatchObject({ status: "cancelled", result: "The source conversation was deleted" });
      const roomChild = coordinator.enqueue(chief, "gen-3", undefined, { groupId: "g1", threadId: "room-1", botId: "peer" }, "peer", "Review it").node;
      coordinator.cancelRoom("g1", "room-1", "Provider reloaded", "failed");
      expect(coordinator.node(roomChild.id)).toMatchObject({ status: "failed", result: "Provider reloaded" });
      const stopped = coordinator.enqueue(chief, "gen-4", undefined, { botId: "scout", threadId: "scout-work" }, "scout", "Scout it").node;
      expect(coordinator.stopAwaitingDirect("chief-chat")).toEqual([]);
      expect(coordinator.node(stopped.id)?.status).toBe("cancelled");
      coordinator.close();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("createCoordinator picks the runtime coordinator by kind", () => {
    const coordinator = createCoordinator("runtime", { dataDir: ":memory:", host: fakeHost() });
    expect(coordinator.kind).toBe("runtime");
    expect(coordinator.all()).toEqual([]);
    coordinator.close();
  });
});
