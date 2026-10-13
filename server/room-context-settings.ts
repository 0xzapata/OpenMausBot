// The room settings of config.json's `context` group: when a bot's room turn
// starts from a fresh provider session (server/room-context.ts), and whether
// a member whose session already holds the room is sent only the new lines
// (server/host/room-sessions.ts). Their schema lives here rather than in
// server/config.ts, the way a new bot's defaults live in
// server/new-bot-defaults.ts: config.ts adds this shape to the group and
// keeps only the type. Only zod is imported, so reading a config file loads
// nothing of the rooms themselves.
import { z } from "zod";

export const roomContextSettings = {
  /** Before a bot's room turn, start a fresh provider session once its
   * context in that room reaches this (fraction below 1, or a token
   * count). Default 0.9; autoCompact: false turns it off too. */
  roomCompactAt: z.number().positive().max(10_000_000).optional(),
  /** A room member whose provider session is known to hold the room's
   * earlier lines is sent only the lines it has not been handed, instead of
   * the room's recent transcript again. Off unless true; see
   * roomSessionsEnabled for the environment override. Claude Code only. */
  roomSessions: z.boolean().optional(),
};

/** `context.roomSessions`, off unless switched on. OMB_ROOM_SESSIONS wins
 * over the file when it is "1" (on) or "0" (off), so one server process can
 * be pinned either way; any other value leaves the file to decide. */
export function roomSessionsEnabled(
  settings: { roomSessions?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = env.OMB_ROOM_SESSIONS?.trim();
  if (override === "1") return true;
  if (override === "0") return false;
  return settings?.roomSessions === true;
}
