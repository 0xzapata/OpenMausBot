/** True once, at the moment a move to My Cloud the person wanted kept in sync finishes. */
export function syncAfterMove(previousPhase: string | undefined, nextPhase: string, destinationKind: string | undefined, wanted: boolean): boolean {
  return wanted && destinationKind === "cloud" && nextPhase === "done" && previousPhase !== "done";
}

// Shared by every Move view (Settings, the suggestion card), so one finished move turns sync on once. Module state, not
// React state: useCloudMove's tests mock its hooks by call order.
let wanted = true;
// Only a move this app saw start acts, with the choice made at Start: after a reload, nothing is turned on unasked.
let armed = false;
let lastPhase: string | undefined;
export function keepFoldersInSync(): boolean { return wanted; }
export function setKeepFoldersInSync(value: boolean): void { wanted = value; }
export function noteMoveStart(): void { armed = wanted; }
export function noteMovePhase(phase: string, destinationKind: string | undefined, turnOn: () => void): void {
  if (syncAfterMove(lastPhase, phase, destinationKind, armed)) { armed = false; turnOn(); }
  if (phase === "failed") armed = false;
  lastPhase = phase;
}
