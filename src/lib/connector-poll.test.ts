import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatus } from "./connector-status";
import { CONNECTOR_POLL_MS, CONNECTOR_POLL_TRIES, pollConnector } from "./connector-poll";

type Pending = { resolve: (state: ConnectorStatus | undefined) => void };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("polling one app after Connect", () => {
  it("ends once even when two slow reads both come back connected", async () => {
    const reads: Pending[] = [];
    const onEnd = vi.fn();
    pollConnector(() => new Promise((resolve) => reads.push({ resolve })), onEnd);
    await vi.advanceTimersByTimeAsync(2 * CONNECTOR_POLL_MS);
    expect(reads).toHaveLength(2);
    reads[0]!.resolve({ connected: true, pending: false, status: "ACTIVE" });
    reads[1]!.resolve({ connected: true, pending: false, status: "ACTIVE" });
    await vi.advanceTimersByTimeAsync(10 * CONNECTOR_POLL_MS);
    expect(onEnd.mock.calls).toEqual([["connected"]]);
    expect(reads).toHaveLength(2);
  });

  it("gives up after two minutes of pending reads, and says so once", async () => {
    const read = vi.fn(async (): Promise<ConnectorStatus> => ({ connected: false, pending: true, status: "INITIATED" }));
    const onEnd = vi.fn();
    pollConnector(read, onEnd);
    await vi.advanceTimersByTimeAsync((CONNECTOR_POLL_TRIES - 1) * CONNECTOR_POLL_MS);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS);
    expect(onEnd.mock.calls).toEqual([["timed_out"]]);
    await vi.advanceTimersByTimeAsync(10 * CONNECTOR_POLL_MS);
    expect(read).toHaveBeenCalledTimes(CONNECTOR_POLL_TRIES);
    expect(CONNECTOR_POLL_TRIES * CONNECTOR_POLL_MS).toBe(120_000);
  });

  it.each([["FAILED", "failed"], ["EXPIRED", "expired"]])("reports a %s account as %s", async (status, result) => {
    const onEnd = vi.fn();
    pollConnector(async () => ({ connected: false, status }), onEnd);
    await vi.advanceTimersByTimeAsync(3 * CONNECTOR_POLL_MS);
    expect(onEnd.mock.calls).toEqual([[result]]);
  });

  it("says nothing once stopped, even for a read already on its way (the panel closed, or Connect began again)", async () => {
    const reads: Pending[] = [];
    const onEnd = vi.fn();
    const stop = pollConnector(() => new Promise((resolve) => reads.push({ resolve })), onEnd);
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_MS);
    stop();
    reads[0]!.resolve({ connected: true, pending: false });
    await vi.advanceTimersByTimeAsync(10 * CONNECTOR_POLL_MS);
    expect(onEnd).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1);
  });
});
