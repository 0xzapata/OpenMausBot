// How many times in a row a turn's shell command has come back the same.
// repeat-detector.ts counts a call across the whole turn, which is right for
// a chip and wrong for acting: a healthy turn runs its tests ten times, and
// every run comes back different. Stuck is narrower: the same command, the
// same result as the time before, back to back. This file only tracks that
// streak, and stays pure; what is done about one is server/loop-guard.ts.
import { createHash } from "node:crypto";

import { previewIsPartial } from "./tool-summary.ts";

/** The longest output that is compared. Drivers cut what a tool printed:
 * toolDetailPreview at 6,000 characters with a marker, Muse at 4,000 without
 * one (drivers/muse-code.ts). A result this long may be the start of a
 * longer one, and two that start the same are not the same result. */
export const OUTCOME_TEXT_MAX = 4_000;

/** What a shell command came back with, as a digest: whether it succeeded,
 * and the output its driver reported. The output is hashed here and never
 * kept or logged anywhere, by this file or its caller. Null when the harness
 * cannot say what came back: the engine reported no output, or reported one
 * that is not all there (shortened, masked, or long enough to have been
 * cut), so a long test log whose failures are past the cut is never taken
 * for the run before it. */
export function outcomeDigest(ok: boolean, output: string | undefined): string | null {
  if (output === undefined || !output.trim() || output.length >= OUTCOME_TEXT_MAX || previewIsPartial(output)) return null;
  return createHash("sha256").update(ok ? "ok\n" : "failed\n").update(output).digest("base64");
}

interface Turn<C> {
  /** Shell commands that started and have not completed, by item id. Null
   * is one the harness could not see whole. */
  pending: Map<string, C | null>;
  /** The shell command that completed last, when what it was and what it
   * came back with are both known. */
  last?: { key: string; outcome: string; streak: number };
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

  /** An item completed. For a shell command whose command and outcome are
   * both known: the call, and how many times in a row, ending now, that
   * command has come back with that outcome. Null otherwise: an item that
   * is not a shell command this tracked (a read or an edit between two runs
   * changes nothing), or a shell command that proves nothing (not seen
   * whole, or no outcome), which ends the streak in progress. */
  completed(threadId: string, itemId: string | undefined, outcome: string | null): { call: C; streak: number } | null {
    const turn = this.turns.get(threadId);
    if (!turn || itemId === undefined || !turn.pending.has(itemId)) return null;
    const call = turn.pending.get(itemId) ?? null;
    turn.pending.delete(itemId);
    if (call === null || outcome === null) {
      delete turn.last;
      return null;
    }
    const streak = turn.last?.key === call.key && turn.last.outcome === outcome ? turn.last.streak + 1 : 1;
    turn.last = { key: call.key, outcome, streak };
    return { call, streak };
  }

  /** The turn ended: a new turn starts its own streak. */
  settle(threadId: string): void {
    this.turns.delete(threadId);
  }
}
