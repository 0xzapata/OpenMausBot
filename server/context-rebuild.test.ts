import { describe, expect, it } from "vitest";
import {
  boundedContextText,
  replayToolCalls,
  replayToolHistoryEnabled,
  selectReplay,
  toolReplayLine,
  REPLAY_TOOL_LINE_CAP,
  TOOL_LINE_MAX_CHARS,
  type ReplayEntry,
  type ReplayToolCall,
} from "./context-rebuild.ts";
import type { Message } from "./store.ts";
import { toolDetailPreview } from "./tool-summary.ts";

const entries = (texts: string[]): ReplayEntry[] => texts.map((text, i) => ({ id: String(i), role: i % 2 ? "assistant" : "user", text }));
const size = (result: ReturnType<typeof selectReplay>) => result.transcript.reduce((n, entry) => n + Buffer.byteLength(entry.text) + 16, 0);

describe("context replay", () => {
  it("keeps short history unchanged and records exactly what was represented", () => {
    const history = entries(["one", "reply", "two"]);
    const result = selectReplay(history);
    expect(result.transcript).toEqual(history);
    expect(result.representedIds).toEqual(history.map(entry => entry.id));
    expect(result.dropped).toBe(0);
  });

  it("uses byte and message bounds without falsely crediting dropped messages", () => {
    const history = entries(Array.from({ length: 80 }, (_, i) => `${i} ${"long 🐭 text ".repeat(50)}`));
    const result = selectReplay(history, { budgetBytes: 2_048, maxMessages: 40 });
    expect(size(result)).toBeLessThanOrEqual(2_048);
    expect(result.dropped).toBeGreaterThan(0);
    expect(new Set(result.representedIds)).toEqual(new Set(result.transcript.filter(entry => entry.id).map(entry => entry.id)));
    expect(result.representedIds).not.toContain("0");
    expect(result.representedIds).toContain("79");
  });

  it("counts the summary and omission notice against the budget", () => {
    const history = entries(["old", "old reply", "retained", "reply", ""]);
    const result = selectReplay(history, { budgetBytes: 1_024, compaction: {
      id: "4", firstKeptId: "2", foldedThroughId: "1", summary: "large 🐭 summary ".repeat(1_000), by: "harness", tokensBefore: 100,
    } });
    expect(size(result)).toBeLessThanOrEqual(1_024);
    expect(result.compacted).toBe(2);
    expect(new Set(result.representedIds)).toEqual(new Set(["0", "1", "2", "3", "4"]));
    expect(result.transcript[0]!.text).toContain("historical data");
  });

  it("ignores records whose anchors no longer belong to the selected branch", () => {
    const history = entries(["corrected history", "answer", "keep", ""]);
    const result = selectReplay(history, { compaction: {
      id: "3", firstKeptId: "2", foldedThroughId: "abandoned-id", summary: "obsolete request", by: "harness", tokensBefore: 100,
    } });
    expect(result.compacted).toBe(0);
    expect(result.transcript.map(entry => entry.text)).toContain("corrected history");
    expect(JSON.stringify(result.transcript)).not.toContain("obsolete request");
  });

  it("finds the compaction boundary before excluding the turn's own request", () => {
    const result = selectReplay(entries(["old", "reply", "current", ""]), {
      excludedIds: new Set(["2"]), compaction: { id: "3", firstKeptId: "2", foldedThroughId: "1", summary: "old summary", by: "person", tokensBefore: 1 },
    });
    expect(result.compacted).toBe(2);
    expect(result.representedIds).not.toContain("2");
    expect(result.transcript).toHaveLength(1);
  });

  it("bounds a single oversized history entry, preserving both ends and an honest notice", () => {
    const result = selectReplay(entries([`START ${"🐭".repeat(10_000)} CANCELLED_AT_END`]), { budgetBytes: 1_024 });
    expect(size(result)).toBeLessThanOrEqual(1_024);
    expect(result.shortened).toEqual(["0"]);
    expect(result.transcript[0]!.text).toMatch(/^START /);
    expect(result.transcript[0]!.text).toContain("Text shortened");
    expect(result.transcript[0]!.text).toMatch(/CANCELLED_AT_END$/);
    expect(result.transcript[0]!.text).not.toContain("�");
  });

  it("a full manual fold retains later messages without a future boundary id", () => {
    const result = selectReplay(entries(["old", "reply", "", "new question", "new answer"]), {
      compaction: { id: "2", firstKeptId: "", foldedThroughId: "1", summary: "old summary", by: "person", tokensBefore: 1 },
    });
    expect(result.compacted).toBe(2);
    expect(result.transcript.slice(1).map(entry => entry.text)).toEqual(["new question", "new answer"]);
    expect(new Set(result.representedIds)).toEqual(new Set(["0", "1", "2", "3", "4"]));
  });

  it("bounds UTF-8 text at every possible split", () => {
    const text = "start 你好🐭".repeat(100);
    for (let limit = 0; limit < 300; limit++) {
      const result = boundedContextText(text, limit);
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(limit);
      expect(result).not.toContain("�");
    }
  });

  it.each([NaN, Infinity, -1, 0, 512, 1_024.5])("rejects an invalid budget %s", (budgetBytes) => {
    expect(() => selectReplay([], { budgetBytes })).toThrow("invalid context");
  });
});

