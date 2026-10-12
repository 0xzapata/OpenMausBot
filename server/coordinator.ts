// The seam between the server and whichever coordinator runs teammate
// work: the legacy room-handoff tree (room-handoffs.ts) or the job runtime
// (server/runtime/, docs/runtime-contract.md). index.ts talks to this
// interface only, so the cut-over is one switch (features.runtime, or
// OMB_RUNTIME=1) and the legacy path is deleted without touching call sites.
//
// HandoffView is the legacy node shape, kept as the read model for the
// cut-over releases: the runtime coordinator projects its Assignment rows
// onto it. When the legacy coordinator goes, the view goes with it.
import { join } from "node:path";

import type { WorkOrigin } from "./peer-provenance.ts";
import { RoomHandoffs, type RoomAddress, type RoomHandoff, type RoomHandoffHooks, ROOM_HANDOFF_LIMITS } from "./room-handoffs.ts";
import { RuntimeCoordinator } from "./runtime-coordinator.ts";
import type { EnvelopeNames, Level, Limits } from "./runtime/types.ts";

export type HandoffView = RoomHandoff;
export type CoordinatorKind = "legacy" | "runtime";

/** The turn text the runtime path composed (one envelope, one report) for
 * the host to run as it is; absent on the legacy path, where the host
 * builds its own coordination text. */
export interface ComposedTurn {
  text: string;
}

export interface LiveHandoffEdge {
  sourceBotId: string;
  targetBotId: string;
  state: "queued" | "running";
  threadId: string;
  groupId?: string;
}

/** What the server gives a coordinator: the legacy hooks, plus what only
 * the runtime path asks for (names, parking, the level a thread really
 * runs with). Every method may throw; the runtime path logs and retries. */
export interface CoordinatorHost extends Omit<RoomHandoffHooks, "run"> {
  run(node: HandoffView, resumed: boolean, signal: AbortSignal, composed?: ComposedTurn): Promise<{ ok: boolean; text: string }>;
  /** Display names for the envelope of a turn. */
  names(node: HandoffView, parent?: HandoffView): EnvelopeNames;
  /** A teammate ended its turn on a question for the person: show it where
   * the work was asked for (and again after a restart). */
  park(node: HandoffView, question: string): void;
  /** The permission level the target thread will actually run with, after
   * the host applied any delegated level, and its engine kind. Recorded on
   * the assignment so the envelope states the truth (invariant I6). */
  levelOf(target: RoomAddress): { level: Level; driverKind?: string };
  /** The conversation is a Chief of Staff's. */
  chiefOf(address: RoomAddress): boolean;
}

export interface Coordinator {
  readonly kind: CoordinatorKind;
  node(id: string): HandoffView | undefined;
  has(id: string): boolean;
  all(): HandoffView[];
  children(id: string): HandoffView[];
  /** Same contract as RoomHandoffs.enqueue: throws an Error whose message is
   * the typed refusal the caller shows the model. */
  enqueue(source: RoomAddress, generation: string, parentId: string | undefined, target: RoomAddress, key: string, text: string,
    approvalGranted?: boolean, rework?: boolean, sourceText?: string, requestBatchKey?: string, origin?: WorkOrigin): { node: HandoffView; duplicate: boolean };
  sharedRequest(node: HandoffView): { id: string; botIds: string[] };
  sourceSettled(generation: string, ok: boolean): void;
  cancelRoom(groupId: string, threadId?: string, reason?: string, status?: "failed" | "cancelled"): void;
  cancelDirect(threadId: string, reason?: string): void;
  activeDirect(threadId: string): boolean;
  assignerOf(threadId: string): HandoffView | undefined;
  outstandingDirect(threadId: string): HandoffView[];
  liveEdges(): LiveHandoffEdge[];
  stopAwaitingDirect(threadId: string, reason?: string): HandoffView[];
  continuesAfterRestart(threadId: string): boolean;
  restartNote(node: HandoffView, nameOf: (botId: string) => string): string;
  tick(): void;
  close(): void;
  /** Runtime path: the host saw activity on a coordinated turn in this
   * thread (an engine event). No-op on the legacy path. */
  progress(threadId: string): void;
  /** Runtime path: the person wrote in a thread whose assignment is parked
   * on a question; true when the assignment took the text as its answer and
   * the host must not start an ordinary turn. Always false on legacy. */
  answer(threadId: string, text: string): boolean;
}

