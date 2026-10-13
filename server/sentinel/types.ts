// Sentinel's shapes: the normalized records its sources produce, the
// observations its detectors return, and the issues it keeps. Records carry
// text (a tool's error output) only in memory, for signatures; an issue
// stores references to its evidence and never the text itself.

/** Who owns the failing piece: OpenMausBot itself (a bug to fix here), a
 * shell command the bot ran, or anything else — another MCP server, the
 * engine's own built-in tools, the provider account. */
export type Origin = "harness" | "external" | "shell";
export type Severity = "high" | "medium" | "low";

/** Where an occurrence can be looked up again: a message id in messages.db,
 * a runtime event id in events/<threadId>.ndjson, an assignment id in
 * runtime.db. */
export interface EvidenceRef {
  source: "messages" | "events" | "runtime";
  id: string;
}

export type SentinelRecord =
  /** A finished tool call (an activity row with a settled `tool.ok`). */
  | {
    type: "tool"; id: string; threadId: string; turnId?: string; botId?: string; at: number;
    /** A tool identifier, or "harness_notice" for a sentence the harness
     * wrote into the transcript (a stopped room turn, a failed handoff). */
    tool: string;
    ok: boolean;
    /** The error output or notice, bounded. Signatures only; never stored. */
    text: string;
  }
  /** A turn.completed runtime event. */
  | { type: "turn"; id: string; threadId: string; turnId?: string; botId?: string; at: number; ok: boolean; stopReason: string | null; cost: number | null }
  /** A delegated assignment's wait from queued to started; `started: false`
   * is one still waiting at scan time. */
  | { type: "queue"; id: string; assignmentId: string; threadId: string; botId?: string; at: number; waitMs: number; started: boolean };

export interface Observation {
  kind: string;
  signature: string;
  /** A readable line for the issue: the normalized error (placeholders for
   * paths, numbers, ids and quoted values) or what was measured. */
  title: string;
  origin: Origin;
  severity: Severity;
  tool?: string;
  botId?: string;
  threadId?: string;
  turnId?: string;
  at: number;
  /** Stable identity of this occurrence: observing it again on a later scan
   * never counts it twice. */
  occurrence: string;
  evidence: EvidenceRef;
}

export interface DetectorConfig {
  /** queue_wait: an assignment waiting longer than this. */
  queueWaitMs: number;
  /** cost: a single turn costing more than this many dollars. */
  costUsd: number;
  /** retry_loop: the same failure this many times in one turn. */
  retryLoopMin: number;
  now: number;
}

/** A detector is a pure function of the records in the scan window. It may
 * see the same record on several scans; `occurrence` makes that harmless. */
export interface Detector {
  name: string;
  detect(records: readonly SentinelRecord[], config: DetectorConfig): Observation[];
}

/** One line of issues.jsonl. */
export interface Issue {
  sig: string;
  kind: string;
  /** Local only, from the newest occurrence. Anything Sentinel shares later
   * (community counts) carries sig, kind, origin, tool and count, never
   * this: normalized text can still hold a name. */
  title: string;
  origin: Origin;
  severity: Severity;
  tool?: string;
  botId?: string;
  threadId?: string;
  turnId?: string;
  firstAt: number;
  lastAt: number;
  count: number;
  /** Distinct turns this issue showed up in. */
  wastedTurns: number;
  /** The most recent occurrence. */
  evidenceRef: EvidenceRef;
}
