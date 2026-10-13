// `openmausbot sentinel`: one read-only health scan of a data dir, then a
// short summary. Meant to be run every couple of minutes by launchd or
// systemd (`openmausbot service install --sentinel`); a run that finds the
// sources unchanged since the last one exits at once.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { defaultSentinelOut, isInside } from "./paths.ts";
import { runScan, type ScanSummary } from "./scan.ts";

export interface SentinelArgs {
  dataDir: string;
  out: string;
  json: boolean;
  queueWaitMs?: number;
  costUsd?: number;
  help?: boolean;
}

export const SENTINEL_USAGE = `openmausbot sentinel [--data-dir DIR] [--out DIR] [--once] [--json]
                     [--queue-wait SECONDS] [--cost USD]

Scans an OpenMausBot data dir, read-only, for failed tool calls, stopped or
timed-out turns, long queue waits, expensive turns and retry loops, and keeps
them as issues in issues.jsonl, outside the data dir: on macOS in
~/Library/Application Support/openmausbot-sentinel, on Linux in
$XDG_STATE_HOME/openmausbot-sentinel (~/.local/state/…), or in --out. Issues
point at the evidence by id and carry a normalized one-line title; they never
copy tool output or message text.

--out         where issues.jsonl and state.json go (not in the data dir or a repository)
--once        run one scan and exit (what every run does; for schedulers)
--json        print the summary as JSON
--queue-wait  flag delegated work queued longer than this (default 300)
--cost        flag a single turn costing more than this many dollars (default 5)`;

export function parseSentinelArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SentinelArgs | { error: string; json: boolean } {
  const json = argv.includes("--json");
  let dataDir = env.OMB_DATA_DIR || join(homedir(), ".openmausbot");
  let out: string | undefined;
  const args: Omit<SentinelArgs, "dataDir" | "out"> = { json };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    try {
      if (arg === "--data-dir") dataDir = resolve(value());
      else if (arg === "--out") out = resolve(value());
      else if (arg === "--once" || arg === "--json") continue;
      else if (arg === "--help" || arg === "-h") args.help = true;
      else if (arg === "--queue-wait" || arg === "--cost") {
        const number = Number(value());
        if (!Number.isFinite(number) || number < 0) return { error: `${arg} takes a number of 0 or more`, json };
        if (arg === "--queue-wait") args.queueWaitMs = number * 1000;
        else args.costUsd = number;
      } else return { error: `unknown argument "${arg}"; see openmausbot sentinel --help`, json };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), json };
    }
  }
  return { ...args, dataDir, out: out ?? defaultSentinelOut(dataDir, process.platform, homedir(), env) };
}

/** The nearest folder at or above `dir` holding a .git, if any. */
function enclosingRepo(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

export function runSentinelCli(argv: string[], io: { log(line: string): void; error(line: string): void } = console, env: NodeJS.ProcessEnv = process.env): number {
  const args = parseSentinelArgs(argv, env);
  const fail = (message: string, json: boolean, code = 1) => {
    if (json) io.log(JSON.stringify({ ok: false, error: message }));
    else io.error(`sentinel: ${message}`);
    return code;
  };
  if ("error" in args) return fail(args.error, args.json, 2);
  if (args.help) {
    io.log(SENTINEL_USAGE);
    return 0;
  }
  let isDir = false;
  try {
    isDir = statSync(args.dataDir).isDirectory();
  } catch {}
  if (!isDir) return fail(`no OpenMausBot data dir at ${args.dataDir}; pass --data-dir with the folder that holds messages.db`, args.json);
  // issues name bots and threads; they must never end up committed
  const repo = enclosingRepo(args.out);
  if (repo) return fail(`refusing to write issues inside the git repository at ${repo}; pass --out with a folder outside it`, args.json);
  // Sentinel only reads the data dir; its own files live elsewhere
  if (isInside(args.out, args.dataDir)) return fail(`refusing to write issues inside the data dir ${args.dataDir}; leave out --out for the default, or pass a folder outside it`, args.json);
  let summary: ScanSummary;
  try {
    summary = runScan({ dataDir: args.dataDir, out: args.out, queueWaitMs: args.queueWaitMs, costUsd: args.costUsd });
  } catch (error) {
    return fail(`scan of ${args.dataDir} failed: ${error instanceof Error ? error.message : String(error)}`, args.json);
  }
  if (args.json) io.log(JSON.stringify({ ok: true, out: args.out, ...summary }));
  else for (const line of formatSummary(summary, args.out)) io.log(line);
  return 0;
}

export function formatSummary(summary: ScanSummary, out: string): string[] {
  if (!summary.scanned) return [`sentinel: nothing changed since the last scan (${summary.totalIssues} issues in ${join(out, "issues.jsonl")})`];
  const { tool, turn, queue } = summary.records;
  const lines = [
    `sentinel: read ${tool} failed tool calls, ${turn} finished turns, ${queue} queue waits; ` +
    `${summary.added} new occurrences in ${summary.touched.length} issues (${summary.totalIssues} total)`,
  ];
  for (const issue of summary.touched.slice(0, 10)) {
    const turns = issue.wastedTurns ? `, ${issue.wastedTurns} turns` : "";
    lines.push(`  ${issue.severity.padEnd(6)} ${issue.kind.padEnd(12)} ${issue.origin.padEnd(8)} ${issue.tool ?? "-"} ×${issue.count}${turns}: ${issue.title ?? issue.sig}`);
  }
  if (summary.touched.length > 10) lines.push(`  … and ${summary.touched.length - 10} more`);
  lines.push(`issues: ${join(out, "issues.jsonl")}`);
  return lines;
}
