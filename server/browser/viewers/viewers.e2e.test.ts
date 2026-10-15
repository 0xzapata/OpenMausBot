// People's views of a bot's browser on real Chrome: the page fills the panel at the screen's real scale, frames wait
// for acknowledgements, and a phone's v1 session matches the golden recorded on agent-browser.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostTimeout } from "../../testing/host-timeout.ts";
import { FixtureServer } from "../cdp/testing/fixtures.ts";
import { CHROME } from "../cdp/testing/real-chrome.ts";
import type { BrowserTarget } from "../service.ts";
import { jpegSize, startService, until, type RealService } from "../testing/real-service.ts";
import type { Viewer, ViewerOptions, ViewerOutput } from "./core.ts";
import { LiveV1 } from "./live-v1.ts";
import { v1Differences } from "./testing/v1-compare.ts";
import { normalizeV1, runV1Session, startV1Pages } from "./testing/v1-session.ts";

const suite = CHROME ? describe : describe.skip;

/** A page that keeps painting, so a screencast keeps sending frames. */
const ANIMATED = `<!doctype html><title>animated</title><style>@keyframes spin{to{transform:rotate(360deg)}}#s{width:60px;height:60px;background:#36c;animation:spin 1s linear infinite}</style><div id="s"></div><div style="height:4000px"></div>`;

interface Seen { width: number; height: number; still: boolean; at: number }

suite("viewers of the new browser on real Chrome", () => {
  let fx: FixtureServer;
  let real: RealService;
  let page: string;
  let sessions = 0;

  beforeAll(async () => {
    fx = await FixtureServer.start();
    page = fx.page("/animated", ANIMATED);
    real = await startService({ screen: { width: 1512, height: 982, deviceScaleFactor: 2 } });
  }, hostTimeout(240_000));

  afterAll(async () => {
    await real?.close();
    await fx?.close();
  });

  async function opened(): Promise<BrowserTarget> {
    const target = { session: `viewers-${++sessions}`, key: `bot:viewers-${sessions}` };
    const result = await real.call(target, "agent_browser_open", { url: page });
    expect(result.isError).toBeUndefined();
    return target;
  }

  async function watch(target: BrowserTarget, options: Partial<ViewerOptions>, { ack = true } = {}): Promise<{ viewer: Viewer; frames: Seen[]; outputs: ViewerOutput[] }> {
    const frames: Seen[] = [];
    const outputs: ViewerOutput[] = [];
    const viewer = await real.service.attachViewer(target, { owner: "local-owner", canOperate: true, maxWidth: 3200, maxHeight: 2000, ...options }, (output) => {
      if (output.type !== "frame") {
        outputs.push(output);
        return;
      }
      frames.push({ ...jpegSize(output.data), still: output.still, at: Date.now() });
      if (ack) output.ack();
    });
    return { viewer, frames, outputs };
  }

  const pageSize = (target: BrowserTarget) => real.peek<[number, number, number]>(target, "[innerWidth, innerHeight, devicePixelRatio]");
  const same = (expected: unknown[]) => (actual: unknown[]) => JSON.stringify(actual) === JSON.stringify(expected);

  it("fills the panel: the page takes the viewer's size, frames come at the screen's scale, and 1280x800 returns when it leaves", async () => {
    const target = await opened();
    expect(await pageSize(target)).toEqual([1280, 800, 2]);
    const { viewer, frames } = await watch(target, { size: { width: 1600, height: 1000 } });
    await until(() => pageSize(target), same([1600, 1000, 2]));
    await until(() => frames.at(-1), (frame) => frame?.width === 3200 && frame.height === 2000);
    await viewer.input({ type: "resize", width: 1200, height: 900 });
    await until(() => pageSize(target), same([1200, 900, 2]));
    await until(() => frames.at(-1), (frame) => frame?.width === 2400 && frame.height === 1800);
    await viewer.close();
    await until(() => pageSize(target), same([1280, 800, 2]));
  }, hostTimeout(90_000));

  it("follows the viewer that asked last, and a preset narrower than any window is emulated", async () => {
    const target = await opened();
    const first = await watch(target, { size: { width: 1000, height: 700 } });
    const second = await watch(target, { size: { width: 1400, height: 900 } });
    await until(() => pageSize(target), same([1400, 900, 2]));
    await first.viewer.input({ type: "resize", width: 900, height: 600 });
    await until(() => pageSize(target), same([900, 600, 2]));
    await second.viewer.input({ type: "takeControl" });
    await second.viewer.input({ type: "viewport", setting: { mode: "preset", preset: "phone" } });
    await until(() => pageSize(target), same([390, 844, 2]));
    await second.viewer.input({ type: "viewport", setting: { mode: "fill" } });
    await until(() => pageSize(target), same([900, 600, 2]));
    await second.viewer.input({ type: "releaseControl" });
    await first.viewer.close();
    await second.viewer.close();
  }, hostTimeout(90_000));

  it("sends no more frames until the viewer acknowledges the ones it has", async () => {
    const target = await opened();
    const unacked = await watch(target, { size: { width: 1280, height: 800 } }, { ack: false });
    await until(() => unacked.frames.length, (count) => count > 0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const stalled = unacked.frames.filter((frame) => !frame.still).length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(unacked.frames.filter((frame) => !frame.still)).toHaveLength(stalled);
    expect(stalled).toBeLessThanOrEqual(3);
    await unacked.viewer.close();
    const acked = await watch(target, { size: { width: 1280, height: 800 } });
    await until(() => acked.frames.filter((frame) => !frame.still).length, (count) => count > stalled + 3, 20_000);
    await acked.viewer.close();
  }, hostTimeout(90_000));

  it("ends a scroll on a sharp frame at full size", async () => {
    const target = await opened();
    const { viewer, frames } = await watch(target, { size: { width: 1280, height: 800 }, maxWidth: 2560, maxHeight: 1600 });
    await until(() => frames.at(-1), (frame) => frame?.width === 2560);
    await viewer.input({ type: "takeControl" });
    for (let step = 0; step < 12; step++) {
      await viewer.input({ type: "wheel", x: 400, y: 400, deltaX: 0, deltaY: 120 });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const settled = Date.now() + 400;
    await until(() => frames.at(-1), (frame) => frame !== undefined && frame.at > settled && frame.width === 2560 && frame.height === 1600);
    for (const frame of frames) expect([1280, 2560]).toContain(frame.width);
    expect(await real.peek<number>(target, "scrollY")).toBeGreaterThan(0);
    await viewer.input({ type: "releaseControl" });
    await viewer.close();
  }, hostTimeout(90_000));
});

suite("a phone's v1 live view on real Chrome", () => {
  it("sends the events and fields the agent-browser engine sent, step for step", async () => {
    const pages = await startV1Pages();
    const real = await startService({ screen: { width: 1512, height: 982, deviceScaleFactor: 2 } });
    const target = { session: "bot-golden", key: "bot:golden" };
    const live = new LiveV1({ service: real.service, target: () => target });
    try {
      const records = await runV1Session({
        open: (res) => live.open({ botId: "bot", session: target.session, owner: "local-owner", isCurrent: () => true, res }),
        action: (viewerId, body) => live.action({ viewerId, botId: "bot", owner: "local-owner", body }),
      }, pages.origin);
      expect(v1Differences(normalizeV1(records, pages.origin))).toEqual([]);
    } finally {
      live.closeAll();
      await real.close();
      await pages.close();
    }
  }, hostTimeout(180_000));
});
