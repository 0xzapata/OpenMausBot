import type { ConnectorResult } from "@/lib/analytics-allowlist";
import type { ConnectorStatus } from "@/lib/connector-status";

export const CONNECTOR_POLL_MS = 5_000;
export const CONNECTOR_POLL_TRIES = 24;

export function connectorPollEnd(state: ConnectorStatus | undefined, tries: number): ConnectorResult | null {
  if (state?.connected && !state.pending) return "connected";
  const status = state?.status?.toLowerCase();
  if (status === "expired" || status === "failed") return status;
  return tries >= CONNECTOR_POLL_TRIES ? "timed_out" : null;
}

/** Polls one app after Connect until it ends; `onEnd` runs at most once, and never after `stop()`. */
export function pollConnector(
  read: () => Promise<ConnectorStatus | undefined>,
  onEnd: (result: ConnectorResult) => void,
): () => void {
  let tries = 0;
  let ended = false;
  const stop = () => {
    ended = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    void read().then((state) => {
      if (ended) return;
      const result = connectorPollEnd(state, ++tries);
      if (!result) return;
      stop();
      onEnd(result);
    });
  }, CONNECTOR_POLL_MS);
  return stop;
}
