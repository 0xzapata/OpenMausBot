import { offersSignIn } from "@/components/EngineSetup";
import { t } from "@/lib/i18n";
import { plainErrorLine } from "@/lib/plain-error";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { failedTurnCause } from "../../shared/failed-turn";
import { isClientCancellation, isStoppedTurnName } from "../../shared/client-cancel";

export { failedTurnCause };

type ActivityTool = NonNullable<Message["tool"]>;

export function engineSignedOut(engine: InstanceInfo | undefined): boolean {
  return Boolean(engine?.snapshot) && offersSignIn(engine);
}

export function signedOutEngine(tool: ActivityTool, engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return tool.setup && !tool.claudeUpdate && engineSignedOut(engine) ? engine : undefined;
}

export function botEngine(bot: Bot | undefined, instances: InstanceInfo[]): InstanceInfo | undefined {
  return bot && instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
}

export function activityPreview(tool: ActivityTool, engine: InstanceInfo | undefined, dataResult?: Message["dataResult"]): string {
  if (dataResult) return dataResult.title;
  if (isStoppedTurnName(tool.name)) return t("chat.turnStopped");
  const cause = failedTurnCause(tool.name);
  if (cause !== null && isClientCancellation(cause)) return t("chat.turnStopped");
  if (cause === null) return tool.name;
  const signedOut = signedOutEngine(tool, engine);
  return signedOut ? t("sidebar.preview.signedOut", { name: signedOut.displayName }) : plainErrorLine(cause) ?? cause;
}
