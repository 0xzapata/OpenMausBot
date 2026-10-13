// One Sentinel scan: read what changed in an OpenMausBot data dir, run every
// detector over it, and fold the observations into issues. Plain code with
// explicit inputs and no server state, so the same scan runs from the CLI
// under launchd or systemd today and could run inside the server later.
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { DETECTORS } from "./detectors/index.ts";
import { readQueueRecords, readThreadOwners, readToolRecords, readTurnRecords } from "./sources.ts";
import { pruneSeen, readIssues, readState, upsertIssues, writeSentinelFiles } from "./store.ts";
import type { DetectorConfig, Issue, Observation, SentinelRecord } from "./types.ts";

export const DEFAULT_QUEUE_WAIT_MS = 300_000;
export const DEFAULT_COST_USD = 5;
/** Activity rows are rewritten when their tool finishes; reread this much. */
export const RESCAN_WINDOW_MS = 30 * 60_000;
/** How far back the first scan of a data dir looks. */
export const FIRST_SCAN_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export interface ScanOptions {
  dataDir: string;
  /** Where issues.jsonl and state.json live. */
  out: string;
  now?: number;
  queueWaitMs?: number;
  costUsd?: number;
  retryLoopMin?: number;
}

export interface ScanSummary {
  /** false: the sources had not changed since the last scan, nothing ran. */
  scanned: boolean;
  at: number;
  records: { tool: number; turn: number; queue: number };
  /** Occurrences counted for the first time by this scan. */
  added: number;
  /** Issues this scan created or counted into. */
  touched: Issue[];
  totalIssues: number;
}

export function runScan(options: ScanOptions): ScanSummary {
  const now = options.now ?? Date.now();
  const config: DetectorConfig = {
    queueWaitMs: options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS,
    costUsd: options.costUsd ?? DEFAULT_COST_USD,
    retryLoopMin: options.retryLoopMin ?? 3,
    now,
  };
  const state = readState(options.out);
  const fingerprint = sourceFingerprint(options.dataDir, config);
  if (state.fingerprint === fingerprint && state.lastScanAt !== null) {
    return { scanned: false, at: now, records: { tool: 0, turn: 0, queue: 0 }, added: 0, touched: [], totalIssues: readIssues(options.out).size };
  }
  const sinceAt = state.lastScanAt === null ? now - FIRST_SCAN_LOOKBACK_MS : state.lastScanAt - RESCAN_WINDOW_MS;
  const who = readThreadOwners(options.dataDir);
  const tools = readToolRecords(options.dataDir, sinceAt, who);
  const turns = readTurnRecords(options.dataDir, state.logs, who);
  const queue = readQueueRecords(options.dataDir, sinceAt, now, who);
  const records: SentinelRecord[] = [...tools, ...turns.records, ...queue];
  const issues = readIssues(options.out);
  // A fresh state beside existing issues (a state version bump, a deleted
  // state.json): its cursors start over, so only what happened after the
  // newest counted occurrence is new.
  const counted = state.lastScanAt === null && issues.size ? Math.max(...[...issues.values()].map((issue) => issue.lastAt)) : -Infinity;
  const observations: Observation[] = DETECTORS.flatMap((detector) => detector.detect(records, config)).filter((o) => o.at > counted);
  const { touched, added } = upsertIssues(issues, state, observations);
  state.logs = turns.offsets;
  state.lastScanAt = now;
  state.fingerprint = fingerprint;
  // nothing older than the next scan's window can be seen again
  pruneSeen(state, Math.min(sinceAt, now - RESCAN_WINDOW_MS));
  writeSentinelFiles(options.out, issues, state);
  return {
    scanned: true,
    at: now,
    records: { tool: tools.length, turn: turns.records.length, queue: queue.length },
    added,
    touched: [...touched].map((sig) => issues.get(sig)!).sort((a, b) => b.lastAt - a.lastAt),
    totalIssues: issues.size,
  };
}

/** Sizes, mtimes and inodes of everything a scan reads, and the thresholds
 * it reads them with. Cheap enough for every two minutes. */
export function sourceFingerprint(dataDir: string, config: Omit<DetectorConfig, "now">): string {
  const parts: string[] = [JSON.stringify([config.queueWaitMs, config.costUsd, config.retryLoopMin])];
  const add = (path: string, label: string) => {
    try {
      const stat = statSync(path);
      parts.push(`${label}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push(`${label}:-`);
    }
  };
  for (const name of ["messages.db", "messages.db-wal", "runtime.db", "runtime.db-wal", "bots.json"]) add(join(dataDir, name), name);
  let logs: string[] = [];
  try {
    logs = readdirSync(join(dataDir, "events")).filter((name) => name.endsWith(".ndjson")).sort();
  } catch {}
  for (const name of logs) add(join(dataDir, "events", name), `events/${name}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
