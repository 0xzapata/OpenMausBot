// Signatures: one failure, however many times and wherever it happens, is
// one issue. "no layer 12" and "no layer 104" differ only in a number, and
// the same missing file under two projects only in a path — so values are
// replaced with placeholders before hashing. The hash is what gets stored:
// the normalized text can still hold a name the person typed.
import { createHash } from "node:crypto";

import type { Origin } from "./types.ts";

const MAX_TEXT = 240;

/** Replace the parts of an error that vary between occurrences. */
export function normalizeSignatureText(text: string): string {
  return text
    // quoted values: "a.txt", 'Acme', `cmd` — not the apostrophe in "can't"
    .replace(/"[^"\n]*"|(?<![\w])'[^'\n]*'(?![\w])|`[^`\n]*`/g, "<q>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "<email>")
    .replace(/\b[A-Za-z]:\\[^\s:]+/g, "<path>")
    .replace(/(?:~|\.{1,2})?(?:\/[^\s/:'",)]+)+\/?/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    // hex ids and prefixed ids (tu-123-4, bx_9f2c…): letters and digits mixed
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b[a-z]{1,6}[_-](?=[\w-]*\d)[\w-]{4,}\b/gi, "<id>")
    .replace(/\b\d+(?:[.,:]\d+)*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

export function signatureOf(kind: string, ...parts: Array<string | undefined>): string {
  const hash = createHash("sha256").update(parts.map((part) => part ?? "").join("\n")).digest("hex");
  return `${kind}:${hash.slice(0, 16)}`;
}

// The MCP servers OpenMausBot itself provides (server/mcp-registry.ts keeps
// people from naming their own servers after them).
const HARNESS_SERVERS = new Set([
  "ogb", "computer", "agents", "composio", "data", "browser", "phone", "dweb",
  "openmausbot", "openmausbot_connectors", "openmausbot_phone",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "exec_command", "local_shell", "run_command", "terminal"]);

/** Who owns a tool, by its name. */
export function toolOrigin(tool: string): Origin {
  if (tool === HARNESS_NOTICE) return "harness";
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp) return HARNESS_SERVERS.has(mcp[1]!) ? "harness" : "external";
  return SHELL_TOOLS.has(tool.toLowerCase()) ? "shell" : "external";
}

export const HARNESS_NOTICE = "harness_notice";

/** A tool identifier is one word (`Bash`, `mcp__agents__send`); anything
 * else in an activity row's name is a sentence the harness wrote, which can
 * carry a bot's name and is never kept as the tool. */
export function isToolIdentifier(name: string): boolean {
  return /^[\w.:/-]{1,128}$/.test(name);
}
