# The safety floor

The safety floor is a short never-list of shell commands the server will not
approve by itself: a recursive delete of the filesystem root, the home
directory or a top-level system directory; formatting or overwriting a disk;
a fork bomb. It is off by default (`safetyFloor.enabled` in `config.json`, or
`OMB_SAFETY_FLOOR=1`). No check here runs any of those commands: the
classifier only reads text, and every permission request is a fake one.

## Run

```sh
pnpm exec vitest run server/safety-floor.test.ts server/safety-floor-gate.test.ts server/auto-approve-undelivered.test.ts
pnpm exec vitest run server/drivers/openai-chat-safety-floor.test.ts server/drivers/self-answer-safety-floor.test.ts
pnpm exec vitest run server/safety-floor.e2e.test.ts
pnpm exec vitest run server/auto-approve.test.ts server/command-allowlist.e2e.test.ts
```

## What it checks

- `server/safety-floor.test.ts` calls the classifier in `server/safety-floor.ts`
  with a table of command lines: every spelling that must be blocked (flags in
  any order, quotes, trailing slashes and dot segments, `sudo`/`doas`/`env`
  prefixes, `sh -c` and `cmd /c` wrappers, chains, cmd and PowerShell forms)
  and every one that must not be (the same words in a commit message, an echo,
  a heredoc or a comment; a subdirectory; a path only a variable knows; an
  image file). The Windows spellings are read from the text, so they run on
  every platform.
- `server/safety-floor-gate.test.ts` feeds fake permission requests to
  `server/safety-floor-gate.ts` with an adapter that only records its answer:
  the setting is off by default and the environment can only add it; a
  never-list command is denied with a reason, one status line and one
  `auto-denied` decision row; anything else is left to the grant; a denial
  that cannot be delivered stops the turn instead of leaving it waiting. A
  request with no known working directory is still denied, from the command
  line it carries. A command the reader cannot read (forced with a reader
  that fails) is neither denied nor allowed: the grant's verdict becomes a
  card, the log says so once without the command, and a runtime with no card
  to show refuses the call.
- `server/drivers/openai-chat-safety-floor.test.ts` drives the chat runtime
  against a local fake provider and a fixture MCP tool that records the
  command it is handed and runs nothing. At Full access and under "Always
  allow this session" the never-list command never reaches the tool; at Ask
  the card reaches a person and their Allow stands; with the floor off
  nothing changes.
- `server/drivers/self-answer-safety-floor.test.ts` drives the Codex and ACP
  drivers against their scripted fakes, which send a permission request and
  record the answer. Codex at Full access accepts a request inside the
  driver; with the floor on it raises a never-list command as a request
  instead, carrying the exact command, and goes on accepting every other one.
  An ACP agent's kept "Always allow this session" repeats for an ordinary
  command and asks again for a never-list one, and a legacy full-auto
  instance does not answer one by itself. Two cases join the driver to the
  fold's own check: a Codex request with no working directory and an ACP
  request not typed as a shell command both reach it with their command
  line, and it denies them.
- `server/safety-floor.e2e.test.ts` launches the real server in an isolated
  home with the fake Claude CLI parked, and raises Bash requests through its
  actual permission socket. A saved command answers `rm -rf /` while the
  floor is off; after `PUT /api/config` switches it on, the same request is
  denied, the transcript carries the notice and `/api/decisions` the row; an
  unsaved never-list command still reaches a card and the person's Allow
  stands. It then restarts that fixture with only `OMB_SAFETY_FLOOR=1`, gives
  the bot Full access, and checks that Full is denied the never-list command
  and still answers an ordinary one. `/api/config` reports the switch at each
  step.

## Limits

These checks prove the places the server answers by itself: the
`request.opened` fold, the chat runtime's own tool gate, and the Codex and
ACP drivers' own answers. They do not prove anything about an engine that
never asks. Claude Code under `bypassPermissions`, Codex with approvals off
and an ACP agent in its own yolo mode run a command without sending a
request, so the floor never sees it.

The Muse Code driver has the same guard as Codex (at Full access it no
longer answers a never-list command inside the driver), but the repository
has no fake Muse host, so that one line is checked by typecheck and reading
only. A request's display summary is cut at 200 characters and is never read
as a command; the floor reads the engine's own command line, which every
driver that has one puts on the request.

Read the Full access leg of `server/safety-floor.e2e.test.ts` for what it is.
The test itself writes the Bash request to the broker's socket. It proves
that a shell request reaching the server at Full access is denied; it does
not show that Claude Code sends one, and under `bypassPermissions` the real
CLI does not. The saved-command leg is the path a real Claude Code, Codex or
ACP agent takes at "Ask for approval".

The fake engine is parked throughout, so nothing here is evidence about a
real model's behaviour, and no Settings control exists yet: the switch is the
config key or the environment variable.
