// Where Sentinel keeps its issues and log by default: the platform's place
// for an app's own state, outside the OpenMausBot data dir it scans. Backups
// and copies of the data dir never carry Sentinel's files, and Sentinel
// never writes into the folder it only reads. The default is pure, so the
// service renderer can print the same path the scan will use.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

const FOLDER = "openmausbot-sentinel";

export function defaultSentinelOut(dataDir: string, platform: NodeJS.Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const path = platform === "win32" ? win32 : posix;
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support", FOLDER)
    : platform === "win32" ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), FOLDER)
    : path.join(state, FOLDER);
  // the usual data dir gets the folder itself; any other its own subfolder,
  // so two workspaces never count into one set of issues
  const resolved = path.resolve(dataDir);
  if (resolved === path.join(home, ".openmausbot")) return base;
  return path.join(base, `data-${createHash("sha256").update(resolved).digest("hex").slice(0, 12)}`);
}

/** `path` with every symlink in its existing part resolved: the nearest
 * existing ancestor through realpath, and the rest appended as given. A
 * link to a folder inside a repository or the data dir is judged by where
 * it leads. */
export function resolveThroughLinks(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** The nearest folder at or above `dir` holding a .git, if any. */
function enclosingRepo(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

/** Why Sentinel must not write to `out`, or null. Its issues name bots and
 * threads, so they never go inside a repository, and it only reads the
 * data dir. The CLI and the service installer both ask before writing. */
export function outRefusal(out: string, dataDir: string): string | null {
  const target = resolveThroughLinks(out);
  const repo = enclosingRepo(target);
  if (repo) return `refusing to write issues inside the git repository at ${repo}; pass --out with a folder outside it`;
  if (isInside(target, resolveThroughLinks(dataDir))) return `refusing to write issues inside the data dir ${dataDir}; leave out --out for the default, or pass a folder outside it`;
  return null;
}

/** Whether `child` is `parent` or anywhere under it. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === "win32" ? win32 : posix;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
