// One level rule for every delegated turn (docs/runtime-contract.md §3).
// STUB: the real rule lands beside this comment; the signature is final.
import type { Level, LevelSource, OriginKind } from "./types.ts";

export interface LevelInput {
  /** The assignee's own level. */
  own: Level;
  /** The Chief conversation's level, when a Chief is the requester or an
   * ancestor in the same root. */
  chief?: Level;
  origin: OriginKind;
  /** A Chief of Staff conversation is the requester or an ancestor in the
   * same root. */
  chiefLineage: boolean;
  /** The assignee's engine (shared/approval-mode.ts driver kinds). */
  driverKind?: string;
}

export function assignmentLevel(input: LevelInput): { level: Level; source: LevelSource } {
  return { level: input.own, source: "own" };
}
