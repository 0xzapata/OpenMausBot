import { expect, it, vi } from "vitest";
import { linkPcFolder } from "./link-pc-folder";

it("saves the Cloud copy of the folder the person picked", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  expect(await linkPcFolder({ linkFolder: vi.fn().mockResolvedValue({ cloudPath: "/data/Synced/Ash-PC/PA" }) }, save)).toBeNull();
  expect(save).toHaveBeenCalledWith("/data/Synced/Ash-PC/PA");
});

it("does nothing when the picker is cancelled, and answers why linking failed", async () => {
  const save = vi.fn();
  expect(await linkPcFolder({ linkFolder: vi.fn().mockResolvedValue(null) }, save)).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(await linkPcFolder({ linkFolder: vi.fn().mockRejectedValue(new Error("Turn on Sync with My Cloud first.")) }, save)).toBe("Turn on Sync with My Cloud first.");
});
