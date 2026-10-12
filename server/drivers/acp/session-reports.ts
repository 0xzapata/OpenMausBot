// What an ACP agent says about its own session beyond text and tools.
// core.ts hands each such `session/update` to readSessionReport and acts on
// what comes back; the reading lives here so the driver core does not grow.
//
// Everything here arrives from another program, so each reader takes exactly
// the documented shape and treats anything else as nothing said: an
// unreadable report must never fail a turn or put a guess in the chat.

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A reported context below this share of the peak marks a compaction.
 * OpenCode compactions measured 30-52% of the peak; ordinary dips stay
 * above 83%. A false alarm costs one extra full prompt. */
const ACP_COMPACTION_COLLAPSE_RATIO = 0.6;

/** The running turn's compaction detection (AcpTurn.state in core.ts): peak
 * and last reported context size, and whether the agent compacted. */
export interface UsageState {
  usagePeak: number | null;
  usageLast: number | null;
  usageCompacted: boolean;
}

/** What core.ts does about one update. */
export interface SessionReport {
  /** The engine's own account of its window, for thread.token-usage.updated. */
  context?: { contextTokens: number; contextWindow?: number };
}

/** `usage_update`: how much the agent's next request will carry (`used`) and,
 * from agents that say, the window (`size`). Hermes sends both flat; opencode
 * 1.18 sends `used` flat or under `usage`. A report that is not a positive
 * count is not a measurement. */
function readUsage(update: any, turn: UsageState): SessionReport {
  const used = update.used ?? update.usage?.used;
  if (typeof used !== "number" || !(used > 0)) return {};
  // The agent may compact its own history without saying so: a report that
  // collapsed below the turn's peak is taken as one.
  if (turn.usagePeak !== null && used < turn.usagePeak * ACP_COMPACTION_COLLAPSE_RATIO) turn.usageCompacted = true;
  if (turn.usagePeak === null || used > turn.usagePeak) turn.usagePeak = used;
  turn.usageLast = used;
  // The same report is the engine's own account of its window, shown on the
  // context meter. It goes out as it arrives, so a turn that is stopped or
  // fails still leaves its last reading. core.ts sends it with zero input
  // and output: ACP counts those once, on the prompt result, whose event
  // comes last and is the turn's figure; a turn without one counts as
  // before, as none. An agent that names no usable size leaves the window
  // to the model's family.
  if (!Number.isFinite(used)) return {};
  const size = update.size ?? update.usage?.size;
  return {
    context: {
      contextTokens: used,
      ...(typeof size === "number" && Number.isFinite(size) && size > 0 ? { contextWindow: size } : {}),
    },
  };
}

/** Hermes says outright when it compressed its history: it rotates its own
 * session and sends a `session_info_update` whose
 * `_meta.hermes.sessionProvenance` carries `reason: "compression"` and a
 * `compressionDepth` one higher than before (hermes-agent `acp_adapter`,
 * commit 38570c3). Either is a compaction: the stated reason, or a depth
 * above the last one this session reported. `lastDepth` starts at 0, a root
 * session's depth, so a first sighting already past it counts; a false alarm
 * costs one extra full prompt, a missed compaction leaves the bot without
 * its instructions.
 *
 * Returns null when the meta carries no provenance at all, and otherwise
 * whether this notice marks a compaction and the depth to remember. */
export function hermesCompaction(meta: unknown, lastDepth: number): { compacted: boolean; depth: number } | null {
  const provenance = record(record(record(meta)?.hermes)?.sessionProvenance);
  if (!provenance) return null;
  const reported = provenance.compressionDepth;
  const depth = typeof reported === "number" && Number.isInteger(reported) && reported >= 0 ? reported : null;
  return {
    compacted: provenance.reason === "compression" || (depth !== null && depth > lastDepth),
    depth: depth ?? lastDepth,
  };
}

/** What a live native session has said about itself so far. */
interface Reported {
  sessionId: string | null;
  /** the compression depth Hermes last reported: a rise marks a compaction */
  compressionDepth: number;
}
/** Kept per pooled process (core.ts's session record), so it lasts across
 * turns exactly as long as the process does and is never shared. */
const reportedBy = new WeakMap<object, Reported>();
/** A process that has moved to another native session starts over. */
function reportedSoFar(session: { sessionId: string | null }): Reported {
  let reported = reportedBy.get(session);
  if (!reported || reported.sessionId !== session.sessionId) {
    reported = { sessionId: session.sessionId, compressionDepth: 0 };
    reportedBy.set(session, reported);
  }
  return reported;
}

/** Read one `session/update` an agent sent about its own session, record
 * what it means for the running turn, and say what the driver should emit.
 * `meta` is the notification's own `_meta`, `session` the pooled process's
 * record with its live native session id. */
export function readSessionReport(update: any, meta: unknown, turn: UsageState, session: { sessionId: string | null }): SessionReport {
  switch (update?.sessionUpdate) {
    case "usage_update":
      return readUsage(update, turn);
    case "session_info_update": {
      // Hermes's notice rides `_meta`, inside the update or beside it. The
      // consequence is the usage collapse's: the next turn re-sends the full
      // prompt. Session info from other agents, and meta that is not this
      // shape, says nothing and is not an error.
      const reported = reportedSoFar(session);
      const marker = hermesCompaction(update._meta, reported.compressionDepth) ?? hermesCompaction(meta, reported.compressionDepth);
      if (!marker) return {};
      reported.compressionDepth = marker.depth;
      if (marker.compacted) turn.usageCompacted = true;
      return {};
    }
    default:
      return {};
  }
}
