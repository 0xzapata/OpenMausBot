// docs/analytics.md is the promise of what the app sends: every product event the app can send is listed there.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const EVENT = /\b(?:track|capture)\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g;

function sentEvents(): string[] {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes(".test."));
  const events = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(new URL(file, ROOT), "utf8").matchAll(EVENT)) events.add(match[1]!);
  }
  return [...events].sort();
}

describe("docs/analytics.md", () => {
  it("lists every event the app sends", () => {
    const events = sentEvents();
    expect(events).toEqual(expect.arrayContaining(["app_opened", "app_snapshot", "api_key_saved", "message_sent", "email_submitted"]));
    const docs = readFileSync(new URL("docs/analytics.md", ROOT), "utf8");
    expect(events.filter((event) => !docs.includes(`\`${event}\``)), "Add each event to docs/analytics.md").toEqual([]);
  });
});
