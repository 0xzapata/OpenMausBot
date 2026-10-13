// The one place OpenMausBot still speaks Boat's retired box API. boat.ts
// speaks only Boat's public API v1 (/sandboxes paths, sandbox and sandboxes
// envelopes, deletion operations of kind "sandbox"). OMB Cloud's Admin relay
// (openmaus-cloud server/cloud-services.ts) still serves only the old dialect:
// /boxes paths under a base ending in /api/box/v1, and box and boxes
// envelopes. A sandbox keeps the same bx_ id under both.
//
// So an included credential wired to such a base is translated here, at the
// transport, and nowhere else. The Admin chooses the base it wires into each
// home (OMB_CLOUD_BOAT_URL): a relay that serves v1 under a base ending in
// /api/v1 is spoken to directly. Delete this file once no home is wired to
// /api/box/v1 (docs/cloud-pro.md, "Included Boat computers, voice and
// decisions").
import type { ServiceCredential } from "./included-services.ts";

const LEGACY_RELAY_BASE = /\/api\/box\/v1$/;

const legacyRelay = (account: ServiceCredential | null): boolean =>
  account?.included === true && LEGACY_RELAY_BASE.test(account.api);

/** A v1 path as the legacy relay routes it: /sandboxes… becomes /boxes…. */
export function relayPath(account: ServiceCredential | null, path: string): string {
  return legacyRelay(account) ? path.replace(/^\/sandboxes(?=[/?]|$)/, "/boxes") : path;
}

/** A legacy relay answer in v1's words: box becomes sandbox, boxes becomes
 * sandboxes, and a deletion operation's kind box becomes sandbox. Every other
 * field (errors, commands, desktop and file answers) is already the same. */
export function relayBody(account: ServiceCredential | null, body: any): any {
  if (!legacyRelay(account) || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const { box, boxes, ...rest } = body;
  return {
    ...rest,
    ...(box !== undefined ? { sandbox: box } : {}),
    ...(boxes !== undefined ? { sandboxes: boxes } : {}),
    ...(rest.operation?.kind === "box" ? { operation: { ...rest.operation, kind: "sandbox" } } : {}),
  };
}
