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

A room turn never resumes a stored session: every turn re-sends the room's
bounded recent transcript. What grows is the warm provider process a driver
keeps between one bot's consecutive turns in a room (Claude's idle reuse).
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

## Tool history in a rebuilt session

A session rebuilt from the inline replay (an engine switched in mid-thread, a
rewind, a session the provider lost, a compaction) is sent what was said. With
`context.replayToolHistory: true` in config.json, or `OMB_REPLAY_TOOL_HISTORY=1`
in the server's environment (`0` forces it off), that replay also names each
earlier tool call on one line, between the two messages it ran between, as
`[ran: Bash: pnpm test — failed]` or `[ran: Read: server/config.ts — ok]`. It is
off by default, and off the replay is byte-for-byte what it was.

```sh
pnpm exec vitest run server/replay-tool-history.e2e.test.ts
pnpm exec vitest run server/context-rebuild.test.ts server/turn-context.test.ts server/config.test.ts
```

The fixture's engine runs a command and reads a file each turn. The test rewinds
with `control-omb edit` and reads the prompt the engine received: no such line
while the setting is off, both lines in order once it is on (the command, and
the file read), and the plain message for every turn that resumes its session.
It then switches the bot to the fixture's Codex and reads what that engine was
sent: the lines for each of Claude's turns. Its evidence is
`<server-log>.replay-tools.json`.

A line shows the tool, what it acted on and `ok`, `failed` or `no result
recorded`. What it acted on is the command beside the chip in the chat, or, for
a call whose chip shows none (a `Read`, a search), one argument from the input
preview behind the chip: the command, file, search pattern, query or URL. Never
a tool result, and nothing else of the preview (a `Write`'s content, an `Edit`'s
old and new text). It is redacted, then clipped to 120 characters; a long path
keeps its end. At most 20 lines are sent, the most recent, only for calls
between the first and last replayed message, and only from the bytes of
`rebuildBytes` that messages left unused: the messages selected are the same
with the setting on or off. Engines that replay natively (API models sent the
transcript itself) and room turns are unchanged. A call is still named without a
target when its preview holds none of those as a top-level argument.

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
