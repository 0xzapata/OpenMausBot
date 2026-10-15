import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { chromeArgs, chromeEnv, screenInfo, SERVER_SCREEN } from "./flags.ts";
import { appArmorProfile, BrowserHostError, diagnoseLaunchFailure, sandboxBlocked, sandboxDisabled, USERNS_RESTRICTION } from "./host-setup.ts";
import { ProcessRegistry, staleSingletonLock, strays, sweep, userDataDirOf, type ListedProcess } from "./processes.ts";
import { browserRoot, compareVersions, downgradeRefusal, ensureProfile, markCleanExit, profileDir, profileHash, recordOpenedBy, versionOf, workspaceId } from "./profile.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-chrome-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

describe("Chrome's command line", () => {
  const headless = chromeArgs({ userDataDir: "/data/browser/profiles/abc", mode: "headless", host: "desktop", platform: "darwin", userAgent: UA, screen: { width: 1512, height: 982, deviceScaleFactor: 2, colorDepth: 30 }, locale: "en-GB" });

  it("talks over the pipe and never opens a DevTools port or announces automation", () => {
    expect(headless[0]).toBe("--remote-debugging-pipe");
    expect(headless).toContain("--disable-blink-features=AutomationControlled");
    for (const never of ["--enable-automation", "--no-sandbox", "--hide-scrollbars", "--disable-gpu", "--disable-extensions", "--disable-popup-blocking", "--disable-background-networking", "--disable-renderer-backgrounding"]) {
      expect(headless).not.toContain(never);
    }
    expect(headless.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
  });

  it("keeps the whole user agent, commas included, as one argument", () => {
    expect(headless).toContain(`--user-agent=${UA}`);
    expect(() => chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", userAgent: "x\ny" })).toThrow(/line break/);
  });

  it("gives headless the real display in device pixels, and a window nothing headless-only", () => {
    expect(headless).toContain("--screen-info={3024x1964 devicePixelRatio=2 colorDepth=30}");
    expect(headless).toContain("--headless=new");
    expect(headless).toContain("--mute-audio");
    const window = chromeArgs({ userDataDir: "/p", mode: "window", host: "desktop", platform: "darwin", userAgent: UA });
    expect(window.some((arg) => /^--(headless|user-agent|screen-info|mute-audio)/.test(arg))).toBe(false);
    expect(window).toContain("--window-size=1280,863");
  });

  it("declares a 1920x1080 screen on servers and keeps containers off /dev/shm", () => {
    const server = chromeArgs({ userDataDir: "/p", mode: "headless", host: "container", platform: "linux" });
    expect(server).toContain(`--screen-info=${screenInfo(SERVER_SCREEN)}`);
    expect(screenInfo(SERVER_SCREEN)).toBe("{1920x1080 devicePixelRatio=1}");
    expect(server).toEqual(expect.arrayContaining(["--disable-dev-shm-usage", "--disk-cache-size=52428800", "--password-store=basic"]));
    expect(server).not.toContain("--use-mock-keychain");
  });

  it("goes only through OMB's own local gate, with WebRTC kept on it", () => {
    const gated = chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", proxyServer: "socks5://127.0.0.1:41234" });
    expect(gated).toEqual(expect.arrayContaining(["--proxy-server=socks5://127.0.0.1:41234", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]));
    expect(() => chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", proxyServer: "http://proxy.example:8080" })).toThrow(/local gate/);
  });

  it("turns the sandbox off only on an explicit opt-out, and reopens restored tabs without a start page", () => {
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "container", sandbox: false })).toContain("--no-sandbox");
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop" }).at(-1)).toBe("about:blank");
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", startUrl: null }).at(-1)).not.toBe("about:blank");
    expect(chromeArgs({ userDataDir: "/p", mode: "headless", host: "desktop", locale: "en-GB; rm -rf" })).not.toContain("--lang=en-GB; rm -rf");
  });

  it("sets the time zone on servers only, and marks the process for the sweep", () => {
    expect(chromeEnv({ PATH: "/bin" }, { host: "server", timezone: "Asia/Kolkata", profileMarker: "abc" })).toMatchObject({ PATH: "/bin", TZ: "Asia/Kolkata", OMB_BROWSER_PROFILE: "abc" });
    expect(chromeEnv({}, { host: "desktop", timezone: "Asia/Kolkata" }).TZ).toBeUndefined();
  });
});

