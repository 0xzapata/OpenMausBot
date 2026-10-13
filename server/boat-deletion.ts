// Boat's deletion operation (DELETE /sandboxes/{id} answers 202 with one; poll
// GET /deletion-operations/{id}): what OpenMausBot accepts from it, and what
// its status and stage mean for a delete (https://docs.boat.dev/data-retention/delete,
// https://docs.boat.dev/api/reference/account/get-deletion-operation). The
// durable fence lives in boat-delete-journal.ts; boat.ts drives both.
//
// The sandbox leaves every list, restore and fork as soon as the operation
// exists, a delete can never be cancelled, and Boat retries the purge itself.
// So `blocked` is not a failure: it says what the background erase waits for.

const OPERATION_ID = /^bdop_[a-f0-9]{32}$/;
const STATUSES = new Set(["pending", "processing", "blocked", "completed"]);

/** A blocked purge in these stages ends with nobody's help: the data goes at
 * `expectedBy` once the last upload link issued for it expires (at most six
 * hours after the last upload), after a restore that reads it ends, or on
 * Boat's own retry (`removing` and `completed` say it is going or gone). */
const SELF_FINISHING_STAGES = new Set(["removing", "waiting_for_uploads", "waiting_for_restore", "retrying", "completed"]);

export interface BoatDeletionOperation {
  id: string;
  kind: "sandbox";
  targetId: string;
  status: "pending" | "processing" | "blocked" | "completed";
  /** removing, waiting_for_uploads, kept_for_newer_snapshots, waiting_for_restore, retrying, completed */
  stage: string | null;
}

/** Accept only the immutable identity fields needed to follow a delete. Any
 * malformed success envelope falls back to a direct Boat read instead of
 * authorizing journal retirement. */
export function boatDeletionOperation(
  body: any,
  boxId: string,
  expectedOperationId?: string,
): BoatDeletionOperation | null {
  const operation = body?.operation;
  const id = typeof operation?.id === "string" ? operation.id : "";
  const status = typeof operation?.status === "string" ? operation.status : "";
  if (
    !OPERATION_ID.test(id)
    || (expectedOperationId !== undefined && id !== expectedOperationId)
    || operation?.kind !== "sandbox"
    || operation?.targetId !== boxId
    || !STATUSES.has(status)
  ) return null;
  const stage = typeof operation.stage === "string" ? operation.stage : null;
  return { id, kind: "sandbox", targetId: boxId, status: status as BoatDeletionOperation["status"], stage };
}

/** Blocked only until Boat finishes on its own: OpenMausBot's delete is done. */
export const blockedUntilBoatFinishes = (operation: BoatDeletionOperation) =>
  operation.status === "blocked" && SELF_FINISHING_STAGES.has(operation.stage ?? "");

/** Blocked until the person deletes a fork or named snapshot that still builds on the data. */
export const keptForNewerSnapshots = (operation: BoatDeletionOperation) =>
  operation.status === "blocked" && operation.stage === "kept_for_newer_snapshots";

/** A blocked delete that needs the person, in words they can act on. Never
 * "retry": Boat accepted the delete and retries the purge itself. */
export function deletionBlockedError(boxId: string, kept: boolean): Error & { status: number } {
  return Object.assign(new Error(kept
    ? `boat.dev deleted cloud computer ${boxId} but is keeping its stored data, because a fork or named snapshot made from it still uses that data. To erase the data, delete those in boat.dev.`
    : `boat.dev accepted the deletion of cloud computer ${boxId}, but says it is blocked without a reason OpenMausBot knows. boat.dev keeps retrying on its own; if ${boxId} is still listed in boat.dev later, delete it there.`,
  ), { status: 409 });
}
