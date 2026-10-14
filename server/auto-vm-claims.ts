export interface AutoVmClaimOwner {
  threadId: string;
  generation: string;
}

export interface AutoVmClaimSlot {
  owner: AutoVmClaimOwner;
  /** Bind, lease, boot; at most once. */
  claim: () => Promise<void>;
  /** Set by startAutoVmClaim; presence means the claim already fired. */
  begin?: Promise<void>;
  /** The fired claim rejected; the slot stays so the gate keeps refusing screen calls instead of forwarding them to an unclaimed VM. */
  failed?: boolean;
  failure?: string;
  claimed?: boolean;
  /** Dispatch mounted the computer tools without claiming, so the gate fires the claim on the first screen call. */
  lazy?: boolean;
  label?: string;
  localVm?: boolean;
  pendingReason?: string;
  boxId?: string;
  startsComputer?: true;
  /** Called once after the slot is marked failed; the fail-closed refusal does not depend on it firing. */
  onRejected?: (failure: string, error?: unknown) => void;
}

export type AutoVmClaimTable = Map<string, AutoVmClaimSlot>;

/** Exactly once per dispatch generation. A rejected claim keeps its slot marked failed, and a rejection mutates only the
 * slot it fired from, so a stale claim never touches a newer generation's. */
export function startAutoVmClaim(table: AutoVmClaimTable, threadId: string, generation: string): void {
  const slot = table.get(threadId);
  if (!slot || slot.owner.threadId !== threadId || slot.owner.generation !== generation || slot.begin) return;
  slot.begin = slot.claim().then(
    () => { slot.claimed = true; },
    (error: unknown) => {
      slot.failed = true;
      slot.failure = error instanceof Error ? error.message : String(error);
      slot.onRejected?.(slot.failure, error);
    },
  );
}
