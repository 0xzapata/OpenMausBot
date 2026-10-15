import { expect, it, vi } from "vitest";
import { syncAfterMove } from "./cloud-move-sync";

it("turns sync on once, when a wanted move to My Cloud finishes", () => {
  expect(syncAfterMove("restoring", "done", "cloud", true)).toBe(true);
  expect(syncAfterMove("done", "done", "cloud", true)).toBe(false);
  expect(syncAfterMove("restoring", "done", "cloud", false)).toBe(false);
  expect(syncAfterMove("restoring", "done", "server", true)).toBe(false);
  expect(syncAfterMove("uploading", "failed", "cloud", true)).toBe(false);
});

it("turns sync on once per finished move, and not when the person unticked it", async () => {
  const { noteMovePhase, noteMoveStart, setKeepFoldersInSync } = await import("./cloud-move-sync");
  const turnOn = vi.fn();
  noteMoveStart();
  noteMovePhase("uploading", "cloud", turnOn);
  noteMovePhase("done", "cloud", turnOn);
  noteMovePhase("done", "cloud", turnOn);
  expect(turnOn).toHaveBeenCalledTimes(1);
  setKeepFoldersInSync(false);
  noteMoveStart();
  noteMovePhase("uploading", "cloud", turnOn);
  noteMovePhase("done", "cloud", turnOn);
  expect(turnOn).toHaveBeenCalledTimes(1);
  setKeepFoldersInSync(true);
});

it("acts only on a move this app saw start, with the choice made at Start", async () => {
  const { noteMovePhase, noteMoveStart, setKeepFoldersInSync } = await import("./cloud-move-sync");
  const turnOn = vi.fn();
  noteMovePhase("uploading", "cloud", turnOn);
  noteMovePhase("done", "cloud", turnOn);
  expect(turnOn).not.toHaveBeenCalled();
  setKeepFoldersInSync(true);
  noteMoveStart();
  noteMovePhase("uploading", "cloud", turnOn);
  noteMovePhase("done", "cloud", turnOn);
  expect(turnOn).toHaveBeenCalledTimes(1);
  noteMovePhase("uploading", "cloud", turnOn);
  noteMovePhase("done", "cloud", turnOn);
  expect(turnOn).toHaveBeenCalledTimes(1);
});
