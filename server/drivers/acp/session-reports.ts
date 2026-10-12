// What an ACP agent says about its own session beyond text and tools.
// core.ts hands each such `session/update` to readSessionReport and acts on
// what comes back; the reading lives here so the driver core does not grow.
//
// Everything here arrives from another program, so each reader takes exactly
// the documented shape and treats anything else as nothing said: an
// unreadable report must never fail a turn or put a guess in the chat.

import { cacheUntilConfigChanges } from "../../config.ts";
import { redactSecretsInText } from "../../redact.ts";
import { toolDetailPreview } from "../../tool-summary.ts";

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
  /** One finished tool step to show: an item.started / item.completed pair. */
  step?: { title: string; input?: string };
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

/** As much of a plan entry as a line shows: a tool chip's title is this long. */
const PLAN_TEXT_MAX = 80;

/** An agent's plan as one line of progress. ACP's `plan` update carries the
 * whole list every time, each entry a text with a status; the line says how
 * many are done and names the entry in hand, or the next one when none is:
 * `Plan: 2 of 5 done — Write the tests`. The entry's text is redacted before
 * it is cut, so a credential an agent wrote into its plan cannot be sliced
 * past the shapes redaction knows.
 *
 * Returns null when there is no entry with a text to count. */
export function planLine(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  const plan = entries.flatMap((entry) => {
    const fields = record(entry);
    const content = typeof fields?.content === "string" ? fields.content.replace(/\s+/g, " ").trim() : "";
    return content ? [{ content, status: fields?.status }] : [];
  });
  if (!plan.length) return null;
  const done = plan.filter((entry) => entry.status === "completed").length;
  const inHand = plan.find((entry) => entry.status === "in_progress");
  // no entry in hand: whatever is not done yet comes next, a status this
  // reader does not know included
  const focus = inHand ?? plan.find((entry) => entry.status !== "completed");
  const progress = `Plan: ${done} of ${plan.length} done`;
  if (!focus) return progress;
  const text = redactSecretsInText(focus.content);
  const shown = text.length > PLAN_TEXT_MAX ? `${text.slice(0, PLAN_TEXT_MAX - 1).trimEnd()}…` : text;
  return `${progress} — ${inHand ? "" : "next: "}${shown}`;
}

const planLinesInConfig = cacheUntilConfigChanges((config) => config.features?.acpPlanLines === true);

/** An agent's plan as activity lines: off until enabled by hand in
 * ~/.openmausbot/config.json (`{"features": {"acpPlanLines": true}}`),
 * because each line is a tool step and counts as a tool call wherever those
 * are counted (the digest, the activity log). OMB_ACP_PLAN_LINES wins when
 * it is `1` or `0`. The file is read here, when it changes: a driver holds
 * no live config. */
export function acpPlanLinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OMB_ACP_PLAN_LINES === "1") return true;
  if (env.OMB_ACP_PLAN_LINES === "0") return false;
  return planLinesInConfig();
}

/** What a live native session has said about itself so far. */
interface Reported {
  sessionId: string | null;
  /** the compression depth Hermes last reported: a rise marks a compaction */
  compressionDepth: number;
  /** the plan line last shown: a plan that reads the same is not shown again */
  planLine: string | null;
}
/** Kept per pooled process (core.ts's session record), so it lasts across
 * turns exactly as long as the process does and is never shared. */
const reportedBy = new WeakMap<object, Reported>();
/** A process that has moved to another native session starts over. */
function reportedSoFar(session: { sessionId: string | null }): Reported {
  let reported = reportedBy.get(session);
  if (!reported || reported.sessionId !== session.sessionId) {
    reported = { sessionId: session.sessionId, compressionDepth: 0, planLine: null };
    reportedBy.set(session, reported);
  }
  return reported;
}

/** Read one `session/update` an agent sent about its own session, record
 * what it means for the running turn, and say what the driver should emit.
 * `meta` is the notification's own `_meta`, `session` the pooled process's
 * record with its live native session id. */
export function readSessionReport(
  update: any,
  meta: unknown,
  turn: UsageState,
  session: { sessionId: string | null },
  env: NodeJS.ProcessEnv = process.env,
): SessionReport {
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
    case "plan": {
      // The agent's own plan, shown as one finished tool step each time it
      // reads differently: ACP sends the whole list on every update, so a
      // list whose line is the one last shown says nothing new, in this turn
      // or a later one. The step is how Claude's todo tool already appears
      // (a tool item with the list as its bounded, redacted input). It is
      // not a reply: a turn that only planned still ends as a lost turn.
      if (!acpPlanLinesEnabled(env)) return {};
      const reported = reportedSoFar(session);
      const line = planLine(update.entries);
      if (line === null || line === reported.planLine) return {};
      reported.planLine = line;
      return { step: { title: line, input: toolDetailPreview(update.entries) } };
    }
    default:
      return {};
  }
}
