// How many times in a row a turn's shell command has failed the same way.
// repeat-detector.ts counts a call across the whole turn, which is right for
// a chip and wrong for acting: a healthy turn runs its tests ten times, and
// every run comes back different. Stuck is narrower: the same command
// failing the same way as the time before, back to back. Only failing: a
// command that keeps succeeding with the same output is a poll (`sleep 60 &&
// gh run view …`, a `tail` of a log that has not moved), which is work, and a
// success ends the streak like any other command does. This file only
// tracks that streak, and stays pure; what is done about one is
// server/loop-guard.ts.
import { createHash } from "node:crypto";

import { previewIsPartial } from "./tool-summary.ts";

/** The longest output that is compared. Drivers cut what a tool printed:
 * toolDetailPreview at 6,000 characters with a marker, Muse at 4,000 without
 * one (drivers/muse-code.ts). A result this long may be the start of a
 * longer one, and two that start the same are not the same result. */
export const OUTCOME_TEXT_MAX = 4_000;

/** What a shell command failed with, as a digest of the output its driver
 * reported. The output is hashed here and never kept or logged anywhere, by
 * this file or its caller. Null for anything a streak is not made of: a
 * command that succeeded, whatever it printed; and a failure the harness
 * cannot compare, because the engine reported no output or one that is not
 * all there (shortened, masked, or long enough to have been cut), so a long
 * test log whose failures are past the cut is never taken for the run
 * before it. Failed is the engine's own word for it (`ok` on the tool's
 * completion): the harness does not second-guess an exit code. */
export function failureDigest(ok: boolean, output: string | undefined): string | null {
  if (ok || output === undefined || !output.trim() || output.length >= OUTCOME_TEXT_MAX || previewIsPartial(output)) return null;
  return createHash("sha256").update(output).digest("base64");
}

interface Turn<C> {
  /** Shell commands that started and have not completed, by item id. Null
   * is one the harness could not see whole. */
  pending: Map<string, C | null>;
  /** The shell command that completed last, when it failed and what it was
   * and what it failed with are both known. */
  last?: { key: string; failure: string; streak: number };
}

/** The streak of each thread's turn in flight. `C` is whatever the caller
 * wants back with a streak (the command as a person reads it); `key` is
 * what makes two commands the same command. */
export class RepeatStreak<C extends { readonly key: string }> {
  private readonly turns = new Map<string, Turn<C>>();
  private readonly maxPending: number;

  constructor(opts: { maxPending?: number } = {}) {
    this.maxPending = opts.maxPending ?? 256;
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1) {
      throw new Error("maxPending must be a positive integer");
    }
  }

  /** A shell command started. `call` is null when the harness cannot see
   * all of the command: it still ran, so it ends the streak when it
   * completes. One that started without an item id can never be seen to
   * complete, so it ends the streak now. */
  started(threadId: string, itemId: string | undefined, call: C | null): void {
    let turn = this.turns.get(threadId);
    if (!turn) this.turns.set(threadId, (turn = { pending: new Map() }));
    if (itemId === undefined) return void delete turn.last;
    // Bounded like the detector: a command that never completes must not be
    // waited on for ever. The one that started first falls out.
    turn.pending.delete(itemId);
    if (turn.pending.size >= this.maxPending) turn.pending.delete(turn.pending.keys().next().value!);
    turn.pending.set(itemId, call);
  }

  /** An item completed; `failure` is its failureDigest. For a shell command
   * that failed, whose command and failure are both known: the call, and
   * how many times in a row, ending now, that command has failed that way.
   * Null otherwise: an item that is not a shell command this tracked (a
   * read or an edit between two runs changes nothing), or a shell command
   * that is no part of a streak (it succeeded, it was not seen whole, or
   * what it failed with is not known), which ends the streak in progress. */
  completed(threadId: string, itemId: string | undefined, failure: string | null): { call: C; streak: number } | null {
    const turn = this.turns.get(threadId);
    if (!turn || itemId === undefined || !turn.pending.has(itemId)) return null;
    const call = turn.pending.get(itemId) ?? null;
    turn.pending.delete(itemId);
    if (call === null || failure === null) {
      delete turn.last;
      return null;
    }
    const streak = turn.last?.key === call.key && turn.last.failure === failure ? turn.last.streak + 1 : 1;
    turn.last = { key: call.key, failure, streak };
    return { call, streak };
  }

  /** The turn ended: a new turn starts its own streak. */
  settle(threadId: string): void {
    this.turns.delete(threadId);
  }
}
