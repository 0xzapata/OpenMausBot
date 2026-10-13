// The browser step store: one line per recorded browser step, and its
// screenshot, kept with the conversation the step happened in.
//
//   DATA_DIR/evidence/<threadId>/<generation>/steps.jsonl
//   DATA_DIR/evidence/<threadId>/<generation>/step-001042.jpg
//   DATA_DIR/evidence/state.json   {"nextStep": 1101}
//
// Folders are 0700 and files 0600. A step number is unique across the whole
// instance, so a report can cite "step 1042" whichever bot took it. The
// folder goes when its conversation is deleted, after 30 days, or when a
// workspace backup is made (never: evidence is excluded). Screenshots stop,
// and the steps carry on without them, when a conversation holds 200 MB, all
// evidence holds the smaller of 2 GB and a quarter of the free space, or the
// disk has less than 1 GB free; the oldest other conversations' screenshots
// are evicted first. Steps themselves stop once a conversation's step lines
// reach 50 MB (some 55,000 steps), so a bot stuck in a loop cannot fill the
// disk. The exported tar is the copy that lasts.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { open, readFile, stat, statfs as statfsAsync } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Writable } from "node:stream";

import { Header } from "tar";

import { writeFileAtomic } from "./atomic.ts";

/** One recorded step (schema v1), as browser-steps.ts writes it. */
export interface StepRecord {
  v: 1;
  step: number;
  at: number;
  threadId: string;
  generation: string;
  /** The screenshot's file name in the generation folder, or the earlier
   * one this step's screenshot repeats (sameAsStep); null: none taken. */
  image: string | null;
  sha256?: string;
  bytes?: number;
  sameAsStep?: number | null;
  imageSkipped?: string | null;
  [field: string]: unknown;
}

export const EVIDENCE_LIMITS = {
  imageBytes: 1_500_000,
  threadBytes: 200 * 1024 * 1024,
  threadStepBytes: 50 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  freeShare: 0.25,
  freeFloor: 1024 * 1024 * 1024,
  retentionMs: 30 * 24 * 60 * 60_000,
  sweepMs: 60 * 60_000,
  stepBlock: 100,
} as const;

const THREAD_ID = /^[\w-]{1,128}$/u;
const GENERATION = /^[A-Za-z0-9-]{8,64}$/u;
const IMAGE_FILE = /^step-\d{6,12}\.jpg$/u;
const STEPS_FILE = "steps.jsonl";

type Statfs = (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

export interface EvidenceDeps {
  /** Store changes: a deleted conversation takes its evidence with it. */
  onChange(listener: (change: { type: string; threadId?: string }) => void): () => void;
  /** Whether a conversation exists, for the sweep of folders left behind. */
  threadExists(threadId: string): boolean;
}

export function imageFileName(step: number): string {
  return `step-${String(step).padStart(6, "0")}.jpg`;
}

function directories(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return []; }
}

