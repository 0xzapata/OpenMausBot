// What the harness tells the model after a shell call hit its time limit.
// Claude Code reports the kill as a PostToolUseFailure whose error reads
// "Exit code 143\nCommand timed out after 2m 0s"; the output is gone, and
// without a nudge the model reruns the same command into the same wall.

const TIMED_OUT = /\bCommand timed out after\b/u;
// `find /`, `find / -name …`, `sudo find /`: a search rooted at the disk root
const DISK_SCAN = /(?:^|[;&|(]\s*|\bsudo\s+)find\s+\/(?:\s|$)/mu;

/** The extra context for a timed-out Bash call, or null for anything else. */
export function shellTimeoutHint(toolName: unknown, toolInput: unknown, error: unknown): string | null {
  if (toolName !== "Bash" || typeof error !== "string" || !TIMED_OUT.test(error)) return null;
  const command = toolInput && typeof toolInput === "object" ? (toolInput as { command?: unknown }).command : undefined;
  const scan = typeof command === "string" && DISK_SCAN.test(command);
  return [
    "That command hit the shell time limit and its output was lost. Do not rerun it the same way.",
    scan
      ? "Do not search the whole disk: use `mdfind -name <name>` on macOS, or `find` in a specific folder (your workspace, home, /Applications) with -maxdepth."
      : "If it needs longer, rerun it with a larger `timeout` (in milliseconds, up to 600000), or start it detached with `nohup <command> > /tmp/<job>.log 2>&1 &` and check that log in later calls. Split very long media jobs into shorter pieces.",
  ].join(" ");
}