describe("profiles", () => {
  it("gives each workspace its own random id and each key its own folder", () => {
    const data = scratch();
    const id = workspaceId(data);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(workspaceId(data)).toBe(id);
    expect(workspaceId(scratch())).not.toBe(id);
    expect(profileHash(id, "bot:alice")).toHaveLength(24);
    expect(profileHash(id, "bot:alice")).not.toBe(profileHash(id, "bot:bob"));
    expect(profileDir(data, "bot:alice")).toBe(join(browserRoot(data), "profiles", profileHash(id, "bot:alice")));
    expect(profileDir(data, "temp:alice:run1")).toContain(join("browser", "temp"));
    expect(() => profileDir(data, "nonsense")).toThrow(/profile key/);
  });

  it("writes the quiet preferences once, at creation", () => {
    const data = scratch();
    const made = ensureProfile(data, "bot:alice", { acceptLanguages: "en-IN,en", now: () => new Date("2026-10-15T00:00:00Z") });
    expect(made.created).toBe(true);
    const preferences = JSON.parse(readFileSync(join(made.dir, "Default", "Preferences"), "utf8"));
    expect(preferences).toMatchObject({
      session: { restore_on_startup: 1 },
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
      autofill: { profile_enabled: false, credit_card_enabled: false },
      signin: { allowed: false },
      translate: { enabled: false },
      intl: { accept_languages: "en-IN,en" },
    });
    expect(made.record).toMatchObject({ key: "bot:alice", backend: "local", egress: "direct", chromeVersion: null, createdAt: "2026-10-15T00:00:00.000Z" });
    writeFileSync(join(made.dir, "Default", "Preferences"), JSON.stringify({ ...preferences, profile: { ...preferences.profile, exit_type: "Crashed" }, extra: 1 }));
    expect(ensureProfile(data, "bot:alice").created).toBe(false);
    markCleanExit(made.dir);
    const after = JSON.parse(readFileSync(join(made.dir, "Default", "Preferences"), "utf8"));
    expect(after).toMatchObject({ extra: 1, profile: { exit_type: "Normal", exited_cleanly: true, password_manager_enabled: false } });
  });

  it("refuses to let an older Chrome open a profile a newer one wrote", () => {
    const data = scratch();
    const { dir, record } = ensureProfile(data, "bot:alice");
    expect(downgradeRefusal(record, "150.0.1.2")).toBeNull();
    recordOpenedBy(dir, "153.0.8010.12");
    recordOpenedBy(dir, "152.0.1.1");
    const opened = ensureProfile(data, "bot:alice").record;
    expect(opened.chromeVersion).toBe("153.0.8010.12");
    expect(downgradeRefusal(opened, "153.0.8010.12")).toBeNull();
    expect(downgradeRefusal(opened, "153.0.8010.9")).toMatch(/older/);
    expect(compareVersions("153.0.10.0", "153.0.9.9")).toBe(1);
    expect(versionOf("Chrome/153.0.8010.12")).toBe("153.0.8010.12");
  });
});

const chrome = (pid: number, dir: string, extra = ""): ListedProcess => ({ pid, ppid: 1, startTime: "t", args: `/opt/chrome/chrome --remote-debugging-pipe --user-data-dir=${dir} --headless=new${extra} about:blank` });

describe("the process sweep", () => {
  it("reads --user-data-dir with spaces, quotes or exact arguments", () => {
    expect(userDataDirOf({ args: "/Apps/Chrome --user-data-dir=/Users/a/Library/Application Support/OMB/browser/profiles/x --no-first-run" })).toBe("/Users/a/Library/Application Support/OMB/browser/profiles/x");
    expect(userDataDirOf({ args: '"C:\\Chrome\\chrome.exe" "--user-data-dir=C:\\Users\\a b\\browser\\p" --headless=new' })).toBe("C:\\Users\\a b\\browser\\p");
    expect(userDataDirOf({ args: "x", argv: ["chrome", "--user-data-dir=/a b/--c"] })).toBe("/a b/--c");
    expect(userDataDirOf({ args: "/usr/bin/node server.js" })).toBeNull();
  });

  it("kills browsers on OMB's profiles that no live server registered, and nothing else", () => {
    const root = "/data/browser";
    const processes = [
      chrome(10, "/data/browser/profiles/a"),
      chrome(11, "/data/browser/profiles/b"),
      chrome(12, "/data/browser/profiles/c"),
      chrome(13, "/data/browser/profiles/a", " --type=renderer"),
      chrome(14, "/home/person/.config/google-chrome"),
      chrome(15, "/data/browser-other/profiles/z"),
      { ...chrome(16, "/data/browser/temp/d"), startTime: "later" },
    ];
    const registered = [
      { pid: 10, startTime: "t", userDataDir: "/data/browser/profiles/a", ownerPid: 500, launchedAt: "" },
      { pid: 11, startTime: "t", userDataDir: "/data/browser/profiles/b", ownerPid: 501, launchedAt: "" },
      { pid: 16, startTime: "t", userDataDir: "/data/browser/temp/d", ownerPid: 500, launchedAt: "" },
    ];
    const alive = (pid: number) => pid === 500;
    expect(strays({ processes, registered, root, alive }).map((listed) => listed.pid)).toEqual([11, 12, 16]);
  });

  it("clears a stale lock, deletes unused temporary profiles and forgets processes that are gone", async () => {
    const root = scratch();
    const busy = join(root, "profiles", "busy");
    const stale = join(root, "profiles", "stale");
    const temporary = join(root, "temp", "old");
    for (const dir of [busy, stale, temporary]) mkdirSync(dir, { recursive: true });
    const posix = process.platform !== "win32";
    if (posix) {
      symlinkSync(`${hostname()}-999999`, join(stale, "SingletonLock"));
      symlinkSync(`${hostname()}-${process.pid}`, join(busy, "SingletonLock"));
    }
    const registry = new ProcessRegistry(root);
    registry.add({ pid: 999998, startTime: null, userDataDir: busy, ownerPid: process.pid, launchedAt: "" });
    const killed: number[] = [];
    const report = await sweep({
      root,
      registry,
      list: async () => [chrome(4242, stale)],
      kill: async (pid) => { killed.push(pid); },
      alive: (pid) => pid === process.pid,
    });
    expect(killed).toEqual([4242]);
    expect(report.temporaryRemoved).toEqual([temporary]);
    expect(existsSync(temporary)).toBe(false);
    expect(registry.list()).toEqual([]);
    if (posix) {
      expect(report.locksCleared).toEqual([stale]);
      expect(staleSingletonLock(busy)).toBe(false);
      expect(lstatSync(join(busy, "SingletonLock"), { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
      expect(lstatSync(join(stale, "SingletonLock"), { throwIfNoEntry: false })).toBeUndefined();
    }
  });
});

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
