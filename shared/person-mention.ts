// The person's own tag. Bots in a room address each other with @Name; this
// is how they address the human: `@you` always, and `@<profile name>` when
// the person has set one. One matcher for the renderer (coloring) and the
// server (the "mentioned you" notification), so what is colored is exactly
// what buzzes.
import { isMentionBoundary, isMentionNameContinuation } from "./mention-boundary.ts";

/** The built-in tag for the person. Needs no settings. */
export const PERSON_TAG = "you";

/** Tags that already mean something else and never name the person. */
const RESERVED = new Set(["everyone", "all"]);

/** The names that tag the person: `you`, plus their profile name if set. */
export function personTagNames(profileName?: string | null): string[] {
  const name = profileName?.replace(/^@+/, "").replace(/\s+/g, " ").trim() ?? "";
  const folded = name.toLowerCase();
  return name && folded !== PERSON_TAG && !RESERVED.has(folded) ? [PERSON_TAG, name] : [PERSON_TAG];
}

/** Whether the text right after an `@` is exactly this name as a whole tag. */
function tagMatches(rest: string, name: string): boolean {
  return rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
    && !isMentionNameContinuation(rest.slice(name.length));
}

/** Length of the person tag starting right after an `@`, or undefined.
 * A bot name wins: the person's tag counts only when it is strictly longer
 * than every bot name that matches here, so a bot called "You" (or one that
 * shares the person's name) keeps its own mentions. */
export function personTagAt(rest: string, personNames: readonly string[], botNames: readonly string[]): number | undefined {
  const bot = Math.max(0, ...botNames.filter((name) => name.trim() && tagMatches(rest, name)).map((name) => name.length));
  const person = Math.max(0, ...personNames.filter((name) => tagMatches(rest, name)).map((name) => name.length));
  return person > bot ? person : undefined;
}

export interface PersonTagOptions {
  profileName?: string | null;
  /** Visible bot names in this conversation: they win a name collision. */
  botNames?: readonly string[];
}

/** Every person tag in the text, as offsets of the `@` through the name. */
export function personMentionRanges(text: string, options: PersonTagOptions = {}): { start: number; end: number }[] {
  const personNames = personTagNames(options.profileName);
  const botNames = options.botNames ?? [];
  const ranges: { start: number; end: number }[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const length = personTagAt(text.slice(at + 1), personNames, botNames);
    if (length === undefined) continue;
    ranges.push({ start: at, end: at + length + 1 });
    at += length;
  }
  return ranges;
}

/** Blank out fenced code blocks, keeping offsets. A fence opens with three
 * or more backticks or tildes and closes only on a line of the same
 * character at least as long; an unclosed fence runs to the end. */
function maskFences(text: string): string {
  let open: { char: string; length: number } | null = null;
  return text.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!open) {
      if (!marker || (marker[0] === "`" && line.slice(line.indexOf(marker) + marker.length).includes("`"))) return line;
      open = { char: marker[0]!, length: marker.length };
    } else if (marker && marker[0] === open.char && marker.length >= open.length && !line.trim().slice(marker.length).trim()) {
      open = null;
    }
    return " ".repeat(line.length);
  }).join("\n");
}

/** The line that carries the first person tag, or its paragraph when the
 * line alone says little ("@you" on its own line, above the question).
 * Null when the text does not tag the person. Code fences never count:
 * a tag quoted in code is not addressed to anyone. */
export function personMentionExcerpt(text: string, options: PersonTagOptions = {}): string | null {
  // Code spans close on a backtick run of exactly the opening length and
  // may cross line endings (CommonMark), so "``a @you b``" is code too.
  const prose = maskFences(text).replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (code) => code.replace(/[^\n]/g, " "));
  const hit = personMentionRanges(prose, options)[0];
  if (!hit) return null;
  const lineStart = text.lastIndexOf("\n", hit.start) + 1;
  const lineEnd = text.indexOf("\n", hit.end);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
  const withoutTag = line.replace(text.slice(hit.start, hit.end), "").replace(/[\s\p{P}]+/gu, "");
  if (withoutTag.length >= 12) return line;
  const before = text.slice(0, hit.start).search(/\n\s*\n(?![\s\S]*\n\s*\n)/);
  const paraStart = before === -1 ? 0 : before;
  const after = text.slice(hit.end).search(/\n\s*\n/);
  return text.slice(paraStart, after === -1 ? undefined : hit.end + after).trim();
}
