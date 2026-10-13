import { describe, expect, it } from "vitest";

import {
  launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer, serviceCommand, servicePlan,
  systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/openmausbot/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/maus/.openmausbot", "--domain", "maus.example.com", "--no-pair"],
  dataDir: "/home/maus/.openmausbot",
  user: "maus",
  home: "/home/maus",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/openmausbot/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/OpenMausBot/server/openmausbot.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=OpenMausBot (agentada)");
    expect(unit).toContain("User=maus");
    expect(unit).toContain("Environment=OMB_DATA_DIR=/home/maus/.openmausbot");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/openmausbot/cli.js serve --port 8799 --data-dir /home/maus/.openmausbot --domain maus.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/maus/.openmausbot"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    // a path with a space is quoted for systemd
    expect(systemdUnit({ ...spec, dataDir: "/home/maus/My Data", serveArgs: ["--data-dir", "/home/maus/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/openmausbot/cli.js serve --data-dir "/home/maus/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/maus", dataDir: "/Users/maus/.openmausbot" });
    expect(plist).toContain("<string>com.openmausbot.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>maus.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/maus/.openmausbot/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/maus/.npm/_npx/abc123/node_modules/openmausbot/cli.js")).toMatch(/npm install -g openmausbot/);
    expect(unstableInstallWarning("/usr/lib/node_modules/openmausbot/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/maus/.openmausbot");
    expect(linux?.installed).toBe("/etc/systemd/system/openmausbot.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now openmausbot");
    const mac = servicePlan("darwin", "/Users/maus/.openmausbot", "/Users/maus");
    expect(mac?.installed).toBe("/Users/maus/Library/LaunchAgents/com.openmausbot.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", dataDir: "/Users/maus/.openmausbot", home: "/Users/maus" };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/openmausbot/cli.js", "sentinel", "--once", "--data-dir", "/Users/maus/.openmausbot"]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/OpenMausBot/server/openmausbot.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.openmausbot.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain("/Users/maus/.openmausbot/logs/sentinel.log");
    const mac = sentinelServicePlan("darwin", "/Users/maus/.openmausbot", "/Users/maus");
    expect(mac?.files).toEqual([{ name: "com.openmausbot.sentinel.plist", installed: "/Users/maus/Library/LaunchAgents/com.openmausbot.sentinel.plist" }]);
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.openmausbot.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", dataDir: "/home/maus/My Data", home: "/home/maus" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/openmausbot/cli.js sentinel --once --data-dir "/home/maus/My Data"');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", "/home/maus/.openmausbot", "/home/maus");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/maus/.config/systemd/user/openmausbot-sentinel.service", "/home/maus/.config/systemd/user/openmausbot-sentinel.timer"]);
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now openmausbot-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });
});
