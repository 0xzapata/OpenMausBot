// What a headless verb prints. With --json, stdout carries exactly one JSON
// document, errors included ({ ok: false, error, hint, exitCode }); without
// it, plain lines. Progress goes to stderr as compact JSON lines, dropped by
// --quiet. Every string printed, in either mode, passes through the same
// secret redaction the transcript uses (shared/redact.ts).
import { redactSecretsInText } from "../../shared/redact.ts";
import type { HeadlessError } from "./args.ts";

export interface HeadlessIo {
  /** One write to stdout (a newline is added). */
  out(text: string): void;
  /** One write to stderr (a newline is added). */
  err(text: string): void;
  /** All of stdin, for `-` in place of a message. */
  readStdin(): Promise<string>;
}

export function processIo(): HeadlessIo {
  return {
    out: (text) => { process.stdout.write(`${text}\n`); },
    err: (text) => { process.stderr.write(`${text}\n`); },
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

/** Every string inside a value, redacted; the shape is kept. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecretsInText(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)])) as T;
  }
  return value;
}

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  private readonly io: HeadlessIo;

  constructor(io: HeadlessIo, mode: { json?: boolean; quiet?: boolean }) {
    this.io = io;
    this.json = mode.json === true;
    this.quiet = mode.quiet === true;
  }

  /** A progress event: one compact JSON line on stderr. */
  progress(event: Record<string, unknown>): void {
    if (!this.quiet) this.io.err(JSON.stringify(redactDeep(event)));
  }

  /** The verb's answer: one JSON document, or the human lines. */
  result(value: unknown, human: readonly string[]): void {
    if (this.json) this.io.out(JSON.stringify(redactDeep(value), null, 2));
    else for (const line of human) this.io.out(redactSecretsInText(line));
  }

  /** Why the verb failed, and what to do. */
  error(error: HeadlessError): void {
    const body = { ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}), exitCode: error.exitCode };
    if (this.json) this.io.out(JSON.stringify(redactDeep(body), null, 2));
    else {
      this.io.err(redactSecretsInText(`error: ${error.message}`));
      if (error.hint) this.io.err(redactSecretsInText(`hint: ${error.hint}`));
    }
  }
}

/** A short, fixed-width view of an id for human lines. */
export const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** Text as one line, cut to a length. */
export const oneLine = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
