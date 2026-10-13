import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runServiceCommand, serviceServeArgs } from "./service-cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("openmausbot service", () => {
  let dir: string;
  const out: string[] = [];
  const err: string[] = [];
  const io = { log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-service-"));
    out.length = 0;
    err.length = 0;
  });
  afterEach(() => removeTempDir(dir));

  it("repeats the serve options, one access mode at a time", () => {
    expect(serviceServeArgs({ port: 8799, dataDir: "/d", domain: "a.example.com", tunnel: true, label: "x" })).toEqual(["--port", "8799", "--data-dir", "/d", "--no-pair", "--domain", "a.example.com", "--label", "x"]);
    expect(serviceServeArgs({ port: 1, dataDir: "/d", tailscale: true })).toEqual(["--port", "1", "--data-dir", "/d", "--no-pair", "--tailscale"]);
  });

  it("writes the unit next to the data and prints how to install it; refuses an npx cache", () => {
    const code = runServiceCommand({ action: "install", dataDir: dir, port: 8799, domain: "maus.example.com", script: "/usr/lib/node_modules/openmausbot/cli.js", node: "/usr/bin/node", platform: "linux", home: "/home/maus", user: "maus" }, io);
    expect(code).toBe(0);
    const unit = readFileSync(join(dir, "openmausbot.service"), "utf8");
    expect(unit).toContain("--domain maus.example.com");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(out.join("\n")).toContain("sudo systemctl enable --now openmausbot");
    expect(out.join("\n")).toContain("no setcap is needed");

    out.length = 0;
    const refused = runServiceCommand({ action: "install", dataDir: join(dir, "x"), port: 8799, script: "/home/maus/.npm/_npx/deadbeef/node_modules/openmausbot/cli.js", node: "/usr/bin/node", platform: "linux" }, io);
    expect(refused).toBe(1);
    expect(err.join("\n")).toMatch(/npm install -g openmausbot/);
    expect(existsSync(join(dir, "x", "openmausbot.service"))).toBe(false);
  });

  it("writes a launchd agent on macOS and explains uninstall on both", () => {
    expect(runServiceCommand({ action: "install", dataDir: dir, port: 8799, tunnel: true, script: "/opt/homebrew/lib/node_modules/openmausbot/cli.js", node: "/opt/homebrew/bin/node", platform: "darwin", home: "/Users/maus" }, io)).toBe(0);
    expect(readFileSync(join(dir, "com.openmausbot.serve.plist"), "utf8")).toContain("<string>--tunnel</string>");
    expect(out.join("\n")).toContain("launchctl bootstrap");
    out.length = 0;
    expect(runServiceCommand({ action: "uninstall", dataDir: dir, port: 8799, script: "/x", node: "/n", platform: "linux" }, io)).toBe(0);
    expect(out.join("\n")).toContain("sudo systemctl disable --now openmausbot");
    expect(runServiceCommand({ action: "install", dataDir: dir, port: 8799, script: "/x", node: "/n", platform: "win32" }, io)).toBe(1);
  });

  it("--sentinel writes the scan's own schedule instead of the server's, and only prints how to install it", () => {
    const base = { action: "install" as const, dataDir: dir, port: 8799, sentinel: true, script: "/usr/lib/node_modules/openmausbot/cli.js", node: "/usr/bin/node" };
    expect(runServiceCommand({ ...base, platform: "darwin", home: "/Users/maus" }, io)).toBe(0);
    expect(readFileSync(join(dir, "com.openmausbot.sentinel.plist"), "utf8")).toContain("<string>sentinel</string>");
    expect(existsSync(join(dir, "com.openmausbot.serve.plist"))).toBe(false);
    expect(existsSync(join(dir, "logs"))).toBe(true);
    expect(out.join("\n")).toContain("launchctl bootstrap gui/$(id -u) /Users/maus/Library/LaunchAgents/com.openmausbot.sentinel.plist");

    out.length = 0;
    expect(runServiceCommand({ ...base, platform: "linux", home: "/home/maus" }, io)).toBe(0);
    expect(readFileSync(join(dir, "openmausbot-sentinel.service"), "utf8")).toContain("sentinel --once --data-dir");
    expect(readFileSync(join(dir, "openmausbot-sentinel.timer"), "utf8")).toContain("OnUnitActiveSec=120s");
    expect(out.join("\n")).toContain("systemctl --user enable --now openmausbot-sentinel.timer");

    out.length = 0;
    expect(runServiceCommand({ ...base, action: "uninstall", platform: "linux", home: "/home/maus" }, io)).toBe(0);
    expect(out.join("\n")).toContain("systemctl --user disable --now openmausbot-sentinel.timer");

    expect(runServiceCommand({ ...base, platform: "win32" }, io)).toBe(1);
    expect(err.join("\n")).toContain('schtasks /Create /SC MINUTE /MO 2 /TN "OpenMausBot Sentinel" /TR "\\"/usr/bin/node\\" \\"/usr/lib/node_modules/openmausbot/cli.js\\" \\"sentinel\\"');
  });
});
