// The CLI arguments of the Claude driver's background one-shot call
// (generateReview in ./claude.ts), kept apart so the driver stays a readable size.

type BackgroundFlag = "--tools" | "--no-session-persistence" | "--strict-mcp-config" | "--setting-sources";

/** A background call (memory upkeep, the skill review, titles, approval
 * summaries) that names no deadline of its own. */
export const BACKGROUND_CALL_TIMEOUT_MS = 60_000;

/** The CLI arguments of a background one-shot call. Isolated as a turn is
 * (no MCP servers, no user or local settings, so none of this machine's
 * hooks, skills or connectors) and with no built-in tools: without these
 * the CLI mounted every MCP server, plugin and skill of the person's own
 * Claude Code into each call, ~19k extra input tokens on a measured desktop,
 * and a reviewer told it had no tools in fact had them all. Each flag only
 * on a CLI that accepts it (CLAUDE_FLAG_FLOORS in ./claude.ts). The
 * `--tools` floor is not bisected: the guest path passes it from 2.1.257, so
 * it is known there; an older CLI runs the call with its default tools. */
export function backgroundCallArgs(input: {
  model: string;
  outputFormat: "json" | "text";
  /** Whether the installed CLI accepts a flag (claudeCliSupports). */
  supports: (flag: BackgroundFlag) => boolean;
  /** False while OMB_CLAUDE_INHERIT_USER_CONFIG asks for the person's own setup. */
  isolated: boolean;
}): string[] {
  const args = ["-p", "--model", input.model, "--output-format", input.outputFormat];
  if (input.supports("--tools")) args.push("--tools", "");
  if (input.supports("--no-session-persistence")) args.push("--no-session-persistence");
  if (input.isolated) {
    if (input.supports("--strict-mcp-config")) args.push("--strict-mcp-config");
    if (input.supports("--setting-sources")) args.push("--setting-sources", "project");
  }
  return args;
}
