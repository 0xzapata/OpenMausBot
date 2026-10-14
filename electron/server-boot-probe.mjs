export const BOOT_PROBE_FAST_INTERVAL_MS = 25;
export const BOOT_PROBE_FAST_WINDOW_MS = 5_000;
export const BOOT_PROBE_INTERVAL_MS = 500;

const LISTENING_LINE = "openmausbot server on ";

/** A stdout reader that turns true once the child has said it is listening,
 * even when that line arrives split across two chunks. */
export function listeningSignal() {
  let tail = "";
  return (chunk) => {
    const text = tail + chunk;
    tail = text.slice(-LISTENING_LINE.length);
    return text.includes(LISTENING_LINE);
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   port: number,
 *   pid: () => number | undefined,
 *   bootTimeoutMs: number,
 *   isExited?: () => boolean,
 *   isListening?: () => boolean,
 *   listeningGraceMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ outcome: "ready" | "foreign-owner" | "timeout" | "exited" }>}
*/
export async function pollServerIdentity({
  port,
  pid,
  bootTimeoutMs,
  isExited = () => false,
  isListening = () => false,
  listeningGraceMs = 0,
  now = Date.now,
  sleep = defaultSleep,
  fetchImpl = globalThis.fetch,
}) {
  const startedAt = now();
  // Read fresh at every check: the child can say it is listening while a
  // probe is in flight, and the answer it then gives must get the grace.
  const deadline = () => startedAt + bootTimeoutMs + (isListening() ? listeningGraceMs : 0);
  for (;;) {
    if (isExited()) return { outcome: "exited" };
    const remainingMs = Math.max(0, deadline() - now());
    if (remainingMs <= 0) return { outcome: "timeout" };

    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch {
      const intervalMs =
        now() - startedAt < BOOT_PROBE_FAST_WINDOW_MS ? BOOT_PROBE_FAST_INTERVAL_MS : BOOT_PROBE_INTERVAL_MS;
      await sleep(Math.min(intervalMs, Math.max(1, deadline() - now())));
      continue;
    }
    const body = await res.json().catch(() => null);
    // Past the deadline a null body is a timeout, not another process answering.
    if (now() >= deadline()) return { outcome: "timeout" };
    // Read now: Electron's utilityProcess sets proc.pid only on the async `spawn` event, so undefined is not our child.
    const expectedPid = pid();
    const identified =
      res.ok &&
      expectedPid !== undefined &&
      body?.app === "openmausbot" &&
      body.pid === expectedPid &&
      body.static;
    if (!identified) return { outcome: "foreign-owner" };
    if (now() >= deadline()) return { outcome: "timeout" };
    return { outcome: "ready", latencyMs: now() - startedAt };
  }
}
