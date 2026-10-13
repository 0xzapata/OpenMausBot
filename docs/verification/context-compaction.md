# Conversation context compaction

Long direct conversations can summarize older exchanges before the next turn.
The full transcript, its branches and attachments are retained. The new session
gets a bounded summary plus recent exchanges; later turns resume that session.
A visible, expandable note explains what was summarized, even with tool chips off.

## Exercise the real path

```sh
pnpm exec vitest run server/context-compaction.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/compaction-summary.test.ts server/context-budget.test.ts server/delta-context.e2e.test.ts
pnpm exec vitest run server/store.test.ts server/config.test.ts src/components/DigestChip.test.ts
pnpm test:packaged-server
```

The API fixture launches the shared isolated server and fake engine. It uses
`control-omb` for create, send, wait, edit and Stop. Its new manual operation is
`POST /api/bots/:id/compact` with `{ "threadId": "owned-thread-id" }`; this uses
normal turn admission, returns 202, and completes through that thread's ordinary
busy/idle state. The route accepts no agent-written summary or file path.
From 80% of a known window, the bot's 1:1 header shows the figure with a
**Compact now** button that calls this route (hidden again once a compaction
record is newer than the last reply).

## Rooms

A room turn resumes no stored session: every turn re-sends the room's
bounded recent transcript (but see Room sessions below). What grows is the
warm provider process a driver keeps between one bot's consecutive turns in
a room (Claude's idle reuse).
Each settled room turn records that bot's last measured prompt for the room's
thread (in memory, like the warm process itself) and the room wire carries it
as `memberContext`. From 80% the roster avatar gets a mark and a line under
the header offers **Compact now**: `POST /api/groups/:id/members/:botId/compact`
(202; 409 before a reading, 404 for a non-member). It runs nothing; the bot's
next turn in that room starts with the existing `sessionReset`, so a fresh
provider session gets the same bounded transcript every turn gets. Before a
room turn, a bot at or above `context.roomCompactAt` (default `0.9`, read like
`compactAt`) is compacted the same way without asking; `autoCompact: false`
turns that off, but not the button. Either way the room shows an activity line.

```sh
pnpm exec vitest run server/room-context.e2e.test.ts server/room-context.test.ts src/lib/context-warning.test.ts
```

The fixture proves a warm process is kept below the threshold or with
automatic compaction off, and replaced after Compact now and above 90%.

### Room sessions (off by default, Claude Code only)

With `"context": { "roomSessions": true }` in config.json (or
`PATCH /api/config`; `OMB_ROOM_SESSIONS=1` / `0` wins over the file), a room
member whose own provider session is known to hold the room is sent only the
lines that session has not been handed, under one note, instead of the
bounded transcript again. The room remembers, in memory, which native session
ran each member's last turn in a thread, which lines it was handed and how
each read. A line that reads differently now than when it was shown is sent
again, marked as replacing the earlier copy: a teammate's report, whose row
is rendered from the request's state at that moment, and a line with an
attachment, which reads without its tag on the turn that carries the image
and with it afterwards. (A digest row is only given a file list where a
turn took a checkpoint, which room turns do not; it would be sent again
too.) With the setting off nothing is remembered or computed.

Only Claude Code is covered, and only when all of these hold: the CLI is new
enough to declare strict resume (2.1.267), and the turn mounts the
engine-hook channel (on unless `OMB_HOOKS=0`), which is how the harness hears
that the engine compacted a session. Codex, ACP agents, Pi, Muse Code and the
API models keep the call described above whatever the setting says, and so
does Claude Code without the hook channel.

Every other turn is the call described above, unchanged:

| When | The member's turn |
|---|---|
| Its first turn in the thread, or after a server restart | whole transcript |
| Another member's turn came between, on the same engine instance (the driver keeps one process per thread) | whole transcript |
| Its last turn failed, was stopped, held, timed out, or ended in another session than it began in | whole transcript |
| Compact now, or the automatic 90% threshold | whole transcript, fresh session, the usual line |
| **Claude Code compacted the session** (`PreCompact`, `SessionStart` with source `compact`) | whole transcript on the same warm session: it holds the CLI's summary now, not the room's lines. Also for a turn that was running when it compacted |
| Its last measured context here is at 80% or more of where the engine compacts (`OMB_CLAUDE_AUTOCOMPACT`, 200,000 tokens by default; the model's window when that is `auto` or `off`) | whole transcript, so no delta is handed to a session about to compact |
| Ten quiet minutes (the driver's own idle time) | whole transcript |
| It missed more lines than the window holds | whole transcript |
| Its model, folder, instructions, approval level, tools, connections or `claudeUserMcp` changed, or the engine instance was reloaded | whole transcript |
| A guest's turn | whole transcript, nothing remembered |

If Claude Code cannot reopen the session, the driver starts a new one from
the whole turn and says so in the room, as it does in a 1:1 chat. Two things
the harness cannot see can make the driver reopen the recorded session from
disk where the turn would otherwise have started a new one: a warm process
that ended by itself, and a change in something only the driver keys its
process on (the project's `.mcp.json`, the account's credentials, a base URL,
a model alias). The session reopened is the recorded one and holds what the
room says it holds; what that costs has not been measured.

```sh
pnpm exec vitest run server/room-sessions.e2e.test.ts
pnpm exec vitest run server/host/room-sessions.test.ts server/host/room-transcript.test.ts server/room-context-settings.test.ts
```

The fixture wraps the fake Claude so every launch records its `--resume` or
`--session-id`, and reads the exact text each room turn's engine received.
It proves: with the setting off a second turn is the whole transcript on the
warm process, as before; with it on, the second turn holds only the new lines
in the same process; a turn after another member's is the whole window on a
new session; so is a turn after a failed one and after a stopped one; Compact
now starts a fresh session with the usual line, and the next turn is a delta
against it; a line posted with `post_to_room` while the member worked arrives
once, in its next turn, under its provenance note; a refused `--resume` ends
with the whole turn on a new session and the driver's notice; after the fake
CLI compacts the session (its hooks reach the harness with the room's thread
and the member) the next turn is the whole window again. No real engine
runs: what a live Claude Code session costs across a resume is not measured
here.

Evidence covers:

- Automatic compaction keeps the two latest exchanges and the incoming request.
- A completed turn retains the driver's latest-prompt measurement, separately from summed input tokens.
- Claude compaction leaves headroom before the selected account's numeric native threshold, including after a previous compaction; `auto` and `off` do not invent a numeric native limit.
- Manual compaction executes no additional agent turn and retains the original messages.
- A repeated request at the same compacted tip is a no-op.
- Restart before the next send retains the summary and replaces the native session once.
- A later send keeps that replacement session instead of injecting the summary again.
- Editing an old message replays its selected branch, not the abandoned summary.
- Stop aborts a hanging helper without a late record; a new send still works.
- Private session bookkeeping stays off the task wire shape; stored summaries redact secrets.

Each API fixture retains exact requests, waits and bounded transcripts in
`<server-log>.context.json`, prints that location, and closes its exact child and
temporary home. No live account, computer or user workspace is touched.

## Bounds and limitations

`context` settings in config.json are optional. `autoCompact: false` disables
automatic folding, `compactAt` is a fraction below 1 or a token count, and
`rebuildBytes` controls replay size (default 24,000 bytes). Context-only settings
do not reload provider processes. The default threshold is 80% of the known
model window; a real latest-prompt measurement wins over a transcript estimate.
Summed input tokens across tool rounds are never treated as context size.
For Claude, the threshold and post-compaction regrowth floor also leave 10%
headroom below the selected account's numeric native-compaction setting.
That account's setting takes precedence over the inherited launch environment.
Native `auto`/`off` settings supply no known numeric bound; other engines keep
their own model-window threshold. The native CLI setting itself is unchanged.

The selected account's tool-free helper can produce a historical summary, with
a 20-second timeout and source-labelled fallback when unavailable. Summaries
are capped at 6,000 bytes and retain recent source corrections. The helper may
incur provider usage; its one-shot cost is not separately reported by the current
provider interface. Summaries are not verified facts and can omit details.

This slice covers direct threads. It does not add channel compaction, change
provider-native compaction, prove live-model summary quality, or ship native
iOS/Android compaction controls. The renderer test checks note markup and escaping,
not a real browser click. Native mobile indicators remain separate PR work.
