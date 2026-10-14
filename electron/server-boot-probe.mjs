export const BOOT_PROBE_FAST_INTERVAL_MS = 25;
export const BOOT_PROBE_FAST_WINDOW_MS = 5_000;
export const BOOT_PROBE_INTERVAL_MS = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   port: number,
 *   pid: () => number | undefined,
 *   bootTimeoutMs: number,
 *   isExited?: () => boolean,
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
  now = Date.now,
  sleep = defaultSleep,
  fetchImpl = globalThis.fetch,
}) {
  const startedAt = now();
  const deadline = startedAt + bootTimeoutMs;
  for (;;) {
    if (isExited()) return { outcome: "exited" };
    const remainingMs = Math.max(0, deadline - now());
    if (remainingMs <= 0) return { outcome: "timeout" };

    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch {
      const intervalMs =
        now() - startedAt < BOOT_PROBE_FAST_WINDOW_MS ? BOOT_PROBE_FAST_INTERVAL_MS : BOOT_PROBE_INTERVAL_MS;
      await sleep(Math.min(intervalMs, Math.max(1, deadline - now())));
      continue;
    }
    const body = await res.json().catch(() => null);
    // Past the deadline a null body is a timeout, not another process answering.
    if (now() >= deadline) return { outcome: "timeout" };
    // Read now: Electron's utilityProcess sets proc.pid only on the async `spawn` event, so undefined is not our child.
    const expectedPid = pid();
    const identified =
      res.ok &&
      expectedPid !== undefined &&
      body?.app === "openmausbot" &&
      body.pid === expectedPid &&
      body.static;
    if (!identified) return { outcome: "foreign-owner" };
    if (now() >= deadline) return { outcome: "timeout" };
    return { outcome: "ready", latencyMs: now() - startedAt };
  }
}
