import { describe, expect, it } from "vitest";

import { appArmorProfile, BrowserHostError, diagnoseLaunchFailure, sandboxBlocked, sandboxDisabled, USERNS_RESTRICTION } from "./host-setup.ts";

describe("host setup", () => {
  it("pins the AppArmor exemption to one root-owned executable", () => {
    const profile = appArmorProfile("/opt/OpenMausBot/resources/chrome/chrome");
    expect(profile).toContain("profile openmausbot-chrome /opt/OpenMausBot/resources/chrome/chrome flags=(unconfined)");
    expect(profile).toContain("userns,");
    for (const path of ["/opt/**/chrome", "/home/a/chrome", "relative/chrome", "/opt/a b/chrome"]) expect(() => appArmorProfile(path)).toThrow();
  });

  it("names the sandbox when Chrome says it has none, and never turns it off by itself", async () => {
    const diagnosis = await diagnoseLaunchFailure({ executable: "/opt/chrome", output: "[0101/000000.000:FATAL:zygote_host_impl_linux.cc] No usable sandbox! ...", platform: "darwin" });
    expect(diagnosis).toBeInstanceOf(BrowserHostError);
    expect(diagnosis?.kind).toBe("sandbox");
    expect(diagnosis?.message).toMatch(/openmausbot browser setup/);
    expect(await diagnoseLaunchFailure({ executable: "/opt/chrome", output: "something else", platform: "darwin" })).toBeNull();
    expect(sandboxDisabled({})).toBe(false);
    expect(sandboxDisabled({ OMB_BROWSER_SANDBOX: "0" })).toBe(true);
  });

  it("sees a blocked sandbox only where user namespaces are restricted and no profile is installed", () => {
    const read = (path: string) => (path === USERNS_RESTRICTION ? "1\n" : "");
    expect(sandboxBlocked({ platform: "linux", read, exists: () => false })).toBe(true);
    expect(sandboxBlocked({ platform: "linux", read, exists: () => true })).toBe(false);
    expect(sandboxBlocked({ platform: "linux", read: () => "0", exists: () => false })).toBe(false);
    expect(sandboxBlocked({ platform: "darwin", read, exists: () => false })).toBe(false);
  });
});
