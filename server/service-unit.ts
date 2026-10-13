// `openmausbot service install`: keep the server running across reboots.
// Renders a systemd unit (Linux) or a launchd agent (macOS) that runs the
// same `openmausbot serve …` the operator just used, and either installs it
// (when allowed to) or writes it next to the data and prints the two
// commands that install it. Pure rendering lives here so it is testable;
// the CLI decides where the file goes.
import { homedir, userInfo } from "node:os";
import { posix } from "node:path";

// Unit files describe a Linux or macOS machine, so their paths are POSIX
// whatever host renders them (the Windows CI runner included).
const { basename, dirname, join } = posix;

export interface ServiceSpec {
  /** How to start this same CLI: absolute node, then its script. */
  node: string;
  script: string;
  /** `serve …` arguments, already validated by the CLI. */
  serveArgs: string[];
  dataDir: string;
  /** Unix user the service runs as (systemd only). */
  user: string;
  home: string;
  /** Needs ports 80 and 443 (serve --domain): grant the capability to the unit. */
  bindsLowPorts: boolean;
  label?: string;
}

export const SYSTEMD_UNIT_NAME = "openmausbot.service";
export const LAUNCHD_LABEL = "com.openmausbot.serve";

function quoteSystemd(value: string): string {
  // systemd's ExecStart splits on whitespace and understands double quotes.
  return /[\s"\\]/.test(value) ? `"${value.replace(/[\\"]/g, "\\$&")}"` : value;
}

function needsStripTypes(script: string): boolean {
  return script.endsWith(".ts");
}

export function serviceCommand(spec: Pick<ServiceSpec, "node" | "script" | "serveArgs">): string[] {
  return [spec.node, ...(needsStripTypes(spec.script) ? ["--experimental-strip-types"] : []), spec.script, "serve", ...spec.serveArgs];
}

export function systemdUnit(spec: ServiceSpec): string {
  const lines = [
    "# Written by `openmausbot service install`. Re-run it to change the options.",
    "[Unit]",
    `Description=OpenMausBot${spec.label ? ` (${spec.label})` : ""}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${spec.user}`,
    `WorkingDirectory=${spec.home}`,
    `Environment=HOME=${spec.home}`,
    `Environment=OMB_DATA_DIR=${spec.dataDir}`,
    `ExecStart=${serviceCommand(spec).map(quoteSystemd).join(" ")}`,
    "Restart=always",
    "RestartSec=3",
    "KillMode=mixed",
    "TimeoutStopSec=30",
  ];
  if (spec.bindsLowPorts) {
    lines.push("# serve --domain: Caddy binds ports 80 and 443 without running as root.");
    lines.push("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    lines.push("CapabilityBoundingSet=CAP_NET_BIND_SERVICE");
  }
  lines.push("", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(spec: ServiceSpec): string {
  const args = serviceCommand(spec).map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LAUNCHD_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    args,
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>HOME</key>",
    `\t\t<string>${xml(spec.home)}</string>`,
    "\t\t<key>OMB_DATA_DIR</key>",
    `\t\t<string>${xml(spec.dataDir)}</string>`,
    "\t\t<key>PATH</key>",
    "\t\t<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>",
    "\t</dict>",
    "\t<key>WorkingDirectory</key>",
    `\t<string>${xml(spec.home)}</string>`,
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xml(join(spec.dataDir, "logs", "service.log"))}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xml(join(spec.dataDir, "logs", "service.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** An `npx` cache path is pruned without notice; a service must not point at it. */
export function unstableInstallWarning(script: string): string | null {
  const normalized = script.replace(/\\/g, "/");
  if (/\/_npx\//.test(normalized) || /\/\.npm\/_npx\//.test(normalized)) {
    return `this command runs from an npx cache (${dirname(script)}), which npm may delete at any time. Install it permanently first (npm install -g openmausbot) and run \`openmausbot service install\` from that install.`;
  }
  return null;
}

/** Where the rendered file goes and how to activate it, per platform. */
export function servicePlan(platform: NodeJS.Platform, dataDir: string, home = homedir()): { file: string; installed: string; activate: string[]; deactivate: string[] } | null {
  if (platform === "linux") {
    const installed = `/etc/systemd/system/${SYSTEMD_UNIT_NAME}`;
    return {
      file: join(dataDir, SYSTEMD_UNIT_NAME),
      installed,
      activate: [`sudo install -m 644 ${join(dataDir, SYSTEMD_UNIT_NAME)} ${installed}`, "sudo systemctl daemon-reload", `sudo systemctl enable --now ${basename(SYSTEMD_UNIT_NAME, ".service")}`],
      deactivate: [`sudo systemctl disable --now ${basename(SYSTEMD_UNIT_NAME, ".service")}`, `sudo rm ${installed}`, "sudo systemctl daemon-reload"],
    };
  }
  if (platform === "darwin") {
    const installed = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    return {
      file: join(dataDir, `${LAUNCHD_LABEL}.plist`),
      installed,
      activate: [`mkdir -p ${dirname(installed)} && cp ${join(dataDir, `${LAUNCHD_LABEL}.plist`)} ${installed}`, `launchctl bootstrap gui/$(id -u) ${installed}`],
      deactivate: [`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, `rm ${installed}`],
    };
  }
  return null;
}

// `openmausbot service install --sentinel`: Sentinel, the read-only health
// scanner (server/sentinel/), every two minutes out of process, so it keeps
// noticing failures after the app itself has crashed. A launchd agent with a
// StartInterval on macOS, a systemd user timer on Linux: it reads only what
// its own user can, so it needs no root and no system unit.
export const SENTINEL_LAUNCHD_LABEL = "com.openmausbot.sentinel";
export const SENTINEL_SYSTEMD_NAME = "openmausbot-sentinel";
export const SENTINEL_INTERVAL_SECONDS = 120;

export type SentinelServiceSpec = Pick<ServiceSpec, "node" | "script" | "dataDir" | "home">;

export function sentinelCommand(spec: Pick<SentinelServiceSpec, "node" | "script" | "dataDir">): string[] {
  return [spec.node, ...(needsStripTypes(spec.script) ? ["--experimental-strip-types"] : []), spec.script, "sentinel", "--once", "--data-dir", spec.dataDir];
}

export function sentinelLaunchdPlist(spec: SentinelServiceSpec): string {
  const args = sentinelCommand(spec).map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
  const log = xml(join(spec.dataDir, "logs", "sentinel.log"));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${SENTINEL_LAUNCHD_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    args,
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>HOME</key>",
    `\t\t<string>${xml(spec.home)}</string>`,
    "\t</dict>",
    "\t<key>StartInterval</key>",
    `\t<integer>${SENTINEL_INTERVAL_SECONDS}</integer>`,
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>ProcessType</key>",
    "\t<string>Background</string>",
    "\t<key>LowPriorityIO</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${log}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${log}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function sentinelSystemdService(spec: SentinelServiceSpec): string {
  return [
    "# Written by `openmausbot service install --sentinel`. Started by its timer.",
    "[Unit]",
    "Description=OpenMausBot Sentinel health scan",
    "",
    "[Service]",
    "Type=oneshot",
    `Environment=HOME=${spec.home}`,
    `ExecStart=${sentinelCommand(spec).map(quoteSystemd).join(" ")}`,
    "Nice=10",
    "IOSchedulingClass=idle",
    "",
  ].join("\n");
}

export function sentinelSystemdTimer(): string {
  return [
    "# Written by `openmausbot service install --sentinel`.",
    "[Unit]",
    "Description=Run the OpenMausBot Sentinel health scan every two minutes",
    "",
    "[Timer]",
    `OnBootSec=${SENTINEL_INTERVAL_SECONDS}s`,
    `OnUnitActiveSec=${SENTINEL_INTERVAL_SECONDS}s`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

/** The files written next to the data, where each one goes, and how to
 * activate them. Null on a platform without a renderer (Windows). */
export function sentinelServicePlan(platform: NodeJS.Platform, dataDir: string, home = homedir()): { files: Array<{ name: string; installed: string }>; activate: string[]; deactivate: string[] } | null {
  if (platform === "linux") {
    const dir = join(home, ".config", "systemd", "user");
    const files = [`${SENTINEL_SYSTEMD_NAME}.service`, `${SENTINEL_SYSTEMD_NAME}.timer`].map((name) => ({ name, installed: join(dir, name) }));
    return {
      files,
      activate: [`mkdir -p ${dir} && cp ${files.map((file) => join(dataDir, file.name)).join(" ")} ${dir}/`, "systemctl --user daemon-reload", `systemctl --user enable --now ${SENTINEL_SYSTEMD_NAME}.timer`],
      deactivate: [`systemctl --user disable --now ${SENTINEL_SYSTEMD_NAME}.timer`, `rm ${files.map((file) => file.installed).join(" ")}`, "systemctl --user daemon-reload"],
    };
  }
  if (platform === "darwin") {
    const name = `${SENTINEL_LAUNCHD_LABEL}.plist`;
    const installed = join(home, "Library", "LaunchAgents", name);
    return {
      files: [{ name, installed }],
      activate: [`mkdir -p ${dirname(installed)} && cp ${join(dataDir, name)} ${installed}`, `launchctl bootstrap gui/$(id -u) ${installed}`],
      deactivate: [`launchctl bootout gui/$(id -u)/${SENTINEL_LAUNCHD_LABEL}`, `rm ${installed}`],
    };
  }
  return null;
}

export function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "openmausbot";
  }
}
