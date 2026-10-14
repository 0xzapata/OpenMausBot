# Browser-ready desktop packages

Desktop installers include the pinned `agent-browser` engine and Chromium
Headless Shell. A fresh installation needs no separate browser download.
This is an automation browser, not a headed Google Chrome application.
Browser access is on by default, both for the workspace (Settings) and for
each bot (its computer panel); switching either off withholds the browser,
and bundling executables never overrides that switch.

## Package layout and lookup

`pnpm package:prepare` runs `pnpm build:browser`. It downloads verified vendor
archives and stages `dist-native/browser/PLATFORM-ARCH`, copied as
`Resources/browser-engine` on macOS or `resources/browser-engine` elsewhere.
Each package includes only its target architecture: macOS ARM64/x64,
Windows x64, or Linux x64.

The server receives `OMB_RESOURCES_PATH` from Electron. It resolves an explicit
`OMB_AGENT_BROWSER_PATH` override first, then the complete bundled engine and
browser, then a separately installed engine or PATH. An incomplete bundle
fails closed with a reinstall/update message. An explicit
`AGENT_BROWSER_EXECUTABLE_PATH` still overrides the browser executable.
Profiles, cookies and downloads are user data, never packaged resources.

The npm/self-hosted distribution stays small and retains its explicit browser
installation flow. Desktop packaging does not silently enlarge the npm tarball.

## Signed-in sites and My Chrome

Each built-in browser lists its signed-in sites (Settings → Browser profiles,
or a bot's Browser panel) with Sign out per site and Sign out of all. It works
the same on desktop, a server and Cloud, for an open or a closed browser. A
shared profile can instead use **My Chrome**, the person's own running Chrome,
for sites that refuse the automated one, such as Google sign-in. That needs
the desktop app and Chrome 144+ with remote debugging on at
`chrome://inspect/#remote-debugging`; on Cloud and servers profiles stay
built-in. Details: [the browser engine plan, step 5](plans/browser-engine.md).

## Process hygiene

Each built-in browser is an agent-browser daemon and the Chrome it starts.
agent-browser starts the daemon in a session of its own and Chrome in a
process group of its own, so neither stops with OpenMausBot, and a daemon
nothing closes keeps its Chrome for the engine's one-hour idle timeout. The
same rules hold on the desktop, a server and Cloud:

- **Closing waits for the processes.** `close` answers before the daemon
  has exited (about 150 ms later on a Mac). A browser counts as closed once
  the engine no longer lists it and nothing of the process tree read before
  the close still runs. Past the deadline the daemon gets TERM first, alone,
  so it can still save the sign-ins from its Chrome; whatever is left after
  a short grace is killed by process group, and a process outside those
  groups by its pid (Windows: `taskkill /T`), and Chrome's temporary profile
  folder is removed as the daemon would have. Only a pid file that still names
  this session's daemon is acted on: the same agent-browser binary, with
  `AGENT_BROWSER_DAEMON=1` and the session's name in its environment (on
  Windows, which shows neither, the same image, checked again before
  `taskkill` and while waiting). Each process is matched by its start time,
  so a pid the system gave to another program, another bot's daemon or an
  engine command included, is never signalled. A browser that is not running
  is never sent `close` at all: the CLI would start a daemon only to stop it
  again (and leave its `.config` file behind). On Linux the process table is
  read from `/proc`, so an image without `ps` works the same.
- **Unused browsers close.** A browser nothing has used for
  `browserEngine.idleTimeoutMinutes` in `config.json` (1 to 60; 10 when
  unset) is closed: no bot call (a tool listing counts, and so do a call
  waiting behind another, its page-health reads and recorded step, and
  fill_login's typing; a preview frame only holds off a close while it is
  taken), no turn that has used it and is still running, no person holding
  it, no open Browser panel.
  Saved sign-ins stay, and the bot's next browser call opens it again and is
  told its pages are gone. A temporary browser saves nothing, so it starts
  fresh, and the bot is told its sign-ins went too. A profile set to My
  Chrome is the person's own Chrome and is never closed.
- **Leftovers are swept.** A crash or a kill closes nothing, so the server
  sweeps when it starts, every minute, and at shutdown. It closes only this
  data dir's browsers: each bot's own, each built-in profile's, and its
  temporary browsers, whose names carry a tag of the data dir. A Chrome whose
  daemon was killed under it (by the OOM killer, by hand) can never be used
  again: it is found by the session its environment names and stopped, and
  its profile folder removed. Anything else under the same HOME, such as a
  person's own agent-browser sessions, is left alone. Browsers are told
  apart by session name, and agent-browser keeps one daemon per name under a
  HOME: a person's own agent-browser session named like one of this data
  dir's profiles (a profile from before profile ids were random, such as
  `work`), or a copy of this data dir run under the same HOME, shares this
  data dir's browsers, and the sweep closes them as its own. Windows lists no
  environments, so there a Chrome whose daemon was killed is not found.

