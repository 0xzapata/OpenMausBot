// Duplicating a bot (the sidebar's Duplicate): what the copy is created with.
//
// A copy of a restricted bot is restricted from its first moment. Who may
// see the bot, which tools it may use and whether the helper model may write
// for it are part of the request that creates the copy, never a later patch:
// a patch that failed would leave a copy with none of them. The copy then
// takes the source's engine and model, which is usually why the source was
// kept off the helper model in the first place.
import { helperModelAllowed } from "../../shared/wire";
import type { Bot } from "@/state/store";

/** The part of a bot this reads. `helperModel` is read as the server reads
 * it: only an absent switch or a strict true allows the helper. */
export type RestrictedSource = Pick<Bot, "visibility" | "toolScope" | "helperModel">;

export interface RestrictedCopyRequest {
  visibility?: Bot["visibility"];
  settings?: { toolScope?: Bot["toolScope"]; helperModel?: false };
}

/** The body of the POST /api/bots that creates a copy of `source`: its
 * audience unless that is everyone, its tool selection when it has one (an
 * empty selection included), and "never the helper model" when the source is
 * kept off it. Nothing at all for a bot with no restrictions. */
export function restrictedCopyRequest(source: RestrictedSource): RestrictedCopyRequest {
  const settings: NonNullable<RestrictedCopyRequest["settings"]> = {
    ...(Object.hasOwn(source, "toolScope") ? { toolScope: source.toolScope } : {}),
    ...(helperModelAllowed(source) ? {} : { helperModel: false as const }),
  };
  return {
    ...(source.visibility && source.visibility !== "everyone" ? { visibility: source.visibility } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
}
