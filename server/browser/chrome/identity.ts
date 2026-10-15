// A headless Chrome tells pages it is headless only through "HeadlessChrome/" in its user agent; everything else it reports
// is what the same binary reports headed. So the identity is read from the binary itself, once per version, and only that
// token changes. The user-agent flag alone empties the high-entropy client hints, and a CDP override alone leaves
// HeadlessChrome in service workers, so the browser gets both (Chrome 153, measured).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectCdp, type Cdp } from "../../browser-sites.ts";

export interface Brand { brand: string; version: string }

/** CDP's Emulation.UserAgentMetadata. */
export interface UserAgentMetadata {
  brands: Brand[];
  fullVersionList: Brand[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  formFactors: string[];
}

export interface ChromeIdentity { userAgent: string; userAgentMetadata: UserAgentMetadata }

export const HIGH_ENTROPY_HINTS = ["architecture", "bitness", "brands", "formFactors", "fullVersionList", "mobile", "model", "platform", "platformVersion", "uaFullVersion", "wow64"] as const;

function brands(value: unknown, what: string): Brand[] {
  if (!Array.isArray(value) || !value.length || !value.every((entry) => typeof entry?.brand === "string" && typeof entry?.version === "string")) {
    throw new Error(`the browser reported no ${what}`);
  }
  return value.map(({ brand, version }) => ({ brand, version }));
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`the browser reported no ${what}`);
  return value;
}

/** What a headless launch read, as that binary reports it headed. A build that names itself headless anywhere else, such as
 * the headless shell, cannot be made to look like Chrome and is refused. */
export function headedIdentity(read: { userAgent: unknown; hints: Record<string, unknown> | null | undefined }): ChromeIdentity {
  const userAgent = text(read.userAgent, "user agent").replace("HeadlessChrome/", "Chrome/");
  if (!/ Chrome\/\d+\.0\.0\.0 /u.test(userAgent) || /headless/iu.test(userAgent)) throw new Error(`the browser's user agent is not Chrome's: ${userAgent}`);
  const hints = read.hints ?? {};
  const metadata: UserAgentMetadata = {
    brands: brands(hints.brands, "brands"),
    fullVersionList: brands(hints.fullVersionList, "full version list"),
    fullVersion: text(hints.uaFullVersion, "full version"),
    platform: text(hints.platform, "platform"),
    platformVersion: text(hints.platformVersion, "platform version"),
    architecture: text(hints.architecture, "architecture"),
    model: text(hints.model, "model"),
    mobile: hints.mobile === true,
    bitness: text(hints.bitness, "bitness"),
    wow64: hints.wow64 === true,
    formFactors: Array.isArray(hints.formFactors) ? hints.formFactors.filter((value): value is string => typeof value === "string") : [],
  };
  if ([...metadata.brands, ...metadata.fullVersionList].some(({ brand }) => /headless/iu.test(brand))) throw new Error("the browser reports a headless brand");
  return { userAgent, userAgentMetadata: metadata };
}

export function isChromeIdentity(value: unknown): value is ChromeIdentity {
  try {
    const identity = value as ChromeIdentity;
    const again = headedIdentity({ userAgent: identity.userAgent, hints: { ...identity.userAgentMetadata, uaFullVersion: identity.userAgentMetadata.fullVersion } });
    return JSON.stringify(again) === JSON.stringify(identity);
  } catch {
    return false;
  }
}

const READ_IDENTITY = `(async () => ({ userAgent: navigator.userAgent, hints: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HIGH_ENTROPY_HINTS)}) : null }))()`;

async function waitFor<T>(read: () => T | null, deadline: number, what: string): Promise<T> {
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`the browser did not ${what} in time`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** agent-browser 0.37 adds --no-sandbox in these same places; a sandboxed Chrome cannot start there. */
export function needsNoSandbox(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  if (process.platform !== "linux") return false;
  return exists("/.dockerenv") || exists("/run/.containerenv") || process.getuid?.() === 0 || Boolean(env.CI);
}

/** Starts the binary headless on a throwaway profile, reads its identity from a loopback page (client hints need a secure
 * context) and stops it again. `env` is the browser's: its HOME must be the person's real one, or macOS shows a "keychain
 * cannot be found" dialog. */
export async function calibrateIdentity(executable: string, options: { timeoutMs?: number; connect?: typeof connectCdp; env?: NodeJS.ProcessEnv } = {}): Promise<ChromeIdentity> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const page = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>calibration</title>");
  });
  await new Promise<void>((resolve, reject) => { page.once("error", reject); page.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
  const profile = mkdtempSync(join(tmpdir(), "omb-chrome-identity-"));
  const args = [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync",
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
    ...(needsNoSandbox(options.env) ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    url,
  ];
  const chrome = spawn(executable, args, { stdio: "ignore", windowsHide: true, env: options.env ?? process.env });
  let exited = false;
  const started = new Promise<void>((resolve, reject) => {
    chrome.once("error", (error) => { exited = true; reject(error); });
    chrome.once("exit", (code, signal) => { exited = true; reject(new Error(`the browser exited (${code ?? signal}) before it answered`)); });
    chrome.once("spawn", resolve);
  });
  let cdp: Cdp | null = null;
  try {
    await started;
    const portFile = join(profile, "DevToolsActivePort");
    const [port, path] = await waitFor(() => {
      if (exited) throw new Error("the browser exited before it answered");
      try { const lines = readFileSync(portFile, "utf8").split("\n"); return lines[1] ? lines : null; } catch { return null; }
    }, deadline, "start");
    cdp = await (options.connect ?? connectCdp)(`ws://127.0.0.1:${port!.trim()}${path!.trim()}`, Math.max(1_000, deadline - Date.now()));
    const target = await waitForPage(cdp, url, deadline);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true }) as { sessionId: string };
    const answer = await cdp.send("Runtime.evaluate", { expression: READ_IDENTITY, awaitPromise: true, returnByValue: true }, sessionId) as {
      result?: { value?: { userAgent?: unknown; hints?: Record<string, unknown> | null } };
    };
    return headedIdentity({ userAgent: answer.result?.value?.userAgent, hints: answer.result?.value?.hints });
  } finally {
    await cdp?.send("Browser.close").catch(() => undefined);
    cdp?.close();
    if (!exited) {
      const gone = new Promise((resolve) => chrome.once("exit", resolve));
      const kill = setTimeout(() => chrome.kill("SIGKILL"), 3_000);
      await gone;
      clearTimeout(kill);
    }
    page.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function waitForPage(cdp: Cdp, url: string, deadline: number): Promise<string> {
  for (;;) {
    const { targetInfos } = await cdp.send("Target.getTargets") as { targetInfos?: Array<{ type?: string; url?: string; targetId?: string }> };
    const found = targetInfos?.find((target) => target.type === "page" && target.url === url && typeof target.targetId === "string");
    if (found) return found.targetId!;
    if (Date.now() > deadline) throw new Error("the browser did not open its calibration page in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
