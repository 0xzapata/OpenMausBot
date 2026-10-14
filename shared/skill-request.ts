/**
 * Durable payload on a learned-skill confirmation card. None of the staged
 * SKILL.md reaches the bot's enabled skill index until the user confirms; during
 * an update the approved version stays live.
 */
export type SkillRequestAction = "create" | "update";

/** What sharing a learned skill with the author's team did
 * (features.shareLearnedSkills), kept on the receipt so Undo can revert the
 * library write and the assignments together. */
export interface SkillShareRecord {
  /** installed: this share put the skill in the library; deduplicated: the
   * identical bytes were already there; assigned: it was already a library
   * skill; updated: a shared skill's library copy was rewritten. */
  library: "installed" | "deduplicated" | "assigned" | "updated";
  /** The library SKILL.md sha256 this share left. */
  sha256: string;
  sharedAt: number;
  /** Bots this share assigned the skill to. */
  assigned: Array<{ botId: string; name: string }>;
  /** Teammates left out, and why (a same-named private skill). */
  skipped: Array<{ botId: string; name: string; reason: string }>;
}

export interface SkillRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  stagedId: string;
  action: SkillRequestAction;
  name: string;
  gist: string;
  /** Human-readable provenance retained with the installed skill. */
  source?: string;
  /** Exact, secret-scrubbed SKILL.md shown as plain text before approval. */
  preview?: string;
  /** Binds approval to the exact bytes shown in preview. */
  sha256?: string;
  warnings: string[];
  createdAt: number;
  /** An update that applied without a person: the SKILL.md it replaced, so
   * Undo can put it back while the skill is unchanged since. */
  previous?: { preview: string; source: string };
  /** Set once the skill was shared with the team. */
  shared?: SkillShareRecord;
  /** Why sharing this skill did not happen, when it was tried. */
  shareError?: string;
}

/** The hash a current client may echo after it displayed the complete
 * proposal. Old cards deliberately return undefined and remain deny-only. */
export function reviewedSkillSha256(request: SkillRequestCardData): string | undefined {
  if (!request.preview || !request.sha256 || !/^[a-f0-9]{64}$/i.test(request.sha256)) return undefined;
  return request.sha256;
}

/** Map the server-authored affirmative labels explicitly and fail closed for
 * anything else. This keeps new Update/Apply wording working without turning
 * an unknown or corrupted card answer into approval. */
export function skillRequestBehavior(answer: string): "allow" | "deny" {
  const normalized = answer.trim().toLowerCase();
  return ["enable", "update", "apply", "allow", "allow once", "confirm", "yes"].includes(normalized)
    ? "allow"
    : "deny";
}
