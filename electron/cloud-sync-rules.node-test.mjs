import assert from "node:assert/strict";
import test from "node:test";
import { clashPath, foldKey, safeFolderName, skipped, validWirePath, windowsProblem } from "./cloud-sync-rules.mjs";

test("skips build folders, system litter, lock and temporary files, and sync's own downloads", () => {
  for (const dir of ["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", ".cache"]) assert.equal(skipped(dir, true), true, dir);
  assert.equal(skipped("src", true), false);
  for (const file of [".DS_Store", "Thumbs.db", "desktop.ini", "~$port.docx", "draft.tmp", "movie.crdownload", "a.part", ".~lock.sheet.ods#", ".Report.docx.omb-sync-1a2b3c4d"]) {
    assert.equal(skipped(file, false), true, file);
  }
  assert.equal(skipped("Report.docx", false), false);
  assert.equal(skipped("node_modules", false), false, "only a directory by that name is skipped");
});

test("a wire path is relative, slash-separated and NFC", () => {
  for (const good of ["a.txt", "a/b.txt", "Café/x.md"]) assert.equal(validWirePath(good), true, good);
  for (const bad of ["", "/a", "a//b", "a/./b", "../a", "a/..", "a\\b", "a\0b", "Café.txt", 7, null]) assert.equal(validWirePath(bad), false, String(bad));
});

test("names a Windows PC cannot hold", () => {
  assert.equal(windowsProblem("a/b:c.txt"), "characters");
  assert.equal(windowsProblem("notes./x"), "trailing");
  assert.equal(windowsProblem("notes /x"), "trailing");
  assert.equal(windowsProblem("CON.txt"), "reserved");
  assert.equal(windowsProblem("x/lpt9"), "reserved");
  assert.equal(windowsProblem("Reports/Q3.xlsx"), null);
});

test("case and Unicode form fold together", () => {
  assert.equal(foldKey("Café/A.txt"), foldKey("café/a.TXT"));
  assert.notEqual(foldKey("a.txt"), foldKey("b.txt"));
});

test("a clash copy is named for the PC and the day, then numbered", () => {
  const at = new Date(2026, 9, 15, 12).getTime();
  assert.equal(clashPath("docs/report.docx", at, () => false), "docs/report (PC copy, 15 Oct 2026).docx");
  const taken = new Set(["docs/report (PC copy, 15 Oct 2026).docx"]);
  assert.equal(clashPath("docs/report.docx", at, (path) => taken.has(path)), "docs/report (PC copy, 15 Oct 2026 2).docx");
  assert.equal(clashPath("Makefile", at, () => false), "Makefile (PC copy, 15 Oct 2026)");
  assert.equal(clashPath(".env", at, () => false), ".env (PC copy, 15 Oct 2026)");
  assert.equal(clashPath("a.txt", at, () => false, "restored"), "a (restored, 15 Oct 2026).txt");
});

test("folder names both Windows and macOS hold, without clashing", () => {
  assert.equal(safeFolderName("Q3: plan?", new Set()), "Q3- plan-");
  assert.equal(safeFolderName("notes. ", new Set()), "notes");
  assert.equal(safeFolderName("CON", new Set()), "CON_");
  assert.equal(safeFolderName("   ", new Set()), "Untitled");
  assert.equal(safeFolderName("Research", new Set(["research"])), "Research (2)");
  assert.equal(safeFolderName("Research", new Set(["research", "research (2)"])), "Research (3)");
});
