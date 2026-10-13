// The settings a session replay reads from config.json's `context` group:
// how much history a rebuilt session is sent, and whether it is also told
// which tools already ran (server/context-rebuild.ts). Their schema lives
// here rather than in server/config.ts, the way a new bot's defaults live in
// server/new-bot-defaults.ts: config.ts adds this shape to the group and
// keeps only the type. Only zod is imported, so reading a config file does
// not load the replay itself.
import { z } from "zod";

export const replaySettings = {
  /** Bytes of history a rebuilt session is replayed; DEFAULT_REBUILD_BYTES
   * (server/context-rebuild.ts) when absent. The floor is the one
   * selectReplay itself refuses to go under. */
  rebuildBytes: z.number().int().min(1_024).max(1_000_000).optional(),
  /** A session rebuilt from an inline replay (an engine switched in
   * mid-thread, a rewind, a lost session, a compaction) is also told which
   * tools already ran, one line per call. Off unless true; see
   * replayToolHistoryEnabled for the environment override. */
  replayToolHistory: z.boolean().optional(),
};

/** `context.replayToolHistory`, off unless switched on. OMB_REPLAY_TOOL_HISTORY
 * wins over the file when it is "1" (on) or "0" (off). */
export function replayToolHistoryEnabled(
  settings: { replayToolHistory?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = env.OMB_REPLAY_TOOL_HISTORY?.trim();
  if (override === "1") return true;
  if (override === "0") return false;
  return settings?.replayToolHistory === true;
}
