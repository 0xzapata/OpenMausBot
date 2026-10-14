import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { createMemoryUpkeep } from "./memory-upkeep.ts";
import { writeMemoryTopic, readMemoryTopic, ensureWorkspace } from "./workspace.ts";
import { memoryPassages } from "./recall.ts";
import { TIDY_MARKER } from "./memory-tidy.ts";
beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); });
const bot = { id: "learning", name: "Editor" };

it("reconciles a correction in a two-entry project topic, retaining the old version in the file", async () => {
  ensureWorkspace(bot.id);
  writeMemoryTopic(bot.id, "tapa.md", "---\ntitle: Tapa\n---\n- 2026-10-01 · Use blue treatment\n- 2026-10-02 · Use orange treatment\n");
  const upkeep = createMemoryUpkeep({ bots: () => [bot], bot: () => bot,
    engine: () => ({ generateText: async prompt => prompt.includes(TIDY_MARKER) ? '{"pairs":[{"a":0,"b":1,"keep":"b"}]}' : '{"moves":[]}' }),
    busy: () => false, addToAboutMe: () => 0, sourceLabel: () => "fixture", quietMs: () => 60_000, tidyHour: () => 3 });
  const report = await upkeep.tidy(bot.id);
  expect(report.superseded).toBe(1);
  expect(readMemoryTopic(bot.id, "tapa.md")).toContain("~~Use blue treatment~~");
  expect(memoryPassages(bot.id, "blue treatment").some(hit => hit.snippet.includes("blue"))).toBe(false);
  expect(memoryPassages(bot.id, "orange treatment")[0]?.snippet).toContain("orange");
  upkeep.stop();
});
