import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import { safetyFloorClears } from "../safety-floor-gate.ts";

/** Approval identity preserves every command byte, including whitespace and
 * newlines. Callers must supply native shell input, never a display preview. */
export function permissionCommand(command: unknown, cwd: unknown): { command: string; cwd: string } | undefined {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) return undefined;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return undefined;
  return { command, cwd };
}

/** A shell request's event fields: the exact-command descriptor, which needs a known cwd, and the raw command line
 * the safety floor reads, which does not. */
export function shellRequest(command: unknown, cwd: unknown): { command: ReturnType<typeof permissionCommand>; commandLine: string | undefined } {
  return { command: permissionCommand(command, cwd), commandLine: typeof command === "string" && command.trim() ? command : undefined };
}

/** Whether a driver may answer a request itself with nobody looking; when false it must raise the request instead. */
export function answersAlone(command: unknown): boolean {
  return safetyFloorClears(typeof command === "string" ? command : undefined);
}

export function permissionLaunchCwd(cwd: string): string | undefined {
  try { return realpathSync(cwd); } catch { return undefined; }
}

/** ACP's rawInput is provider-specific: only a complete command string and unambiguous absolute directories count. */
export function acpPermissionCommand(rawInput: unknown, launchCwd: string | undefined): ReturnType<typeof permissionCommand> {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return undefined;
  const input = rawInput as Record<string, unknown>;
  const directories = ["cwd", "workdir", "working_directory", "directory", "dir"]
    .filter((key) => input[key] !== undefined)
    .map((key) => input[key]);
  if (directories.some((value) => typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))) return undefined;
  if (new Set(directories).size > 1) return undefined;
  return permissionCommand(input.command, directories[0] ?? launchCwd);
}

/** shellRequest for an ACP tool call: only a shell-typed call gets the descriptor, but any call naming a command
 * line carries it for the safety floor. */
export function acpShellRequest(isShellCommand: boolean, rawInput: unknown, launchCwd: string | undefined): ReturnType<typeof shellRequest> {
  const command = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>).command : undefined;
  return { command: isShellCommand ? acpPermissionCommand(rawInput, launchCwd) : undefined, commandLine: shellRequest(command, undefined).commandLine };
}
