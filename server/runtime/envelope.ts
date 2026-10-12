// One envelope for every delegated turn, written from stored data and never
// from model text (docs/runtime-contract.md §4).
// STUB: the real wording lands beside this comment; the signatures are final.
import type { Assignment, EnvelopeNames } from "./types.ts";

/** Every envelope opens with this; model text that imitates it is escaped. */
export const ENVELOPE_MARK = "[OMB assignment";

/** The opening of an assignee's turn: assignment (person, routine or outside
 * lineage) or consultation, decided by the record's mode and origin. */
export function composeEnvelope(a: Assignment, names: EnvelopeNames, _parent?: Assignment): string {
  return `${ENVELOPE_MARK} ${a.id} from @${names.requester}] ${a.brief}`;
}

/** The report of a settled assignment, into its requester's conversation. */
export function composeReport(a: Assignment, names: EnvelopeNames): string {
  return `[Report from @${names.assignee} on assignment ${a.id} · ${a.outcome ?? a.status}] ${a.result}`;
}

/** Model-written text that could pass for an envelope opening. */
export function escapeEnvelope(text: string): string {
  return text.split(ENVELOPE_MARK).join(`(${ENVELOPE_MARK.slice(1)}`);
}