**Containers.** Chrome's helper processes need something to collect them
once their parent exits, and Chrome needs shared memory. Both Docker compose
files and the Podman one set `init: true` and `shm_size: 512m`, as
OpenMausBot's desktop containers do (`--shm-size 512m`); a plain
`docker run` wants `--init --shm-size=512m`. agent-browser 0.37.0 itself
adds `--no-sandbox` and `--disable-dev-shm-usage` when it sees
`/.dockerenv` or `/run/.containerenv`, runs as root or under CI, or finds
docker, kubepods or lxc in `/proc/1/cgroup`. A runtime that shows none of
these (a Kubernetes pod on cgroup v2, for one) needs `/dev/shm` room of its
own (on Kubernetes, an `emptyDir` with `medium: Memory`). The image does
not set `AGENT_BROWSER_ARGS`: OpenMausBot hands its browsers a curated
environment that would not carry it. On Fly Machines (the Cloud home) Fly's
own init runs as PID 1.

## Video recording

The macOS and Linux engine is pinned to agent-browser 0.37.0. Its
[`record start` and `record restart`](https://agent-browser.dev/recording)
commands record the active page at 30 fps by default; `--fps 60` selects 60 fps
(valid range: 1–60). This saves a video file; it does not enable a live view.
Recording requires `ffmpeg` on the server's PATH, with `libvpx` for WebM or
`libx264` for MP4. `agent-browser doctor` reports these optional dependencies.
They are not bundled or required for normal browsing. Higher frame rates use
more CPU and disk space; the actual distinct frames depend on page repaints.
There is no recording control in OMB's browser panel.

## Linux sandbox

Use the `.deb` on Ubuntu 24.04. Its package hooks install a narrowly scoped
AppArmor policy for the root-owned browser executable under `/opt/OpenMausBot`.
They do not disable the browser sandbox or change the global user-namespace
restriction. See [Linux desktop](linux-desktop.md).

The AppImage contains the same binaries, but cannot install a privileged
sandbox policy. Restricted hosts may need the `.deb` rather than the AppImage.

## Release verification and updates

Versions, URLs, sizes and SHA-256 digests live in
`server/browser-bundle-release.ts`; engine pins are shared with
`server/browser-engine-release.ts`. Every cached download is rechecked.
Preparation inventories the entire vendor tree, including licenses. The
`afterPack` gate rejects missing resources, changed bytes or wrong executable
architectures before signing. macOS signing changes native bytes, so signed
packages are subsequently checked using code signatures and runtime tests,
not the original upstream executable hashes.

Run the real browser check against an unpacked app:

```sh
node scripts/smoke-browser-bundle.mjs --resources /absolute/app/resources
```

On macOS, use `/absolute/OpenMausBot.app/Contents/Resources`. On Linux, run as
an unprivileged user against the installed `.deb` at
`/opt/OpenMausBot/resources`. This check creates its own empty home and local
web page, checks automatic discovery, navigation, typing/clicking, the
loopback command relay the server reads, pictures and types through
(`server/browser-relay.ts`), screenshot delivery and two-bot cookie/storage
isolation, then removes only its fixture.
No model account or user browser profile is used. Cross-target `--check-only`
checks layout only and is not evidence of successful browser execution.

The release workflows run this check on native macOS, Windows and Linux
runners before publishing. macOS also verifies the browser binaries are signed
with the app's team identity. The browser is updated through a reviewed app
release: review the new vendor target/license contents, update all platform
pins, run preparation/tests and the native package gates, and ship promptly
when browser security updates are needed. There is no independent automatic
browser updater in the desktop bundle.

### Temporary Windows engine backport

Windows uses an explicitly identified OpenMausBot build of agent-browser
0.36.0, with the handle-inheritance fix from
[upstream PR #1781](https://github.com/vercel-labs/agent-browser/pull/1781).
The official 0.37.0 release does not contain this fix, so Windows stays on the
native-verified `0.36.0-omb.1` revision and does not yet get the new recording
options. Do not replace it with the unpatched 0.37.0 Windows binary.
The original binary can hang when a newly started background browser holds
the tool call's output connection open. The backport changes that Windows
startup behavior; it does not include the PR's broader output-reader rewrite
or unrelated changes from upstream main.

The artifact-only **Windows browser vendor build** workflow builds the pinned
source and checked-in patch, retains the licenses and build provenance, and
tests cold start plus close/reopen through the same MCP connection on Windows.
Its candidate must be reviewed and its exact size and SHA-256 pinned before
the normal application packaging workflow consumes it. Candidate testing does
not replace the packaged-app tests. Published vendor bytes must not be
overwritten; a changed build needs a new revision and reviewed pins.

The Windows revision has a separate managed installation directory so an old
0.36.0 download is not mistaken for the patched engine. Desktop packages use
their bundled engine. Explicit executable overrides remain user-managed.
Remove the backport when an official release includes the fix and passes the
same native cold-start and restart tests.

Complete upstream notices and provenance are in
[`third_party/browser`](../third_party/browser/README.md). The full Google
Chrome distribution and its proprietary Widevine component are not bundled.
