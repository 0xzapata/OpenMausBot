// The quota switch as the server hosts it: the wiring that sat in
// server/index.ts, moved here unchanged (server/host/README.md).
// server/quota-switch.ts decides when a turn that ran out of quota earns an
// offer and what an answer to it does. This module hands it what only the
// server has, and gives the respond endpoints (server/routes/bot-messages.ts)
// the one question they ask about a card the harness raised itself.
// Everything it touches is handed in by index.ts, which builds it at the
// point the wiring sat.
import type { ResolvedSender } from "../../shared/wire.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import type { DataContext } from "../data-context.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import { resolvePeerComms, type ApprovalBus } from "../peer-approval.ts";
import { createQuotaSwitch, type QuotaRequest, type QuotaSwitchDeps } from "../quota-switch.ts";
import type { BotRecord, Message } from "../store.ts";
import type { UsageTrigger } from "../usage-ledger.ts";

/** index.ts's singletons and functions, under the names it has for them. */
export interface QuotaSwitchHostDeps extends Pick<QuotaSwitchDeps, "store" | "coordinator" | "turnStops"> {
  registry: Pick<ProviderRegistry, "instances" | "access">;
  /** Peer approvals' bus: a peer card is the other card the harness raises itself. */
  approvalBus: ApprovalBus;
  hostedModels: ReturnType<typeof hostedModelPolicy>;
  providerConfigs(): InstanceConfigMap;
  policyModelRefusal(instance: { instanceId: string; driverKind: string }): string | undefined;
  checkedTaskModelSwitch(
    current: BotRecord, raw: unknown, updateBotDefault: boolean, resetApprovalToAsk: boolean, requireAvailableModel?: boolean,
  ): ReturnType<QuotaSwitchDeps["gate"]>;
  threadBusy(botId: string, threadId: string): boolean;
  /** index.ts's Map, read here only. */
  directRequestOwners: { get(threadId: string): QuotaRequest | undefined };
  startOrQueueDirectMessage(
    botId: string, threadId: string, text: string, replyTo?: Message, sendId?: string, sender?: ResolvedSender,
    trigger?: UsageTrigger, via?: "call", callId?: string, dataContext?: DataContext,
  ): Promise<unknown>;
}

export function createQuotaSwitchHost(deps: QuotaSwitchHostDeps) {
  const {
    store, coordinator, registry, turnStops, approvalBus, hostedModels, providerConfigs, policyModelRefusal,
    checkedTaskModelSwitch, threadBusy, directRequestOwners, startOrQueueDirectMessage,
  } = deps;

  // quota-switch (server/quota-switch.ts): a person's turn that ends on its engine's usage limit offers another
  // engine. What only the server has: the thread's model-switch gate, its request record and a person's send.
  const quotaSwitch = createQuotaSwitch({
    store, coordinator, registry, turnStops,
    access: instanceId => providerConfigs()[instanceId]?.access ?? registry.access(instanceId),
    refusal: policyModelRefusal,
    gate: (thread, selection) => checkedTaskModelSwitch(thread, selection, false, false, true),
    reset: (from, to) => hostedModels?.resetTask(from, to),
    busy: threadBusy,
    request: threadId => directRequestOwners.get(threadId),
    resend: (botId, threadId, message, replyTo, spoken) => startOrQueueDirectMessage(botId, threadId, message.text ?? "", replyTo, undefined, message.sender, undefined, spoken.via, spoken.callId, message.dataContext),
  });

  /** A card the harness raised itself, on this thread: a peer approval or a
   * quota-switch offer. Settled here, with the outcome a respond endpoint
   * answers; undefined for any other card, which the endpoint goes on to deliver. */
  async function harnessCardOutcome(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message: unknown): Promise<string | undefined> {
    if (!store.messagesFor(threadId).some(candidate => candidate.card?.requestId === requestId)) return undefined;
    if (resolvePeerComms(approvalBus, requestId, behavior)) return behavior === "allow" ? "allowed-once" : "rejected";
    return await quotaSwitch.answer(threadId, requestId, behavior, message) ?? undefined;
  }

  return { quotaSwitch, harnessCardOutcome };
}
