import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpBrowser } from "../cdp/browser.ts";
import { IDENTITY_PROBE, identityFromProbe, type Identity, type IdentityProbe } from "../cdp/identity.ts";
import type { HostKind } from "./flags.ts";
import { launchChrome } from "./launch.ts";
import { browserRoot } from "./profile.ts";

export interface BinaryStamp {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface CalibratedIdentity extends Identity {
  binary: BinaryStamp;
  calibratedAt: string;
}

/** An updated Chrome replaces its executable, which changes the stamp and so the identity file. */
export function binaryStamp(executablePath: string): BinaryStamp {
  const path = realpathSync(executablePath);
  const stat = statSync(path);
  return { path, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

export function identityFile(dataDir: string, stamp: BinaryStamp): string {
  const hash = createHash("sha256").update(`${stamp.path}\n${stamp.size}\n${stamp.mtimeMs}`).digest("hex").slice(0, 24);
  return join(browserRoot(dataDir), "identity", `${hash}.json`);
}

/** A blank page on an ephemeral loopback port: loopback is a secure context, where navigator.userAgentData exists. */
async function loopbackPage(): Promise<{ url: string; close: () => void }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>calibration</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

export interface CalibrateOptions {
  executablePath: string;
  host: HostKind;
  /** Where the throwaway profile goes. */
  tmpRoot?: string;
  sandbox?: boolean;
  timeoutMs?: number;
}

/**
 * Reads what this binary reports about itself, headless, with no override and
 * no gate: the user agent with "HeadlessChrome" made "Chrome" (what it sends
 * headed) and its own client-hint metadata, read in the isolated world.
 */
export async function calibrateIdentity(options: CalibrateOptions): Promise<CalibratedIdentity> {
  const stamp = binaryStamp(options.executablePath);
  const userDataDir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "omb-calibrate-"));
  const page = await loopbackPage();
  const chrome = await launchChrome({
    executablePath: options.executablePath,
    userDataDir,
    mode: "headless",
    host: options.host,
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  }).catch((error: unknown) => {
    page.close();
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  });
  try {
    const browser = await CdpBrowser.connect(chrome.transport, { identity: null, headless: true, permissions: false });
    const tab = await browser.waitForPage(() => true, options.timeoutMs ?? 15_000);
    await tab.navigate(page.url, { timeoutMs: options.timeoutMs ?? 15_000 });
    const probe = await tab.evaluate(IDENTITY_PROBE) as IdentityProbe;
    const identity = identityFromProbe(probe, chrome.version.product);
    await browser.close();
    return { ...identity, binary: stamp, calibratedAt: new Date().toISOString() };
  } finally {
    await chrome.close(3_000);
    page.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function readCalibration(file: string, stamp: BinaryStamp): CalibratedIdentity | null {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as CalibratedIdentity;
    const same = stored.binary?.path === stamp.path && stored.binary.size === stamp.size && stored.binary.mtimeMs === stamp.mtimeMs;
    return same && typeof stored.userAgent === "string" && stored.userAgentMetadata ? stored : null;
  } catch {
    return null;
  }
}

/** Calibrates once per binary path and version, about a second, and keeps the result in `browser/identity/`. */
export async function loadOrCalibrateIdentity(dataDir: string, options: CalibrateOptions): Promise<{ identity: CalibratedIdentity; file: string; calibrated: boolean }> {
  const stamp = binaryStamp(options.executablePath);
  const file = identityFile(dataDir, stamp);
  const stored = readCalibration(file, stamp);
  if (stored) return { identity: stored, file, calibrated: false };
  const identity = await calibrateIdentity(options);
  mkdirSync(join(browserRoot(dataDir), "identity"), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return { identity, file, calibrated: true };
}