function size(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function modified(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function files(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

export class BrowserEvidence {
  readonly root: string;
  private statfs: Statfs;
  private now: () => number;
  private counter: { next: number; reserved: number } | null = null;
  /** Screenshot bytes per conversation, read from disk on first use. */
  private threadBytes = new Map<string, number>();
  /** Step-line bytes per conversation, read from disk on first use. */
  private stepBytes = new Map<string, number>();
  /** All screenshot bytes; unknown until the first sweep has measured them. */
  private totalBytes: number | null = null;
  private budget = { cap: EVIDENCE_LIMITS.totalBytes as number, low: false };
  /** Each generation's last screenshot, so an unchanged page is stored once. */
  private lastImage = new Map<string, { step: number; file: string; sha256: string }>();
  /** Generations written by this process recently: never evicted. */
  private active = new Map<string, number>();
  private deps: EvidenceDeps | null = null;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private sweeping: Promise<void> | null = null;

  constructor(options: { root: string; statfs?: Statfs; now?: () => number }) {
    this.root = options.root;
    this.statfs = options.statfs ?? statfsAsync;
    this.now = options.now ?? Date.now;
  }

  /** Start keeping the store tidy: deleted conversations, the boot sweep
   * of folders whose conversation is gone, and the hourly sweep. */
  attach(deps: EvidenceDeps): this {
    this.deps = deps;
    this.unsubscribe?.();
    this.unsubscribe = deps.onChange((change) => {
      if (change.type === "thread.deleted" && change.threadId) this.removeThread(change.threadId);
    });
    void this.sweep();
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.sweep(); }, EVIDENCE_LIMITS.sweepMs);
    this.timer.unref?.();
    return this;
  }

  detach(): void {
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.deps = null;
  }

  private ensureDir(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }

  /** The next step number, unique across this instance and its restarts:
   * numbers are reserved on disk a block at a time. */
  nextStep(): number {
    if (!this.counter) {
      let saved = 1;
      try {
        const value = (JSON.parse(readFileSync(join(this.root, "state.json"), "utf8")) as { nextStep?: unknown }).nextStep;
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) saved = value;
      } catch { /* first step */ }
      this.counter = { next: saved, reserved: saved };
    }
    if (this.counter.next >= this.counter.reserved) {
      this.counter.reserved = this.counter.next + EVIDENCE_LIMITS.stepBlock;
      try {
        this.ensureDir(this.root);
        writeFileAtomic(join(this.root, "state.json"), `${JSON.stringify({ nextStep: this.counter.reserved })}\n`, { mode: 0o600 });
      } catch { /* numbers stay unique in this run */ }
    }
    return this.counter.next++;
  }

  private threadSize(threadId: string): number {
    let bytes = this.threadBytes.get(threadId);
    if (bytes === undefined) {
      bytes = 0;
      const dir = join(this.root, threadId);
      for (const generation of directories(dir)) {
        for (const name of files(join(dir, generation))) {
          if (IMAGE_FILE.test(name)) bytes += size(join(dir, generation, name));
        }
      }
      this.threadBytes.set(threadId, bytes);
    }
    return bytes;
  }

  private threadStepSize(threadId: string): number {
    let bytes = this.stepBytes.get(threadId);
    if (bytes === undefined) {
      bytes = 0;
      const dir = join(this.root, threadId);
      for (const generation of directories(dir)) bytes += size(join(dir, generation, STEPS_FILE));
      this.stepBytes.set(threadId, bytes);
    }
    return bytes;
  }

  /** Whether a conversation takes another step: its step lines stay under
   * their cap. Asked before a step is numbered or pictured. */
  accepts(threadId: string): boolean {
    return THREAD_ID.test(threadId) && this.threadStepSize(threadId) < EVIDENCE_LIMITS.threadStepBytes;
  }

  /** Where this step's screenshot may be written, created empty and 0600 so
   * the engine's write keeps that mode; or why no screenshot is taken. */
  imageTarget(threadId: string, generation: string, step: number): { path: string } | { skipped: string } {
    if (!THREAD_ID.test(threadId) || !GENERATION.test(generation)) return { skipped: "capture-failed" };
    if (this.budget.low) return { skipped: "disk-low" };
    if (this.threadSize(threadId) >= EVIDENCE_LIMITS.threadBytes) return { skipped: "thread-cap" };
    if (this.totalBytes !== null && this.totalBytes >= this.budget.cap) {
      this.evict(threadId);
      if (this.totalBytes >= this.budget.cap) return { skipped: "global-cap" };
    }
    const dir = join(this.root, threadId, generation);
    const path = join(dir, imageFileName(step));
    try {
      this.ensureDir(dir);
      closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    } catch { return { skipped: "capture-failed" }; }
    this.active.set(`${threadId}/${generation}`, this.now());
    return { path };
  }

  /** Write a step: its screenshot checked (non-empty, at most 1.5 MB,
   * hashed, stored once when it repeats the previous one), then its line. */
  async commit(record: StepRecord, imagePath: string | null): Promise<StepRecord> {
    const { threadId, generation } = record;
    if (!THREAD_ID.test(threadId) || !GENERATION.test(generation)) throw new Error("Invalid evidence location.");
    if (!this.accepts(threadId)) throw new Error("This conversation keeps no more browser steps.");
    const out: StepRecord = { ...record, image: null };
    if (imagePath) {
      const drop = (reason: string) => { try { unlinkSync(imagePath); } catch { /* already gone */ } out.imageSkipped = reason; };
      const bytes = await stat(imagePath).then((value) => value.size, () => 0);
      if (bytes === 0) drop("capture-failed");
      else if (bytes > EVIDENCE_LIMITS.imageBytes) drop("too-large");
      else {
        const sha256 = createHash("sha256").update(await readFile(imagePath)).digest("hex");
        const key = `${threadId}/${generation}`;
        const previous = this.lastImage.get(key);
        if (previous?.sha256 === sha256) {
          try { unlinkSync(imagePath); } catch { /* already gone */ }
          Object.assign(out, { image: previous.file, sha256, sameAsStep: previous.step });
        } else {
          const file = imagePath.slice(imagePath.lastIndexOf("step-"));
          Object.assign(out, { image: file, sha256, bytes, sameAsStep: null });
          this.lastImage.set(key, { step: record.step, file, sha256 });
          this.threadBytes.set(threadId, this.threadSize(threadId) + bytes);
          if (this.totalBytes !== null) this.totalBytes += bytes;
        }
      }
    }
    const dir = join(this.root, threadId, generation);
    this.ensureDir(dir);
    const line = `${JSON.stringify(out)}\n`;
    appendFileSync(join(dir, STEPS_FILE), line, { mode: 0o600 });
    this.stepBytes.set(threadId, this.threadStepSize(threadId) + Buffer.byteLength(line));
    this.active.set(`${threadId}/${generation}`, this.now());
    return out;
  }

  /** Every step of a conversation, or of one of its generations, in step
   * order: each step file read once. */
  private readSteps(threadId: string, generation?: string): StepRecord[] {
    if (!THREAD_ID.test(threadId)) return [];
    const dir = join(this.root, threadId);
    const generations = generation !== undefined ? (GENERATION.test(generation) ? [generation] : []) : directories(dir);
    const steps: StepRecord[] = [];
    for (const name of generations) {
      let text = "";
      try { text = readFileSync(join(dir, name, STEPS_FILE), "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const step = JSON.parse(line) as StepRecord;
          if (typeof step.step === "number" && step.generation === name) steps.push(step);
        } catch { /* a torn last line */ }
      }
    }
    return steps.sort((a, b) => a.step - b.step);
  }

  /** A step with its screenshot's URL, or why the screenshot is gone. */
  private withImageUrl(threadId: string, step: StepRecord): StepRecord & { imageUrl: string | null; imageGone?: "evicted" } {
    if (!step.image || !IMAGE_FILE.test(step.image)) return { ...step, imageUrl: null };
    return this.imageFile(threadId, step.generation, step.image) !== null
      ? { ...step, imageUrl: `/api/threads/${threadId}/evidence/${step.generation}/${step.image}` }
      : { ...step, imageUrl: null, imageGone: "evicted" as const };
  }

  /** A conversation's steps in step order, `after` a step number, with each
   * screenshot's URL, or why it is gone. */
  list(threadId: string, options: { generation?: string; after?: number; limit?: number } = {}): { steps: Array<StepRecord & { imageUrl: string | null; imageGone?: "evicted" }>; nextAfter: number | null } {
    const limit = Math.min(500, Math.max(1, options.limit ?? 200));
    const after = options.after ?? 0;
    const steps = this.readSteps(threadId, options.generation || undefined).filter((step) => step.step > after);
    const page = steps.slice(0, limit);
    return { steps: page.map((step) => this.withImageUrl(threadId, step)), nextAfter: steps.length > limit ? page.at(-1)!.step : null };
  }

  /** A screenshot's path, only for well-formed names of a regular file
   * inside the store (no symbolic links, nothing outside the root). */
  imageFile(threadId: string, generation: string, file: string): string | null {
    if (!THREAD_ID.test(threadId) || !GENERATION.test(generation) || !IMAGE_FILE.test(file)) return null;
    const path = join(this.root, threadId, generation, file);
    try {
      if (!lstatSync(path).isFile()) return null;
      const real = realpathSync(path);
      const inside = relative(realpathSync(this.root), real);
      return inside && !inside.startsWith("..") && !isAbsolute(inside) ? real : null;
    } catch { return null; }
  }

  /** The conversation's evidence as one tar: `index.json` (every step, each
   * screenshot by its path in the archive) and the screenshots, regular
   * files only, under POSIX paths. */
  async exportTar(threadId: string, out: Writable): Promise<void> {
    // One read of every step file: paging through list() re-read them all for
    // each 500 steps, a long stall of the server for a big conversation.
    const all = this.readSteps(threadId).map((step) => this.withImageUrl(threadId, step));
    const files = new Map<string, string>();
    const steps = all.map((step) => {
      const { imageUrl: _url, ...rest } = step as StepRecord & { imageUrl?: unknown };
      const path = step.image ? this.imageFile(threadId, step.generation, step.image) : null;
      if (path) files.set(`${step.generation}/${step.image}`, path);
      return { ...rest, image: path ? `${step.generation}/${step.image}` : null };
    });
    const write = (chunk: Buffer) => new Promise<void>((resolve, reject) => {
      if (out.destroyed || out.writableEnded) { reject(new Error("The download was closed.")); return; }
      if (out.write(chunk)) { resolve(); return; }
      const settle = (error?: Error) => { out.off("drain", settle); out.off("close", closed); if (error) reject(error); else resolve(); };
      const closed = () => settle(new Error("The download was closed."));
      out.once("drain", settle);
      out.once("close", closed);
    });
    const entry = async (path: string, body: Buffer | { file: string; size: number }, mtime: Date) => {
      const bytes = Buffer.isBuffer(body) ? body.length : body.size;
      const block = Buffer.alloc(512);
      new Header({ path, type: "File", size: bytes, mode: 0o600, mtime }).encode(block);
      await write(block);
      if (Buffer.isBuffer(body)) await write(body);
      else {
        const handle = await open(body.file, "r");
        try {
          let left = body.size;
          const chunk = Buffer.alloc(64 * 1024);
          while (left > 0) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, left));
            if (!bytesRead) break;
            await write(Buffer.from(chunk.subarray(0, bytesRead)));
            left -= bytesRead;
          }
          if (left > 0) await write(Buffer.alloc(left));
        } finally { await handle.close(); }
      }
      if (bytes % 512) await write(Buffer.alloc(512 - (bytes % 512)));
    };
    const index = Buffer.from(`${JSON.stringify({ v: 1, threadId, exportedAt: this.now(), steps }, null, 1)}\n`);
    await entry("index.json", index, new Date(this.now()));
    for (const [name, path] of files) {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      await entry(name, { file: path, size: info.size }, info.mtime);
    }
    await write(Buffer.alloc(1024));
  }

  /** Delete a conversation's evidence. */
  removeThread(threadId: string): void {
    if (!THREAD_ID.test(threadId)) return;
    const bytes = this.threadSize(threadId);
    try { rmSync(join(this.root, threadId), { recursive: true, force: true }); } catch { /* the sweep retries */ }
    this.threadBytes.delete(threadId);
    this.stepBytes.delete(threadId);
    for (const key of [...this.lastImage.keys(), ...this.active.keys()]) {
      if (key.startsWith(`${threadId}/`)) { this.lastImage.delete(key); this.active.delete(key); }
    }
    if (this.totalBytes !== null) this.totalBytes = Math.max(0, this.totalBytes - bytes);
  }

  /** Remove screenshots of the oldest generations, never one being written
   * now or `keep`'s, until all evidence fits its cap. Their steps stay. */
  private evict(keep: string | null): void {
    if (this.totalBytes === null || this.totalBytes < this.budget.cap) return;
    const recent = this.now() - 10 * 60_000;
    const candidates: Array<{ thread: string; generation: string; at: number }> = [];
    for (const thread of directories(this.root)) {
      if (thread === keep) continue;
      for (const generation of directories(join(this.root, thread))) {
        if ((this.active.get(`${thread}/${generation}`) ?? 0) > recent) continue;
        candidates.push({ thread, generation, at: modified(join(this.root, thread, generation)) });
      }
    }
    candidates.sort((a, b) => a.at - b.at);
    for (const candidate of candidates) {
      if (this.totalBytes < this.budget.cap) break;
      const dir = join(this.root, candidate.thread, candidate.generation);
      let freed = 0;
      for (const name of files(dir)) {
        if (!IMAGE_FILE.test(name)) continue;
        const bytes = size(join(dir, name));
        try { unlinkSync(join(dir, name)); freed += bytes; } catch { /* still there */ }
      }
      this.lastImage.delete(`${candidate.thread}/${candidate.generation}`);
      this.totalBytes = Math.max(0, this.totalBytes - freed);
      const before = this.threadBytes.get(candidate.thread);
      if (before !== undefined) this.threadBytes.set(candidate.thread, Math.max(0, before - freed));
    }
  }

  /** Hourly and at boot: free space and the cap it allows, conversations
   * that no longer exist, generations past 30 days, every total measured
   * again, and eviction down to the cap. */
  sweep(): Promise<void> {
    this.sweeping ??= this.runSweep().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async runSweep(): Promise<void> {
    try {
      const fs = await this.statfs(this.root).catch(() => this.statfs(join(this.root, "..")));
      const free = Number(fs.bavail) * Number(fs.bsize);
      this.budget = { cap: Math.min(EVIDENCE_LIMITS.totalBytes, Math.floor(free * EVIDENCE_LIMITS.freeShare)), low: free < EVIDENCE_LIMITS.freeFloor };
    } catch { /* keep the last measure */ }
    const expired = this.now() - EVIDENCE_LIMITS.retentionMs;
    let total = 0;
    for (const thread of directories(this.root)) {
      if (!THREAD_ID.test(thread)) continue;
      const dir = join(this.root, thread);
      if (this.deps && !this.deps.threadExists(thread)) {
        this.removeThread(thread);
        continue;
      }
      let threadTotal = 0;
      let stepTotal = 0;
      for (const generation of directories(dir)) {
        const gen = join(dir, generation);
        if (Math.max(modified(join(gen, STEPS_FILE)), modified(gen)) < expired) {
          try { rmSync(gen, { recursive: true, force: true }); } catch { /* next sweep */ }
          this.lastImage.delete(`${thread}/${generation}`);
          continue;
        }
        stepTotal += size(join(gen, STEPS_FILE));
        for (const name of files(gen)) {
          if (IMAGE_FILE.test(name)) threadTotal += size(join(gen, name));
        }
      }
      if (!directories(dir).length) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* next sweep */ } }
      this.threadBytes.set(thread, threadTotal);
      this.stepBytes.set(thread, stepTotal);
      total += threadTotal;
    }
    this.totalBytes = total;
    for (const [key, at] of this.active) if (at < this.now() - EVIDENCE_LIMITS.sweepMs) this.active.delete(key);
    this.evict(null);
  }
}
