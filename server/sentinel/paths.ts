// Where Sentinel keeps its issues and log by default: the platform's place
// for an app's own state, outside the OpenMausBot data dir it scans. Backups
// and copies of the data dir never carry Sentinel's files, and Sentinel
// never writes into the folder it only reads. Pure, so the service renderer
// can print the same path the scan will use.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

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

/** Whether `child` is `parent` or anywhere under it. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === "win32" ? win32 : posix;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
