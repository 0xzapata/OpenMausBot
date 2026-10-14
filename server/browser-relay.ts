// The one way the harness reads from and captures a bot's browser: the
// engine's own loopback command relay. agent-browser's daemon serves HTTP on
// 127.0.0.1 (its stream server) and relays `POST /api/command` to itself over
// its session socket, answering with the daemon's JSON (agent-browser 0.36
// and 0.37, stream_http.rs). One round trip is about 1 ms; a CLI spawn is
// 5-6 ms and carries launch flags, and a second CDP client is a second
// mechanism (and a consent prompt on My Chrome).
//
// The daemon runs one command per session at a time, so a relayed read waits
// behind the bot's own command, and a read that timed out stays queued in the
// daemon after the HTTP request is gone. Every call here is bounded, and a
// session whose relay timed out is left alone until a quick probe answers.
//
// Nothing here launches a browser: a relayed command outside the engine's
// launch-free list (stream_status, session_info, ...) relaunches a Chrome
// that died, so every pass starts with `stream_status`, which says whether
// Chrome is connected, and reads only when it is.
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserDaemonFile, inRunningBrowser } from "./browser-engine.ts";
import { processAlive } from "./browser-processes.ts";
import { browserRuntimeEnv, type BrowserSpawnSpec } from "./browser-runtime.ts";

/** A session's browser as the harness addresses it: the engine binary and
 * the session's own environment (browserRuntimeEnv of its spec, with
 * AGENT_BROWSER_SESSION), which says where its daemon keeps its files. */
export interface RelayTarget { session: string; binaryPath: string; env: NodeJS.ProcessEnv }

export interface RelayAnswer {
  success: boolean;
  data: Record<string, unknown> | null;
  error?: string;
  /** The command launched a browser (`data.lifecycle.launched`). */
  launched: boolean;
}

/** The relay did not answer in time; the command may still be queued in the daemon. */
export class RelayTimeout extends Error {}

const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
export const PROBE_MS = 250;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** One relayed command. Resolves with the daemon's answer, success or not;
 * rejects on a timeout (RelayTimeout), a closed port or an oversized answer. */
export async function relay(port: number, command: Record<string, unknown>, options: { timeoutMs: number; maxBytes?: number }): Promise<RelayAnswer> {
  const origin = `http://127.0.0.1:${port}`;
  const maxBytes = options.maxBytes ?? MAX_ANSWER_BYTES;
  let response: Response;
  const signal = AbortSignal.timeout(Math.max(1, options.timeoutMs));
  try {
    response = await fetch(`${origin}/api/command`, {
      method: "POST", redirect: "error", signal,
      // The relay accepts only a same-origin request (stream_http.rs).
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(command),
    });
  } catch (error) {
    if (signal.aborted) throw new RelayTimeout("The browser did not answer in time.");
    throw error;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error("The browser's answer was too large.");
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    if (signal.aborted) throw new RelayTimeout("The browser did not answer in time.");
    throw error;
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* answered below */ }
  if (!parsed) return { success: false, data: null, error: `The browser relay answered HTTP ${response.status}.`, launched: false };
  const data = record(parsed.data);
  const lifecycle = record(data?.lifecycle);
  return {
    success: parsed.success === true && response.ok,
    data,
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    launched: lifecycle?.launched === true,
  };
}

type Known = { port: number; daemonPid: number | null };

/** Where each session's relay is, and which sessions to leave alone. */
export class RelayPorts {
  private known = new Map<string, Known>();
  private tripped = new Set<string>();
  private started = new Set<string>();
  private readFile: (path: string) => string | null;
  private alive: (pid: number) => boolean;

  constructor(options: { readFile?: (path: string) => string | null; alive?: (pid: number) => boolean } = {}) {
    this.readFile = options.readFile ?? ((path) => { try { return readFileSync(path, "utf8"); } catch { return null; } });
    this.alive = options.alive ?? ((pid) => processAlive(pid));
  }

  /** The session's relay port, from the `.stream` file its daemon writes
   * and deletes on exit, confirmed once per daemon by a relayed
   * `session_info` naming this session: a port a closed daemon left behind
   * may already belong to another bot's browser. Read again on every call,
   * so a daemon that exited is forgotten at once, and confirmed again once
   * the daemon it named has died (a crash leaves its file, and its port to
   * whichever daemon takes it next). Null when none runs; a daemon too busy
   * to confirm trips the session (unknown, never "not running"). */
  async port(target: RelayTarget): Promise<number | null> {
    const text = this.readFile(browserDaemonFile(target.env, ".stream"))?.trim() ?? "";
    const port = /^\d{1,5}$/.test(text) ? Number(text) : 0;
    if (port < 1 || port > 65_535) { this.known.delete(target.session); return null; }
    const known = this.known.get(target.session);
    if (known?.port === port && (known.daemonPid === null || this.alive(known.daemonPid))) return port;
    this.known.delete(target.session);
    try {
      const info = await relay(port, { action: "session_info" }, { timeoutMs: PROBE_MS * 4, maxBytes: 65_536 });
      if (!info.success || info.data?.session !== target.session) return null;
      const daemonPid = typeof info.data.backgroundPid === "number" ? info.data.backgroundPid : null;
      this.known.set(target.session, { port, daemonPid });
      return port;
    } catch (error) {
      if (error instanceof RelayTimeout) this.trip(target.session);
      return null;
    }
  }

  /** The daemon behind the confirmed port, as its process id. */
  daemonPid(session: string): number | null { return this.known.get(session)?.daemonPid ?? null; }

  /** After a relay timeout: no more relay work for this session until a probe answers. */
  trip(session: string): void { this.tripped.add(session); }

