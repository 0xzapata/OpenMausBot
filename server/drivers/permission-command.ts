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

/** What a request to run a shell command puts on its event: the exact-command
 * descriptor, which needs a known working directory, and the engine's own
 * command line, which does not. The safety floor reads the second, so it
 * judges the same text whether or not the directory is known
 * (server/safety-floor-gate.ts). `command` is whatever the engine sent, or
 * undefined for a request that runs no shell command. */
export function shellRequest(command: unknown, cwd: unknown): { command: ReturnType<typeof permissionCommand>; commandLine: string | undefined } {
  return { command: permissionCommand(command, cwd), commandLine: typeof command === "string" && command.trim() ? command : undefined };
}

/** Whether a driver that answers a request inside the driver, with nobody
 * looking (Full access, a kept "Always allow this session"), may answer one
 * for this command. False for a shell command the safety floor does not
 * clear: the driver then answers nothing and raises the request like any
 * other, carrying the same command line, and the harness decides. */
export function answersAlone(command: unknown): boolean {
  return safetyFloorClears(typeof command === "string" ? command : undefined);
}

export function permissionLaunchCwd(cwd: string): string | undefined {
  try { return realpathSync(cwd); } catch { return undefined; }
}

/** ACP's rawInput is provider-specific. Accept a complete command string and
 * unambiguous absolute directory fields. A relative/invalid/conflicting
 * directory is not evidence of where the agent will execute it. */
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

/** shellRequest for an ACP tool call. Only a call typed as a shell command
 * gets the exact-command descriptor; any call that names a command line
 * carries it for the safety floor. */
export function acpShellRequest(isShellCommand: boolean, rawInput: unknown, launchCwd: string | undefined): ReturnType<typeof shellRequest> {
  const command = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>).command : undefined;
  return { command: isShellCommand ? acpPermissionCommand(rawInput, launchCwd) : undefined, commandLine: shellRequest(command, undefined).commandLine };
}
