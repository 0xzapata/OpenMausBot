import type { CloudMoveState } from "../../electron/cloud-move.mjs";
import { hintSeen, type OnboardingStatus, type WelcomeViewer } from "@/lib/onboarding";

export const CLOUD_SETUP_HIDDEN = "cloud-setup-hidden";
export const CLOUD_SETUP_MOVE_SKIPPED = "cloud-setup-move-skipped";
export const CLOUD_INTENT_ASKED = "cloud-intent-asked";
export const CLOUD_INTENT_GIVEN = "cloud-intent-given";

export type CloudSetupStep = "cloud" | "job" | "engine" | "plan" | "move";
export type CloudSetupStatus = "todo" | "done" | "skipped";
export interface CloudSetupItem { id: CloudSetupStep; status: CloudSetupStatus }

export interface CloudSetupFacts {
  viewer: WelcomeViewer | null;
  connected: boolean;
  enginesKnown: boolean;
  engineReady: boolean;
  onboarding: OnboardingStatus | undefined;
  planned?: boolean;
  move: { phase: CloudMoveState["phase"]; action?: CloudMoveState["action"]; suggest: boolean } | null;
}

export function cloudSetupStage(facts: Omit<CloudSetupFacts, "move">): "none" | "waiting" | "hidden" | "done" | "shown" {
  if (!facts.viewer?.cloudHome || !facts.viewer.canSave) return "none";
  if (!facts.connected || !facts.enginesKnown || !facts.onboarding) return "waiting";
  if (hintSeen(facts.onboarding, CLOUD_SETUP_HIDDEN)) return "hidden";
  const worked = hintSeen(facts.onboarding, CLOUD_INTENT_GIVEN) ? Boolean(facts.planned) : Boolean(facts.onboarding.firstTurnAt);
  if (facts.engineReady && worked) return "done";
  return "shown";
}

const UNDER_WAY = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking", "replacing", "restarting", "failed"]);

export function moveStatus(move: CloudSetupFacts["move"], onboarding: OnboardingStatus | undefined): CloudSetupStatus | null {
  if (!move) return null;
  if (move.action !== "restore" && move.phase === "done") return "done";
  if (move.action !== "restore" && UNDER_WAY.has(move.phase)) return "todo";
  if (hintSeen(onboarding, CLOUD_SETUP_MOVE_SKIPPED)) return "skipped";
  return move.suggest ? "todo" : null;
}

export function cloudSetupItems(facts: CloudSetupFacts): CloudSetupItem[] {
  const given = hintSeen(facts.onboarding, CLOUD_INTENT_GIVEN);
  const items: CloudSetupItem[] = [
    { id: "cloud", status: "done" },
    { id: "job", status: given || facts.onboarding?.firstTurnAt ? "done" : "todo" },
    { id: "engine", status: facts.engineReady ? "done" : "todo" },
  ];
  if (given) items.push({ id: "plan", status: facts.planned ? "done" : "todo" });
  const move = moveStatus(facts.move, facts.onboarding);
  if (move) items.push({ id: "move", status: move });
  return items;
}