// A rebuilt session is also told which tools already ran — one line per
// call, put back between the messages it ran between. Message content keeps
// the whole budget it has today; these lines only ever use what is left.
describe("tool history in a rebuilt session", () => {
  const ON = { replayToolHistory: true };
  const NO_ENV: NodeJS.ProcessEnv = {};
  const said = (id: string, role: Message["role"], text: string): Message => ({ id, role, kind: "text", text, at: 1 });
  const ran = (id: string, name: string, tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
    ({ id, role: "bot", kind: "activity", tool: { name, ok: true, itemId: `item-${id}`, ...tool }, at: 1 });
  const toolLine = (entry: ReplayEntry) => !entry.id && entry.text.startsWith("[ran: ");
  /** A message whose framed size (text + 16) is exactly `bytes`. */
  const sized = (bytes: number) => "x".repeat(bytes - 16);

  describe("toolReplayLine", () => {
    it("names the tool, the command beside it on the chip, and whether it worked", () => {
      expect(toolReplayLine({ name: "Bash", summary: "pnpm test", ok: false })).toBe("[ran: Bash: pnpm test — failed]");
      expect(toolReplayLine({ name: "Read", ok: true })).toBe("[ran: Read — ok]");
    });

    it("shows a command-titled chip once, the way the chat does", () => {
      // Codex and ACP title the chip with the command itself
      expect(toolReplayLine({ name: "git status --short", summary: "git status --short", ok: true })).toBe("[ran: git status --short — ok]");
      expect(toolReplayLine({ name: "cat server/config.ts", summary: "cat server/config.ts | head", ok: true })).toBe("[ran: cat server/config.ts — ok]");
    });

    it("never invents a result for a call that has none recorded", () => {
      // a turn stopped mid-call leaves its row without `ok`
      expect(toolReplayLine({ name: "Grep" })).toBe("[ran: Grep — no result recorded]");
    });

    it("stays on one line", () => {
      expect(toolReplayLine({ name: "Bash", summary: "echo a\n  echo b\tc", ok: true })).toBe("[ran: Bash: echo a echo b c — ok]");
    });

    it("carries no tool result, and nothing of the input preview but its target", () => {
      expect(toolReplayLine({
        name: "Bash", summary: "cat notes.txt", ok: true,
        input: '{\n  "command": "cat notes.txt",\n  "description": "INPUT_PREVIEW"\n}', output: "RESULT_BODY",
      })).toBe("[ran: Bash: cat notes.txt — ok]");
    });

    it("redacts credentials the way stored activity titles are", () => {
      const key = `sk-ant-${"a".repeat(32)}`;
      const line = toolReplayLine({ name: `curl -H "x-api-key: ${key}" https://api.example.test`, ok: true });
      expect(line).not.toContain(key);
      expect(line).toContain("«redacted");
      expect(toolReplayLine({ name: "Bash", summary: "deploy --token hunter2hunter2", ok: true })).not.toContain("hunter2hunter2");
    });

    it("clips a long title without losing the outcome", () => {
      for (const ok of [true, false, undefined]) {
        const line = toolReplayLine({ name: "x".repeat(500), ok });
        expect([...line]).toHaveLength(TOOL_LINE_MAX_CHARS);
        expect(line.startsWith("[ran: xxxxxxxxxx")).toBe(true);
        expect(line).toMatch(/x… — (ok|failed|no result recorded)\]$/);
      }
    });

    it("redacts before it clips, so a key cut in half cannot slip through", () => {
      // clipped first, only "sk-ant-aaaa" would be left: too short to be
      // recognised, and so shown
      const line = toolReplayLine({ name: `${"x".repeat(90)} sk-ant-${"a".repeat(40)}`, ok: true });
      expect([...line]).toHaveLength(TOOL_LINE_MAX_CHARS);
      expect(line).not.toContain("sk-ant-");
    });

    it("never splits a character when it clips", () => {
      // U+20BB7 takes two UTF-16 units: a cut by unit could leave one behind
      const line = toolReplayLine({ name: "𠮷".repeat(300), ok: true });
      expect([...line]).toHaveLength(TOOL_LINE_MAX_CHARS);
      expect(Buffer.from(line, "utf8").toString("utf8")).toBe(line);
    });

    // A Read's chip shows no path: what it read is only in the input preview
    // behind the chip. Without it the line says a tool ran, not on what.
    describe("what the call acted on, from its input preview", () => {
      // as every driver builds `tool.input`: the arguments, redacted, as indented JSON
      const preview = (input: unknown) => toolDetailPreview(input)!;
      const line = (name: string, input: unknown, tool: Partial<NonNullable<Message["tool"]>> = {}) =>
        toolReplayLine({ name, ok: true, input: preview(input), ...tool });

      it("names the file a Claude-style Read acted on", () => {
        expect(line("Read", { file_path: "/repo/server/config.ts", offset: 10, limit: 40 })).toBe("[ran: Read: /repo/server/config.ts — ok]");
      });

      it("names the search pattern, the query, the URL or the command where that is the target", () => {
        expect(line("Grep", { pattern: "replayToolHistory", path: "/repo/server", output_mode: "content" })).toBe("[ran: Grep: replayToolHistory — ok]");
        expect(line("Glob", { path: "/repo", pattern: "**/*.test.ts" })).toBe("[ran: Glob: **/*.test.ts — ok]");
        expect(line("read", { path: "server/index.ts" })).toBe("[ran: read: server/index.ts — ok]");
        expect(line("NotebookEdit", { notebook_path: "/repo/a.ipynb", new_source: "SOURCE_BODY" })).toBe("[ran: NotebookEdit: /repo/a.ipynb — ok]");
        expect(line("WebSearch", { query: "vitest fake timers" })).toBe("[ran: WebSearch: vitest fake timers — ok]");
        expect(line("WebFetch", { url: "https://example.test/docs", prompt: "PROMPT_BODY" })).toBe("[ran: WebFetch: https://example.test/docs — ok]");
        // an API model's tool call has no command beside its chip, only this
        expect(line("computer_exec", { command: "ls -la" }, { ok: false })).toBe("[ran: computer_exec: ls -la — failed]");
      });

      it("still yields the bare line for a row with no preview, or a preview that names no target", () => {
        expect(toolReplayLine({ name: "Read", ok: true })).toBe("[ran: Read — ok]");
        expect(toolReplayLine({ name: "Read", ok: true, input: "" })).toBe("[ran: Read — ok]");
        // arguments that did not parse, and the previews that stand in for content
        expect(toolReplayLine({ name: "Read", ok: true, input: '{ not arguments: "file_path": "/x"' })).toBe("[ran: Read — ok]");
        expect(line("Read", "x".repeat(300_000))).toBe("[ran: Read — ok]");
        expect(line("Read", `data:image/png;base64,${"A".repeat(64)}`)).toBe("[ran: Read — ok]");
        expect(line("TodoWrite", { todos: [{ content: "TODO_BODY", path: "/nested/not-a-target" }] })).toBe("[ran: TodoWrite — ok]");
        expect(line("Agent", { description: "DESCRIPTION_BODY", prompt: "PROMPT_BODY" })).toBe("[ran: Agent — ok]");
        expect(line("edit", [{ path: "/repo/a.ts", diff: "DIFF_BODY" }])).toBe("[ran: edit — ok]");
        expect(line("Read", { file_path: 42, path: "   " })).toBe("[ran: Read — ok]");
      });

      it("shows a command once: the one beside the chip, or the title that already is it", () => {
        expect(line("Bash", { command: "pnpm test", description: "DESCRIPTION_BODY" }, { summary: "pnpm test", ok: false }))
          .toBe("[ran: Bash: pnpm test — failed]");
        // Codex: the title is the command
        expect(line("git status --short", { command: "git status --short", cwd: "/repo" }, { summary: "git status --short" }))
          .toBe("[ran: git status --short — ok]");
        // ACP: the title is the command, cut at 80 characters
        const command = `pnpm exec vitest run ${"server/some-long-test-name.test.ts ".repeat(4)}`.trim();
        expect(line(command.slice(0, 80), { command }, { summary: command })).toBe(`[ran: ${command.slice(0, 80)} — ok]`);
        // ACP: a title that already names the file
        expect(line("Read /repo/a.ts", { path: "/repo/a.ts" })).toBe("[ran: Read /repo/a.ts — ok]");
      });

      it("adds the target to a title that does not have it", () => {
        // ACP: a spoken title, the file only in the arguments
        expect(line("Read file", { path: "/repo/a.ts" })).toBe("[ran: Read file: /repo/a.ts — ok]");
      });

      it("takes a plain-text input as the target: it is the call's one argument", () => {
        // Codex's web search: the driver previews the query itself (server/testing/fake-codex-app-server.ts)
        expect(line("web_search", "OpenMausBot")).toBe("[ran: web_search: OpenMausBot — ok]");
        expect(preview("OpenMausBot")).toBe("OpenMausBot");
        const key = `sk-ant-${"a".repeat(32)}`;
        const searched = toolReplayLine({ name: "web_search", ok: true, input: `docs for ${key}\nsecond line` });
        expect(searched).toMatch(/^\[ran: web_search: docs for «redacted \d+ chars» second line — ok\]$/);
        const long = line("web_search", `${"word ".repeat(2_000)}`);
        expect([...long]).toHaveLength(TOOL_LINE_MAX_CHARS);
        expect(long).toMatch(/^\[ran: web_search: (word )+w?o?r?d?… — ok\]$/);
      });

      it("masks a secret-shaped value, whether or not the preview was redacted before it was stored", () => {
        const key = `sk-ant-${"a".repeat(32)}`;
        // as drivers store it: already redacted
        const fetched = line("WebFetch", { url: `https://api.example.test/v1/models?api_key=${key}` });
        expect(fetched).not.toContain(key);
        expect(fetched).toMatch(/^\[ran: WebFetch: https:\/\/api\.example\.test\/v1\/models\?api_key=«redacted \d+ chars» — ok\]$/);
        // a preview that reached the store unredacted is redacted here
        for (const unredacted of [
          { name: "Read", input: { file_path: `/repo/${key}.txt` } },
          { name: "Grep", input: { pattern: "password=hunter2hunter2" } },
          { name: "WebFetch", input: { url: "https://deploy:hunter2hunter2@example.test/hook" } },
          { name: "computer_exec", input: { command: `curl -H "Authorization: Bearer ${key}" https://api.example.test` } },
        ]) {
          const raw = JSON.stringify(unredacted.input, null, 2);
          expect(raw).toMatch(/hunter2hunter2|sk-ant-a/);
          const shown = toolReplayLine({ name: unredacted.name, ok: true, input: raw });
          expect(shown).not.toMatch(/hunter2hunter2|sk-ant-a/);
          expect(shown).toContain("«redacted");
        }
      });

      it("carries nothing else of the preview, and never the result", () => {
        expect(line("Write", { file_path: "/repo/notes.md", content: "CONTENT_BODY" }, { output: "RESULT_BODY" })).toBe("[ran: Write: /repo/notes.md — ok]");
        expect(line("Edit", { file_path: "/repo/notes.md", old_string: "OLD_BODY", new_string: "NEW_BODY" }, { output: "RESULT_BODY" }))
          .toBe("[ran: Edit: /repo/notes.md — ok]");
        // a secret under its own key is masked by name in the preview, and is not a target anyway
        expect(line("deploy", { path: "/repo", token: "hunter2" })).toBe("[ran: deploy: /repo — ok]");
      });

      it("still names the file when the preview was shortened", () => {
        const input = preview({ file_path: "/repo/big.ts", content: "x".repeat(20_000) });
        expect(input).toContain("preview shortened");
        expect(() => JSON.parse(input) as unknown).toThrow();
        expect(toolReplayLine({ name: "Write", ok: true, input })).toBe("[ran: Write: /repo/big.ts — ok]");
        // a target the cut ran through is no target
        const cut = preview({ content: "x".repeat(5_950), file_path: `/repo/${"deep/".repeat(40)}cut.ts` });
        expect(cut).toContain('"file_path": "/repo/deep/');
        expect(toolReplayLine({ name: "Write", ok: true, input: cut })).toBe("[ran: Write — ok]");
      });

      it("clips to the length a title is clipped to: a path keeps its end, anything else its start", () => {
        for (const ok of [true, false, undefined]) {
          const read = line("Read", { file_path: `/repo/${"deep/".repeat(40)}context-rebuild.ts` }, { ok });
          expect([...read]).toHaveLength(TOOL_LINE_MAX_CHARS);
          expect(read).toMatch(/^\[ran: Read: …[a-z/]*deep\/context-rebuild\.ts — (ok|failed|no result recorded)\]$/);
          const grep = line("Grep", { pattern: "p".repeat(300) }, { ok });
          expect([...grep]).toHaveLength(TOOL_LINE_MAX_CHARS);
          expect(grep).toMatch(/^\[ran: Grep: p+… — (ok|failed|no result recorded)\]$/);
        }
        // redacted first: cut first, the end that is kept would be the back
        // half of this key, with nothing left to recognise it by
        const keyed = toolReplayLine({ name: "Read", ok: true, input: JSON.stringify({ file_path: `/repo/sk-ant-${"a".repeat(200)}` }, null, 2) });
        expect(keyed).toBe("[ran: Read: /repo/«redacted 207 chars» — ok]");
      });

      it("stays on one line", () => {
        expect(line("Grep", { pattern: "first\n  second\tthird" })).toBe("[ran: Grep: first second third — ok]");
      });
    });
  });

  describe("replayToolHistoryEnabled", () => {
    it("is off unless the setting is switched on", () => {
      expect(replayToolHistoryEnabled(undefined, NO_ENV)).toBe(false);
      expect(replayToolHistoryEnabled({}, NO_ENV)).toBe(false);
      expect(replayToolHistoryEnabled({ replayToolHistory: false }, NO_ENV)).toBe(false);
      expect(replayToolHistoryEnabled(ON, NO_ENV)).toBe(true);
    });

    it("lets OMB_REPLAY_TOOL_HISTORY win over the file, both ways", () => {
      expect(replayToolHistoryEnabled(undefined, { OMB_REPLAY_TOOL_HISTORY: "1" })).toBe(true);
      expect(replayToolHistoryEnabled({ replayToolHistory: false }, { OMB_REPLAY_TOOL_HISTORY: "1" })).toBe(true);
      expect(replayToolHistoryEnabled(ON, { OMB_REPLAY_TOOL_HISTORY: "0" })).toBe(false);
      // anything else is not an answer: the file decides
      for (const value of ["", "true", "yes", "2"]) {
        expect(replayToolHistoryEnabled(ON, { OMB_REPLAY_TOOL_HISTORY: value })).toBe(true);
        expect(replayToolHistoryEnabled(undefined, { OMB_REPLAY_TOOL_HISTORY: value })).toBe(false);
      }
    });
  });

  describe("replayToolCalls", () => {
    const thread: Message[] = [
      ran("t0", "Bash", { summary: "ls" }),
      said("u1", "user", "run the tests"),
      ran("t1", "Bash", { summary: "pnpm test", ok: false }),
      // a harness chip, not a tool call: no provider item behind it
      { id: "n1", role: "bot", kind: "activity", tool: { name: "retrying — attempt 2/3 in 2s — overloaded", ok: true }, at: 1 },
      ran("t2", "Read"),
      said("a1", "bot", "They fail."),
      ran("t3", "Edit", { ok: undefined }),
    ];

    it("returns nothing while the setting is off", () => {
      expect(replayToolCalls(thread, undefined, NO_ENV)).toEqual([]);
      expect(replayToolCalls(thread, { replayToolHistory: false }, NO_ENV)).toEqual([]);
      expect(replayToolCalls(thread, ON, { OMB_REPLAY_TOOL_HISTORY: "0" })).toEqual([]);
    });

    it("lists each tool call after the message it followed, oldest first", () => {
      const expected: ReplayToolCall[] = [
        { afterId: "u1", text: "[ran: Bash: pnpm test — failed]" },
        { afterId: "u1", text: "[ran: Read — ok]" },
        { afterId: "a1", text: "[ran: Edit — no result recorded]" },
      ];
      // t0 ran before anything was said, so there is nothing to put it between
      expect(replayToolCalls(thread, ON, NO_ENV)).toEqual(expected);
      expect(replayToolCalls(thread, undefined, { OMB_REPLAY_TOOL_HISTORY: "1" })).toEqual(expected);
    });

    it("never turns a message that is itself context into a tool line", () => {
      // a teammate's returned report is an activity row with a chip AND
      // conversation context: it is replayed as the report, only
      const report: Message = {
        id: "r1", role: "bot", kind: "activity", roomRequest: { id: "h1", phase: "result" },
        tool: { name: "Clive replied", ok: true, itemId: "item-r1" }, at: 1,
      };
      expect(replayToolCalls([said("u1", "user", "ask Clive"), report, ran("t1", "Read")], ON, NO_ENV))
        .toEqual([{ afterId: "r1", text: "[ran: Read — ok]" }]);
    });
  });

  describe("selectReplay", () => {
    const line = (afterId: string, tag: string | number = afterId): ReplayToolCall => ({ afterId, text: `[ran: Read ${tag} — ok]` });

    it("puts each line back between the two messages it ran between", () => {
      const history = entries(["run the tests", "They fail.", "fix it", "Fixed."]);
      const tools = [
        { afterId: "0", text: "[ran: Bash: pnpm test — failed]" },
        { afterId: "0", text: "[ran: Read — ok]" },
        { afterId: "2", text: "[ran: Edit — ok]" },
      ];
      const result = selectReplay(history, { tools });
      expect(result.inline.map(entry => entry.text)).toEqual([
        "run the tests", "[ran: Bash: pnpm test — failed]", "[ran: Read — ok]", "They fail.", "fix it", "[ran: Edit — ok]", "Fixed.",
      ]);
      // harness lines: on the bot's side of the conversation, no message behind them
      expect(result.inline.filter(toolLine)).toEqual(tools.map(tool => ({ id: "", role: "assistant", text: tool.text })));
      // what a natively replaying driver is sent stays text only
      expect(result.transcript).toEqual(history);
      expect(result.representedIds).toEqual(history.map(entry => entry.id));
    });

    it("hands back the plain transcript when there is no tool history", () => {
      const history = entries(["one", "reply", "two"]);
      const plain = selectReplay(history);
      expect(plain.inline).toBe(plain.transcript);
      const empty = selectReplay(history, { tools: [] });
      expect(empty.inline).toBe(empty.transcript);
    });

    it("selects message content exactly as it does without tool history, at every budget", () => {
      const history = entries(Array.from({ length: 80 }, (_, i) => `${i} ${"long 你好 text ".repeat(i % 7 === 0 ? 50 : 3)}`));
      const tools = history.map(entry => line(entry.id));
      let placed = 0;
      for (const budgetBytes of [1_024, 1_500, 2_048, 4_096, 24_000, 1_000_000]) {
        for (const maxMessages of [1, 2, 3, 40, 100]) {
          const plain = selectReplay(history, { budgetBytes, maxMessages });
          const withTools = selectReplay(history, { budgetBytes, maxMessages, tools });
          const { inline, ...content } = withTools;
          const { inline: _plain, ...expected } = plain;
          expect(content).toEqual(expected);
          expect(inline.filter(entry => !toolLine(entry))).toEqual(plain.transcript);
          expect(inline.reduce((n, entry) => n + Buffer.byteLength(entry.text) + 16, 0)).toBeLessThanOrEqual(budgetBytes);
          expect(inline.filter(toolLine).length).toBeLessThanOrEqual(REPLAY_TOOL_LINE_CAP);
          placed += inline.filter(toolLine).length;
        }
      }
      expect(placed).toBeGreaterThan(0);
    });

    it("drops every tool line before it would cost a message", () => {
      // 8 × 112 = 896 = 1,024 − the 128 reserved: content alone fills the budget
      const history = entries(Array.from({ length: 8 }, () => sized(112)));
      const tools = history.slice(0, -1).map(entry => line(entry.id));
      const result = selectReplay(history, { budgetBytes: 1_024, tools });
      expect(result.transcript).toEqual(history);
      expect(result.inline).toEqual(history);
      expect(result.dropped).toBe(0);
    });

    it("spends only what content left over, on the most recent calls first", () => {
      // 8 × 96 = 768 of the 896 available: 128 spare, and each line below is
      // 20 bytes + 16 of framing, so three fit and a fourth would not
      const history = entries(Array.from({ length: 8 }, () => sized(96)));
      const tools = history.slice(0, -1).map(entry => line(entry.id));
      expect(Buffer.byteLength(tools[0]!.text) + 16).toBe(36);
      const result = selectReplay(history, { budgetBytes: 1_024, tools });
      expect(result.transcript).toEqual(history);
      expect(result.inline.filter(toolLine).map(entry => entry.text)).toEqual(["4", "5", "6"].map(id => line(id).text));
      expect(result.inline.map(entry => entry.id || entry.text)).toEqual([
        "0", "1", "2", "3", "4", line("4").text, "5", line("5").text, "6", line("6").text, "7",
      ]);
      expect(result.inline.reduce((n, entry) => n + Buffer.byteLength(entry.text) + 16, 0)).toBeLessThanOrEqual(1_024);
    });

    it(`keeps at most ${REPLAY_TOOL_LINE_CAP} lines, the most recent, and never fewer messages for it`, () => {
      const history = entries(["start", "done"]);
      const tools = Array.from({ length: 30 }, (_, i) => line("0", i));
      const result = selectReplay(history, { tools });
      expect(result.inline.filter(toolLine).map(entry => entry.text))
        .toEqual(Array.from({ length: REPLAY_TOOL_LINE_CAP }, (_, i) => line("0", i + 30 - REPLAY_TOOL_LINE_CAP).text));
      expect(result.transcript).toEqual(history);
    });

    it("keeps every message of the window however many tool calls sit between them", () => {
      // ten calls between every pair of 45 messages: 440 lines, far past the cap
      const history = entries(Array.from({ length: 45 }, (_, i) => `message ${i}`));
      const tools = history.slice(0, -1).flatMap(entry => Array.from({ length: 10 }, (_, i) => line(entry.id, `${entry.id}.${i}`)));
      const result = selectReplay(history, { tools });
      const plain = selectReplay(history);
      // the same 40 messages (and the same omission notice) as without them
      expect(result.transcript).toEqual(plain.transcript);
      expect(result.transcript.filter(entry => entry.id)).toHaveLength(40);
      expect(result.inline.filter(entry => !toolLine(entry))).toEqual(plain.transcript);
      expect(result.inline.filter(toolLine).map(entry => entry.text))
        .toEqual(tools.slice(-REPLAY_TOOL_LINE_CAP).map(tool => tool.text));
    });

    it("leaves out calls that ran before the first replayed message or after the last", () => {
      const history = entries(["dropped", "first kept", "last kept"]);
      const result = selectReplay(history, { maxMessages: 2, tools: [line("0", "before"), line("1", "inside"), line("2", "after")] });
      expect(result.inline.map(entry => entry.text)).toEqual([
        "[1 earlier messages omitted from this context; full history remains in the app.]",
        "first kept", line("1", "inside").text, "last kept",
      ]);
    });

    it("leaves out the calls of the very request being sent", () => {
      // a request run again in place: its own message is excluded, and the
      // calls its cut attempt made sit after everything that is replayed
      const history = entries(["question", "answer", "current request"]);
      const result = selectReplay(history, {
        excludedIds: new Set(["2"]), tools: [line("0", "earlier"), line("1", "trailing"), line("2", "cut attempt")],
      });
      expect(result.inline.map(entry => entry.text)).toEqual(["question", line("0", "earlier").text, "answer"]);
    });

    it("needs a message on both sides: a single replayed message gets no tool lines", () => {
      const result = selectReplay(entries(["only"]), { tools: [line("0")] });
      expect(result.inline).toBe(result.transcript);
    });

    it("leaves out calls a compaction folded away, and calls it cannot place", () => {
      const history = entries(["old", "old reply", "retained", "reply", ""]);
      const result = selectReplay(history, {
        tools: [line("0", "folded"), line("2", "kept"), line("gone", "unplaced")],
        compaction: { id: "4", firstKeptId: "2", foldedThroughId: "1", summary: "old summary", by: "harness", tokensBefore: 100 },
      });
      expect(result.compacted).toBe(2);
      expect(result.inline[0]!.text).toContain("old summary");
      expect(result.inline.slice(1).map(entry => entry.text)).toEqual(["retained", line("2", "kept").text, "reply"]);
    });
  });
});
