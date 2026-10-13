// Signatures: one failure, however many times and wherever it happens, is
// one issue. "no layer 12" and "no layer 104" differ only in a number, and
// the same missing file under two projects only in a path — so values are
// replaced with placeholders before hashing. The hash is the issue's
// identity and the only form that may ever leave the machine; the
// normalized text is kept beside it as a local title, because it can still
// hold a name the person typed.
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

const MAX_TITLE = 160;

/** A title as kept: never longer than MAX_TITLE, whatever was put in front. */
export function capTitle(title: string): string {
  return title.slice(0, MAX_TITLE);
}

// What a failed shell command amounts to, whatever it printed. Its output
// names the files and commands of the work in hand, so two runs of the same
// mistake rarely print the same text; the class and exit code still match.
const SHELL_ERROR_CLASSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btimed?[ -]?out\b|\btimeout\b/i, "timed out"],
  [/command not found|is not recognized as an internal or external command/i, "command not found"],
  [/syntax error|unexpected token|unexpected EOF|parse error/i, "syntax error"],
  [/no such file or directory|\bENOENT\b|cannot find the path/i, "no such file"],
  [/permission denied|\bEACCES\b/i, "permission denied"],
  [/operation not permitted|\bEPERM\b/i, "operation not permitted"],
  [/connection refused|could not resolve host|network is unreachable|\bECONNREFUSED\b|\bENOTFOUND\b/i, "network error"],
  [/out of memory|cannot allocate memory|\bENOMEM\b/i, "out of memory"],
  [/\bkilled\b|\bSIGKILL\b|\bSIGTERM\b|terminated by signal/i, "killed"],
  [/user (?:rejected|denied|doesn't want)|was denied|not allowed/i, "denied"],
];
const EXIT_CODE = /\bexit(?:ed with)?(?: code| status)?\s*[:=]?\s*(-?\d+)/i;

/** What groups a failure into an issue (`key`, hashed into the signature)
 * and the readable line kept with the issue (`title`, local only). A shell
 * command groups by exit code and error class; anything else by its whole
 * normalized error. */
export function failureKey(tool: string, text: string): { key: string; title: string } {
  if (toolOrigin(tool) === "shell") {
    const errorClass = SHELL_ERROR_CLASSES.find(([pattern]) => pattern.test(text))?.[1];
    // a timeout's exit code is whichever signal stopped it
    const code = errorClass === "timed out" ? undefined : EXIT_CODE.exec(text)?.[1];
    const title = [code !== undefined ? `exit ${code}` : null, errorClass ?? (code === undefined ? "failed" : null)].filter(Boolean).join(": ");
    return { key: `${code ?? ""}\n${errorClass ?? ""}`, title: capTitle(title) };
  }
  const normalized = normalizeSignatureText(text);
  return { key: normalized, title: capTitle(normalized) || "failed" };
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
