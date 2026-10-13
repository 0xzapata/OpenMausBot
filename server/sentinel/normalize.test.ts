import { describe, expect, it } from "vitest";

import { HARNESS_NOTICE, isToolIdentifier, normalizeSignatureText, signatureOf, toolOrigin } from "./normalize.ts";

describe("sentinel signatures", () => {
  it("folds errors that differ only in values into one signature", () => {
    expect(normalizeSignatureText("no layer 90")).toBe(normalizeSignatureText("no layer 104"));
    expect(normalizeSignatureText("no layer 12")).toBe("no layer <n>");
    expect(normalizeSignatureText("ENOENT: no such file, open '/path/to/project/a.txt'")).toBe(normalizeSignatureText("ENOENT: no such file, open '/elsewhere/b.txt'"));
    expect(normalizeSignatureText("cannot read /path/to/project/notes.md: denied")).toBe("cannot read <path>: denied");
    expect(normalizeSignatureText("C:\\work\\file.txt is locked")).toBe("<path> is locked");
    expect(normalizeSignatureText('unknown client "Example Co"')).toBe("unknown client <q>");
    expect(normalizeSignatureText("thread 3f2b9c1e-0a4d-4c2e-9b1f-7d6e5c4b3a21 is gone")).toBe("thread <id> is gone");
    expect(normalizeSignatureText("commit 9f2c4e1ab07d failed")).toBe("commit <id> failed");
    expect(normalizeSignatureText("call tu-4821-7 timed out after 30.5 s")).toBe("call <id> timed out after <n> s");
    expect(normalizeSignatureText("see https://example.com/a?b=1 or mail someone@example.com")).toBe("see <url> or mail <email>");
    // an apostrophe is not a quote, and the words around it stay
    expect(normalizeSignatureText("can't reach the room,   it's busy")).toBe("can't reach the room, it's busy");
    expect(normalizeSignatureText("x".repeat(1000)).length).toBe(240);
  });

  it("hashes the normalized parts, so the signature never holds the text", () => {
    const sig = signatureOf("tool_error", "mcp__agents__send", "no client named <q>");
    expect(sig).toMatch(/^tool_error:[0-9a-f]{16}$/);
    expect(signatureOf("tool_error", "Bash", "no client named <q>")).not.toBe(sig);
    expect(signatureOf("tool_error", "mcp__agents__send", "no client named <q>")).toBe(sig);
  });

  it("ranks OpenMausBot's own tools as harness, shells as shell, everything else as external", () => {
    expect(toolOrigin("mcp__agents__coordinate_bots")).toBe("harness");
    expect(toolOrigin("mcp__computer__screenshot")).toBe("harness");
    expect(toolOrigin(HARNESS_NOTICE)).toBe("harness");
    expect(toolOrigin("Bash")).toBe("shell");
    expect(toolOrigin("exec_command")).toBe("shell");
    expect(toolOrigin("mcp__linear__create_issue")).toBe("external");
    expect(toolOrigin("Read")).toBe("external");
  });

  it("tells a tool identifier from a sentence the harness wrote", () => {
    expect(isToolIdentifier("mcp__agents__send")).toBe(true);
    expect(isToolIdentifier("Bash")).toBe(true);
    expect(isToolIdentifier("Probe's room turn exceeded 20 minutes and was stopped")).toBe(false);
  });
});