export interface CoordinatorOptions {
  dataDir: string;
  host: CoordinatorHost;
  now?: () => number;
  /** Legacy tree limits (config roomHandoffLimits) and the runtime's. */
  legacyLimits?: Partial<typeof ROOM_HANDOFF_LIMITS>;
  runtimeLimits?: Partial<Limits>;
  log?: (line: string) => void;
}

/** The legacy coordinator: the room-handoff tree, unchanged, behind the
 * seam. Deleted when the runtime carries every path. */
export class LegacyCoordinator implements Coordinator {
  readonly kind = "legacy" as const;
  private readonly tree: RoomHandoffs;

  constructor(options: CoordinatorOptions) {
    const host = options.host;
    const hooks: RoomHandoffHooks = {
      validate: (node, parent) => host.validate(node, parent),
      busy: node => host.busy(node),
      run: (node, resumed, signal) => host.run(node, resumed, signal),
      report: (child, parent) => host.report(child, parent),
      changed: (groups, threads) => host.changed(groups, threads),
    };
    this.tree = new RoomHandoffs(join(options.dataDir, "room-handoffs.json"), hooks, options.now ?? Date.now, options.legacyLimits ?? {});
  }

  node(id: string) { return this.tree.nodes.get(id); }
  has(id: string) { return this.tree.nodes.has(id); }
  all() { return [...this.tree.nodes.values()]; }
  children(id: string) { return this.tree.children(id); }
  enqueue(source: RoomAddress, generation: string, parentId: string | undefined, target: RoomAddress, key: string, text: string,
    approvalGranted = false, rework = false, sourceText = "", requestBatchKey?: string, origin?: WorkOrigin) {
    return this.tree.enqueue(source, generation, parentId, target, key, text, approvalGranted, rework, sourceText, requestBatchKey, origin);
  }
  sharedRequest(node: HandoffView) { return this.tree.sharedRequest(node); }
  sourceSettled(generation: string, ok: boolean) { this.tree.sourceSettled(generation, ok); }
  cancelRoom(groupId: string, threadId?: string, reason?: string, status?: "failed" | "cancelled") { this.tree.cancelRoom(groupId, threadId, reason, status); }
  cancelDirect(threadId: string, reason?: string) { this.tree.cancelDirect(threadId, reason); }
  activeDirect(threadId: string) { return this.tree.activeDirect(threadId); }
  assignerOf(threadId: string) { return this.tree.assignerOf(threadId); }
  outstandingDirect(threadId: string) { return this.tree.outstandingDirect(threadId); }
  liveEdges() { return this.tree.liveEdges(); }
  stopAwaitingDirect(threadId: string, reason?: string) { return this.tree.stopAwaitingDirect(threadId, reason); }
  continuesAfterRestart(threadId: string) { return this.tree.continuesAfterRestart(threadId); }
  restartNote(node: HandoffView, nameOf: (botId: string) => string) { return this.tree.restartNote(node, nameOf); }
  tick() { this.tree.tick(); }
  close() { this.tree.close(); }
  progress(_threadId: string) {}
  answer(_threadId: string, _text: string) { return false; }
}

/** The runtime coordinator: Assignment rows in DATA_DIR/runtime.db,
 * projected onto HandoffView for the cut-over releases.
 * STUB: implemented in runtime-coordinator.ts; the signature is final. */
export function createCoordinator(kind: CoordinatorKind, options: CoordinatorOptions): Coordinator {
  if (kind === "legacy") return new LegacyCoordinator(options);
  if (kind === "runtime") return new RuntimeCoordinator(options);
  throw new Error(`unknown coordinator kind: ${String(kind)}`);
}