  /** Start of every relay pass: the port, and whether Chrome is connected
   * (`stream_status`, which never launches). Null when there is nothing to
   * read: no daemon, no answer within the probe budget, or a tripped
   * session whose probe still does not answer. */
  async probe(target: RelayTarget): Promise<{ port: number; connected: boolean } | null> {
    const port = await this.port(target);
    if (port === null) return null;
    try {
      const status = await relay(port, { action: "stream_status" }, { timeoutMs: PROBE_MS, maxBytes: 65_536 });
      this.tripped.delete(target.session);
      return { port, connected: status.success && status.data?.connected === true };
    } catch (error) {
      if (error instanceof RelayTimeout) this.trip(target.session);
      else this.known.delete(target.session);
      return null;
    }
  }

  /** Whether the last relay call for this session timed out and no probe has answered since. */
  isTripped(session: string): boolean { return this.tripped.has(session); }

  /** A relayed command found Chrome gone and the engine started it again
   * (`launched`): its page is blank and unsized until the bot's next call
   * sizes it and tells the bot (browser-steps.ts takes it). */
  noteStarted(session: string): void { this.started.add(session); }
  takeStarted(session: string): boolean { return this.started.delete(session); }

  /** The browser closed or restarted, or its transport stopped. */
  forget(session: string): void {
    this.known.delete(session);
    this.tripped.delete(session);
    this.started.delete(session);
  }
}

/** Type text into the page's focused field as real input (the Browser
 * tab's own "Type a password or code" path): one `keyboard insertText`
 * whose text travels only in this request's body, never on a command line.
 * A session with no `.stream` file asks the engine for its stream, as
 * fill_login always has: in the browser that is already running, never a
 * new one (inRunningBrowser). */
export async function typeText(ports: RelayPorts, target: RelayTarget, text: string): Promise<void> {
  let port = await ports.port(target);
  if (port === null) {
    let status = await inRunningBrowser(target.binaryPath, target.env, ["stream", "status"]);
    if (status && status.enabled !== true) status = await inRunningBrowser(target.binaryPath, target.env, ["stream", "enable"]);
    const value = status?.port;
    if (status?.enabled !== true || typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error("The browser did not open its local input channel. Restart the browser and try again.");
    }
    port = value;
  }
  let answer: RelayAnswer | null = null;
  try { answer = await relay(port, { action: "keyboard", subaction: "insertText", text }, { timeoutMs: 30_000, maxBytes: 65_536 }); }
  catch { /* reported below */ }
  if (answer?.success !== true) throw new Error("The browser did not take the typing.");
}

/** Preview frames are JPEG: a photo-heavy page was ~400 KB as PNG and
 * ~110 KB at quality 80, in 30-70 ms, and text stays legible. */
const FRAME_JPEG_QUALITY = 80;
/** The poller runs beside a live turn: a missing picture is better than a
 * stuck fold. Full Chrome headless on macOS can stall a fresh browser's
 * first capture 10-20 s; later captures take 30-100 ms. */
const FRAME_TIMEOUT_MS = 12_000;

/** One JPEG of a bot's browser for the live preview and the transcript's
 * settled frame, taken by the daemon the bot is driving. It never starts a
 * browser: with no daemon, or a Chrome that is not connected (closed by the
 * bot, idled out, crashed), there is simply no frame. The CLI this replaces
 * launched one — a turn that ended after agent_browser_close started a new
 * Chrome that then idled for an hour. */
export async function captureFrame(ports: RelayPorts, target: RelayTarget): Promise<{ png: string; format: "jpeg" }> {
  const probe = await ports.probe(target);
  if (!probe?.connected) throw new Error("the browser has no open page to picture");
  const file = join(tmpdir(), `openmausbot-browser-${randomUUID()}.jpg`);
  try {
    closeSync(openSync(file, "wx", 0o600));
    let answer: RelayAnswer;
    try { answer = await relay(probe.port, { action: "screenshot", path: file, format: "jpeg", quality: FRAME_JPEG_QUALITY }, { timeoutMs: FRAME_TIMEOUT_MS, maxBytes: 65_536 }); }
    catch (error) {
      if (error instanceof RelayTimeout) ports.trip(target.session);
      throw new Error("the browser did not return a picture in time");
    }
    // Chrome died between the probe and the picture, and the engine started
    // it again: the bot's next call sizes it and hears its pages are gone.
    if (answer.launched) ports.noteStarted(target.session);
    if (!answer.success) throw new Error("the browser could not be pictured");
    const png = readFileSync(file).toString("base64");
    if (!png) throw new Error("the browser reported a picture it did not write");
    return { png, format: "jpeg" };
  } finally {
    rmSync(file, { force: true });
  }
}

/** One per server: where every session's relay is. */
export const relayPorts = new RelayPorts();

/** A session's browser as the relay addresses it, from the spec its MCP
 * transport runs with (BrowserRuntime's spec and session). */
export function relayTarget(spec: Pick<BrowserSpawnSpec, "command" | "env">, session: string): RelayTarget {
  return { session, binaryPath: spec.command, env: browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }) };
}

/** A preview frame of the session's browser (captureFrame): never a launch. */
export const relayFrame = (spec: Pick<BrowserSpawnSpec, "command" | "env">, session: string) => captureFrame(relayPorts, relayTarget(spec, session));
/** fill_login's typing into the focused field of the session's page (typeText). */
export const relayInsertText = (spec: Pick<BrowserSpawnSpec, "command" | "env">, session: string, text: string) => typeText(relayPorts, relayTarget(spec, session), text);
