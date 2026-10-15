// @vitest-environment happy-dom
// The USB hook separates "a check finished" from "a check answered": `scanned`
// latches on failure too, and only the status' own reasonCode tells a real
// empty list apart from an adb failure. The panel's persistence gate reads
// both, so this file locks that contract.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAndroidUsbDevices, type AndroidUsbDevicesStatus } from "./AndroidDevicePanel";

vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));

let root: Root | null = null;
let latest: AndroidUsbDevicesStatus;

function Probe() {
  latest = useAndroidUsbDevices();
  return null;
}

/** Mounts the hook and flushes its initial async refresh. */
async function draw() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function bridge(status: () => Promise<unknown>) {
  vi.stubGlobal("ogb", {
    androidDevice: {
      status,
      frame: async () => ({ serial: "", dataUrl: "" }),
      input: async () => {},
    },
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("useAndroidUsbDevices", () => {
  it("leaves the first check unscanned until it resolves", async () => {
    bridge(() => new Promise(() => {}));
    await draw();
    expect(latest).toMatchObject({ scanned: false, devices: [] });
    expect(latest.reasonCode).toBeUndefined();
  });

  it("treats a missing bridge as a final, empty answer", async () => {
    vi.stubGlobal("ogb", undefined);
    await draw();
    expect(latest).toMatchObject({ scanned: true, devices: [] });
    expect(latest.reasonCode).toBeUndefined();
  });

  it("marks a failed check scanned but keeps the failure reason", async () => {
    bridge(async () => {
      throw new Error("adb exited 1");
    });
    await draw();
    expect(latest).toMatchObject({ scanned: true, devices: [], reasonCode: "adb-failed" });
  });

  it("passes a native adb-unavailable result through with its reason", async () => {
    bridge(async () => ({ available: false, reasonCode: "adb-unavailable", devices: [] }));
    await draw();
    expect(latest).toMatchObject({ scanned: true, devices: [], reasonCode: "adb-unavailable" });
  });

  it("confirms a successful check, devices or none", async () => {
    bridge(async () => ({ available: true, devices: [{ serial: "p1", state: "device", connection: "usb", model: "Pixel" }] }));
    await draw();
    expect(latest.scanned).toBe(true);
    expect(latest.reasonCode).toBeUndefined();
    expect(latest.devices.map((device) => device.serial)).toEqual(["p1"]);
  });
});
