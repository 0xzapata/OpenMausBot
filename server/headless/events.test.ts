// The event stream as JSON lines: which frames a filter keeps, and the
// server-sent events read out of a byte stream however it is chunked.
import { describe, expect, it } from "vitest";

import { DEFAULT_EVENT_KINDS, frameThreads, sseFrames, wantFrame } from "./events.ts";

const kinds = new Set(DEFAULT_EVENT_KINDS);

describe("which frames are printed", () => {
  it("knows the conversations a frame is about", () => {
    expect(frameThreads({ kind: "message", threadId: "t1" })).toEqual(["t1"]);
    expect(frameThreads({ kind: "runtime", event: { threadId: "t2" } })).toEqual(["t2"]);
    expect(frameThreads({ kind: "bot", bot: { threadId: "t3", tasks: [{ threadId: "t4" }] } })).toEqual(["t3", "t4"]);
    expect(frameThreads({ kind: "group", group: { threadId: "r1", tasks: [{ threadId: "r2" }] } })).toEqual(["r1", "r2"]);
    expect(frameThreads({ kind: "config" })).toEqual([]);
  });

  it("prints hello always, never pings, and otherwise filters by kind and conversation", () => {
    const threads = new Set(["t1"]);
    expect(wantFrame({ kind: "hello", resumed: false }, kinds, threads)).toBe(true);
    expect(wantFrame({ kind: "ping" }, kinds, null)).toBe(false);
    expect(wantFrame({ kind: "message", threadId: "t1" }, kinds, threads)).toBe(true);
    expect(wantFrame({ kind: "message", threadId: "t9" }, kinds, threads)).toBe(false);
    expect(wantFrame({ kind: "message", threadId: "t9" }, kinds, null)).toBe(true);
    expect(wantFrame({ kind: "bot", bot: { threadId: "t0", tasks: [{ threadId: "t1" }] } }, kinds, threads)).toBe(true);
    // token-level events only when asked for
    expect(wantFrame({ kind: "runtime", event: { threadId: "t1" } }, kinds, threads)).toBe(false);
    expect(wantFrame({ kind: "runtime", event: { threadId: "t1" } }, new Set(["runtime"]), threads)).toBe(true);
  });
});

describe("sseFrames", () => {
  it("reads id and data across chunks, skipping comments and heartbeats without data", async () => {
    const text = ': keepalive\n\nid: s1:7\ndata: {"kind":"message","threadId":"t1"}\n\ndata: {"kind":"ping"}\n\nid: s1:8\r\ndata: {"kind":"thread",\r\ndata: "threadId":"t2"}\r\n\r\n';
    const bytes = new TextEncoder().encode(text);
    async function* chunks() { for (let i = 0; i < bytes.length; i += 5) yield bytes.slice(i, i + 5); }
    const frames = [];
    for await (const frame of sseFrames(chunks())) frames.push(frame);
    expect(frames).toEqual([
      { id: "s1:7", data: '{"kind":"message","threadId":"t1"}' },
      { data: '{"kind":"ping"}' },
      { id: "s1:8", data: '{"kind":"thread",\n"threadId":"t2"}' },
    ]);
  });
});
