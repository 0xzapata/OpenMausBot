import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { modelIds, OtherOpenAiCompatServers } from "./OpenAiCompatServers";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const instance = (instanceId: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  instanceId, driverKind: "openai-compat", displayName,
  snapshot: { state: "available" }, models: { default: "m", options: [] }, ...extra,
}) as unknown as store.InstanceInfo;

function render(instances: store.InstanceInfo[]) {
  vi.stubGlobal("window", {});
  vi.spyOn(store, "useStore").mockReturnValue({
    state: { ...store.initialState, instances },
    dispatch: vi.fn(),
    flushBotPatches: vi.fn(),
    refreshInstances: vi.fn(),
    refreshModels: vi.fn(),
  });
  return renderToStaticMarkup(createElement(OtherOpenAiCompatServers));
}

describe("other OpenAI-compatible servers", () => {
  it("lists only servers added here, by name and base URL, and opens when there are any", () => {
    const html = render([
      instance("openaiCompat", "Other (OpenAI-compatible)"),
      instance("openai", "OpenAI", { url: "https://api.openai.com/v1" }),
      instance("openai-compat-1", "Zhipu", { url: "https://open.bigmodel.cn/api/paas/v4" }),
    ]);
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).toContain("Zhipu");
    expect(html).toContain("https://open.bigmodel.cn/api/paas/v4");
    expect(html).toContain('aria-label="Remove Zhipu"');
    expect(html).not.toContain("api.openai.com");
    expect(html).not.toContain('aria-label="Remove OpenAI"');
  });

  it("stays closed and says so when none are added", () => {
    const html = render([instance("openaiCompat", "Other (OpenAI-compatible)")]);
    expect(html).not.toMatch(/<details[^>]*open=""/);
    expect(html).toContain("No other servers yet.");
  });

  it("reads model IDs separated by commas, CJK commas or spaces", () => {
    expect(modelIds("glm-4.6, glm-5，glm-4.6、qwen3 ")).toEqual(["glm-4.6", "glm-5", "qwen3"]);
    expect(modelIds("  ")).toEqual([]);
  });
});
