// What an ACP agent says about its own session beyond text and tools.
// core.ts hands each such `session/update` to readSessionReport and acts on
// what comes back; the reading lives here so the driver core does not grow.
//
// Everything here arrives from another program, so each reader takes exactly
// the documented shape and treats anything else as nothing said: an
// unreadable report must never fail a turn or put a guess in the chat.

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

/** Read one `session/update` an agent sent about its own session, record
 * what it means for the running turn, and say what the driver should emit. */
export function readSessionReport(update: any, turn: UsageState): SessionReport {
  switch (update?.sessionUpdate) {
    case "usage_update":
      return readUsage(update, turn);
    default:
      return {};
  }
}
