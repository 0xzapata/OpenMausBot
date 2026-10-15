import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { calibrateIdentity, headedIdentity, isChromeIdentity } from "./identity.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

/** As Chrome for Testing 153 reports itself headless on an Apple silicon Mac (measured). */
const HEADLESS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36";
const HINTS = {
  architecture: "arm", bitness: "64",
  brands: [{ brand: "Chromium", version: "153" }, { brand: "Not_A Brand", version: "8" }],
  formFactors: ["Desktop"],
  fullVersionList: [{ brand: "Chromium", version: "153.0.8010.47" }, { brand: "Not_A Brand", version: "8.0.0.0" }],
  mobile: false, model: "", platform: "macOS", platformVersion: "26.3.1", uaFullVersion: "153.0.8010.47", wow64: false,
};

describe("the identity a headless Chrome is given", () => {
  it("is what the same binary reports headed: only the HeadlessChrome token changes, byte for byte", () => {
    const identity = headedIdentity({ userAgent: HEADLESS_UA, hints: HINTS });
    expect(identity.userAgent).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36");
    expect(identity.userAgentMetadata).toEqual({
      brands: HINTS.brands, fullVersionList: HINTS.fullVersionList, fullVersion: "153.0.8010.47", platform: "macOS",
      platformVersion: "26.3.1", architecture: "arm", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
    });
  });

  it("keeps Google Chrome's own brand when the binary is Google Chrome, and invents none for Chrome for Testing", () => {
    const brands = [{ brand: "Google Chrome", version: "155" }, { brand: "Not.A/Brand", version: "99" }, { brand: "Chromium", version: "155" }];
    const chrome = headedIdentity({ userAgent: HEADLESS_UA.replace("153", "155"), hints: { ...HINTS, brands, fullVersionList: brands, uaFullVersion: "155.0.8059.80" } });
    expect(chrome.userAgentMetadata.brands).toEqual(brands);
    expect(headedIdentity({ userAgent: HEADLESS_UA, hints: HINTS }).userAgentMetadata.brands.map(({ brand }) => brand)).not.toContain("Google Chrome");
  });

  it("refuses the headless shell, which reports a full version and a HeadlessChrome brand", () => {
    expect(() => headedIdentity({ userAgent: HEADLESS_UA.replace("153.0.0.0", "153.0.8010.47"), hints: HINTS })).toThrow(/not Chrome's/);
    const shellBrands = [{ brand: "HeadlessChrome", version: "153" }, { brand: "Not_A Brand", version: "8" }, { brand: "Chromium", version: "153" }];
    expect(() => headedIdentity({ userAgent: HEADLESS_UA, hints: { ...HINTS, brands: shellBrands } })).toThrow(/headless brand/);
  });

  it("refuses a read without client hints, which a page outside a secure context gets", () => {
    expect(() => headedIdentity({ userAgent: HEADLESS_UA, hints: null })).toThrow(/no brands/);
    expect(() => headedIdentity({ userAgent: HEADLESS_UA, hints: { ...HINTS, platformVersion: undefined } })).toThrow(/platform version/);
    expect(() => headedIdentity({ userAgent: undefined, hints: HINTS })).toThrow(/user agent/);
  });

  it("trusts a saved identity only when it is one this code would have made", () => {
    const identity = headedIdentity({ userAgent: HEADLESS_UA, hints: HINTS });
    expect(isChromeIdentity(identity)).toBe(true);
    expect(isChromeIdentity(JSON.parse(JSON.stringify(identity)))).toBe(true);
    expect(isChromeIdentity({ ...identity, userAgent: HEADLESS_UA })).toBe(false);
    expect(isChromeIdentity({ ...identity, extra: "x" })).toBe(false);
    expect(isChromeIdentity({ userAgent: identity.userAgent })).toBe(false);
    expect(isChromeIdentity(null)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("starts the binary with the environment it is given, off the keychain, and says when it exits", async () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-calibrate-"));
    folders.push(folder);
    const chrome = join(folder, "chrome");
    writeFileSync(chrome, `#!/bin/sh\nprintf '%s' "$HOME" > '${folder}/home'\nprintf '%s\\n' "$@" > '${folder}/args'\nexit 3\n`, { mode: 0o755 });
    await expect(calibrateIdentity(chrome, { env: { PATH: "/usr/bin:/bin", HOME: "/Users/ada" }, timeoutMs: 10_000 })).rejects.toThrow(/exited/);
    expect(readFileSync(join(folder, "home"), "utf8")).toBe("/Users/ada");
    const args = readFileSync(join(folder, "args"), "utf8").split("\n");
    expect(args).toContain("--headless=new");
    expect(args).toContain(process.platform === "darwin" ? "--use-mock-keychain" : "--password-store=basic");
    // DevTools over a pipe: no port that a bot's page browsing at the same time could reach.
    expect(args).toContain("--remote-debugging-pipe");
    expect(args.filter((arg) => arg.startsWith("--remote-debugging-port"))).toEqual([]);
  });
});
