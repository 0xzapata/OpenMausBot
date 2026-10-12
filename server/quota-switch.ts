// Quota-switch card: when a person's turn ends on its engine's quota or
// usage limit (drivers/retry.ts's terminal "quota" reason), the conversation
// gets one card offering the other engines that can take over, instead of
// leaving the person to notice, open the model picker and start the new
// engine cold. Nothing switches without their answer.
//
// The card is harness-native, like peer-approval.ts's: pushed straight into
// the thread and settled on the respond endpoints before any provider sees a
// request it never raised. It carries no `tool`, so a client answers it like
// a question (src/lib/card-answer.ts): the label the person pressed comes
// back as the message. It sets `fixedOptions`, so the desktop draws no
// free-text box beside the buttons; a client that still draws one (the
// phones) cannot switch anything with it, because an answer that names none
// of the offered engines is read as "Not now".
//
// Unlike a peer approval, the offer is kept on the card itself
// (card.quotaSwitch) and nothing about it lives in memory. A tool-less card
// is a question to the rest of the server, and a question whose asker is
// gone takes a late answer as a new message to the bot (index.ts's
// deliverLateQuestionAnswer): an offer remembered only in memory would, after
// a restart, send the bot the word "Codex" on the engine that just ran out.
// A card that names its own engines is always answered here instead.
//
// What it must never do is start a request twice. Every turn is a root of
// the job runtime (docs/runtime-contract.md): a failed turn's root is
// settled once, by that turn. When the root ended there, the answer sends
// the person's message again, which is a new root like any message they
// type. When the runtime still holds the request (the failed turn had handed
// work to teammates, or left a card it parks on), the runtime runs that root
// again itself, on whatever engine the thread has by then: the answer only
// switches the engine and sends nothing.
import { approvalModeFor, modelSwitchNeedsAsk } from "../shared/approval-mode.ts";
import type { QuotaSwitchCardData } from "../shared/wire.ts";
import { recoveryCapabilityError } from "./automatic-recovery.ts";
import type { AppConfig } from "./config.ts";
import { newId } from "./contracts.ts";
import type { EngineAccess, ModelCatalog, ModelSelection, ProviderAdapter, ProviderSnapshot } from "./contracts.ts";
import { readyToRun, selectDefaultModelSelection, type SelectableInstance } from "./default-model-selection.ts";
import { classifyError } from "./drivers/retry.ts";
import type { WorkOrigin } from "./peer-provenance.ts";
import type { BotRecord, Message, Store, TaskRecord } from "./store.ts";

/** An engine as the card needs it: a structural slice of ProviderInstance,
 * so tests hand in plain fakes instead of standing up the registry. */
export interface QuotaSwitchEngine {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  enabled?: boolean;
  models: ModelCatalog;
  adapter: { capabilities: ProviderAdapter["capabilities"] };
  snapshot: () => Promise<ProviderSnapshot>;
}

/** What the card needs from the server. Everything else is store reads and
 * writes. */
export interface QuotaSwitchDeps {
  store: Store;
  /** The kill switch (quotaSwitchEnabled, below). */
  enabled: () => boolean;
  /** Every live engine of this workspace. */
  engines: () => QuotaSwitchEngine[];
  /** How an engine is paid for: a custom endpoint brings its own credential,
   * so its sign-in state does not count (default-model-selection.ts). */
  access?: (instanceId: string) => EngineAccess | undefined;
  /** Why the organisation's policy refuses an engine for bots, if it does. */
  refusal?: (engine: QuotaSwitchEngine) => string | undefined;
  /** The ordinary gate of a thread's model switch (index.ts's
   * checkedTaskModelSwitch: a working thread, a pending approval grant, the
   * approval level the engine must be able to run, a hosted workspace's
   * models), asked for this thread alone and without an approval reset. */
  gate: (thread: BotRecord, selection: ModelSelection) => { ok: true; selection: ModelSelection } | { ok: false; error: string };
  /** What a changed model resets on the thread (a hosted workspace's fresh
   * session), as every other model switch passes it. */
  reset?: (from: ModelSelection, to: ModelSelection) => Partial<TaskRecord> | undefined;
  /** The thread is working, or the job runtime still owes its request
   * something (a root waiting on teammates, due a resume, parked on the
   * person's cards, queued to continue): that request goes on by itself, so
   * nothing may be sent again for it. */
  held: (botId: string, threadId: string) => boolean;
  /** Send `message` again as the person's own message, through the same
   * admission a typed message gets (it may queue), under the line it
   * replied to. Rejects when it could not be sent. */
  resend: (botId: string, threadId: string, message: Message, replyTo: Message | undefined) => Promise<unknown>;
}

/** A direct turn that ended, as the fold in index.ts read it. */
export interface QuotaTurn {
  /** The bot as this thread's turn ran it: its engine and approval level. */
  bot: BotRecord;
  threadId: string;
}

export interface FailedQuotaTurn extends QuotaTurn {
  /** Why the turn failed, in the runtime's words (TurnStops.failureCause). */
  cause: string | undefined;
  /** A teammate's or a peer's turn: its failure reaches whoever asked for
   * it, through the job runtime, and is theirs to act on. */
  internal: boolean;
  /** The thread's request record as the harness holds it (index.ts's
   * directRequestOwners): which message the request began with and where
   * its work started. It is this turn's only while its generation is the
   * turn's and nobody stopped it. */
  request?: { generation: string; messageId?: string; stopped?: boolean; origin?: WorkOrigin };
  /** The generation of the turn that just ended. */
  generation?: string;
}

export interface QuotaSwitch {
  /** A turn broke. Raises the card when its engine ran out, the turn was the
   * person's and another engine can take over; resolves with the card, or
   * null. Never rejects. */
  turnFailed(turn: FailedQuotaTurn): Promise<Message | null>;
  /** A turn completed: its engine works, and an offer still open in its
   * thread is spent, because the conversation went on without it. */
  turnSucceeded(turn: QuotaTurn): void;
  /** The respond endpoints call this before anything else looks for the
   * request. Null when `requestId` is not a pending quota card of this
   * thread, and the endpoint keeps looking. Otherwise the card is settled
   * before this returns, and `done` resolves once the switch and the resend
   * that follow have been handed over. `done` never rejects. */
  answer(threadId: string, requestId: string, message: string | undefined): { done: Promise<void> } | null;
}

const MAX_ENGINES = 3;
export const NOT_NOW = "Not now";

/** The kill switch. On unless switched off, because the card is only an
 * offer: nothing changes until the person answers it. Switch it off with
 * `{"quotaSwitch": {"enabled": false}}` in config.json (or through
 * PUT /api/config), or with OMB_QUOTA_SWITCH=0; the environment wins when it
 * says 0 or 1, like the other settings an environment can override
 * (decision-log.ts's decisionRetentionDays). */
export function quotaSwitchEnabled(cfg: Pick<AppConfig, "quotaSwitch">, env: NodeJS.ProcessEnv = process.env): boolean {
  const fromEnv = env.OMB_QUOTA_SWITCH?.trim();
  if (fromEnv === "0" || fromEnv === "1") return fromEnv === "1";
  return cfg.quotaSwitch?.enabled !== false;
}

const nameOf = (engine: QuotaSwitchEngine): string => engine.displayName || engine.driverKind;

/** The message a turn's failure may be answered with again: the person's
 * own line, still in the conversation. A line a bot delivered (peerAsk) is
 * never theirs to send again in their name. */
function resendable(store: Store, threadId: string, messageId: string | undefined): Message | undefined {
  if (!messageId) return undefined;
  const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
  return message?.role === "user" && message.kind === "text" && message.text && !message.peerAsk ? message : undefined;
}

export function createQuotaSwitch(deps: QuotaSwitchDeps): QuotaSwitch {
  const { store } = deps;
  /** Engines whose last turn here ended on their own limit, until one of
   * their turns completes. In memory only, and never a clock: when a limit
   * reopens is the provider's to say, so the next turn that works says it. */
  const limited = new Set<string>();

  const notice = (threadId: string, text: string, ok: boolean): void => {
    // `notice:` keeps the line a status row every client always shows
    // (src/lib/activity-runs.ts), never a tool step folded away.
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${text}`, ok } });
  };

  const openCard = (threadId: string): Message | undefined => store.messagesFor(threadId)
    .find((message) => message.card?.quotaSwitch && !message.card.answered && !message.card.dismissed);

  /** The engine as the one picker reads it, with its state read now. A
   * probe that throws is an engine that cannot run. */
  const described = async (engine: QuotaSwitchEngine): Promise<SelectableInstance> => {
    let snapshot: ProviderSnapshot;
    try {
      snapshot = await engine.snapshot();
    } catch {
      snapshot = { state: "unavailable" };
    }
    const access = deps.access?.(engine.instanceId);
    return {
      instanceId: engine.instanceId, driverKind: engine.driverKind, snapshot, models: engine.models, enabled: engine.enabled !== false,
      capabilities: { effortLevels: engine.adapter.capabilities.effortLevels, modelVariants: engine.adapter.capabilities.modelVariants === true },
      ...(access ? { access } : {}),
    };
  };

  /** The model `engine` would run this thread on, or null when it cannot
   * take the thread over now. One rule for the card and for the answer:
   * installed, signed in and allowed (readyToRun, the rule a new bot's
   * engine is picked by), not at its own limit, able to do what the current
   * engine does here (automatic recovery's backup check) and to run the
   * thread's approval level without a reset (the rule every model switch
   * applies). Its model comes from the picker a new bot's comes from. */
  const takeover = async (engine: QuotaSwitchEngine, bot: BotRecord, current: QuotaSwitchEngine | undefined): Promise<ModelSelection | null> => {
    if (limited.has(engine.instanceId)) return null;
    if (current && recoveryCapabilityError(
      { driverKind: current.driverKind, capabilities: current.adapter.capabilities },
      { driverKind: engine.driverKind, capabilities: engine.adapter.capabilities },
    )) return null;
    if (modelSwitchNeedsAsk(approvalModeFor(bot), current?.driverKind, engine.driverKind)) return null;
    const context = { refusal: () => deps.refusal?.(engine) };
    const instance = await described(engine);
    if (!readyToRun(instance, context)) return null;
    const selection = selectDefaultModelSelection([instance], undefined, context);
    return selection.instanceId && selection.model ? selection : null;
  };

  const turnFailed = async ({ bot, threadId, cause, internal, request, generation }: FailedQuotaTurn): Promise<Message | null> => {
    try {
      if (classifyError({ text: cause ?? "" }).reason !== "quota") return null;
      const currentId = bot.modelSelection.instanceId;
      limited.add(currentId);
      // Only the person's own request is offered a way on: one the record
      // proves is this turn's and began with their line (peer-provenance.ts's
      // origin: never a routine's, a webhook's, a relayed or a guest's).
      const own = !internal && request && !request.stopped && request.generation === generation && request.origin?.kind === "user";
      if (!own || !deps.enabled() || openCard(threadId)) return null;
      const messageId = request.messageId;
      // A thread a bot opened on itself answers that bot's line, not the person's.
      if (messageId && store.messagesFor(threadId).find((message) => message.id === messageId)?.peerAsk) return null;
      const engines = deps.engines();
      const current = engines.find((engine) => engine.instanceId === currentId);
      const others = engines.filter((engine) => engine.instanceId !== currentId);
      // Read together: each probe may ask a CLI, and the card waits on all.
      const able = await Promise.all(others.map((engine) => takeover(engine, bot, current)));
      const offered: QuotaSwitchCardData["engines"] = [];
      for (const engine of others.filter((_, index) => able[index]).slice(0, MAX_ENGINES)) {
        // The label is the answer, so two engines of one name are told apart.
        const name = nameOf(engine);
        const taken = name === NOT_NOW || offered.some((other) => other.name === name);
        offered.push({ instanceId: engine.instanceId, name: taken ? `${name} (${engine.instanceId})` : name });
      }
      // The probes took a while: the thread may be gone, or another failure
      // of it may have raised the card meanwhile. Nothing awaits between
      // this check and the write, so a thread never holds two open offers.
      if (!offered.length || !store.taskByThread(bot.id, threadId) || openCard(threadId)) return null;
      const original = resendable(store, threadId, messageId);
      return store.appendMessage(threadId, {
        role: "bot",
        kind: "options",
        card: {
          title: `${current ? nameOf(current) : "This engine"} is out of quota`,
          subtitle: original ? "Continue this conversation on another engine?"
            : "Switch this conversation to another engine? Send your message again afterwards.",
          options: [...offered.map((engine) => engine.name), NOT_NOW],
          requestId: newId(),
          fixedOptions: true,
          quotaSwitch: { engines: offered, ...(original ? { messageId: original.id } : {}) },
        },
      });
    } catch (error) {
      // An offer that could not be made is no failure of the turn's.
      console.warn(`quota switch: no card for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const turnSucceeded = ({ bot, threadId }: QuotaTurn): void => {
    limited.delete(bot.modelSelection.instanceId);
    const open = openCard(threadId);
    // Closed the way an ask nobody can answer any more is closed
    // (index.ts's answerRequest), so every client stops offering it.
    if (open?.card) store.patchMessage(threadId, open.id, { card: { ...open.card, answered: "unavailable", dismissed: true } });
  };

  /** Runs after the card is settled, so a slow probe never leaves it looking
   * open. Every way out but one says what happened in the conversation; a
   * conversation that is gone gets no line nobody would read. */
  const switchAndContinue = async (botId: string, threadId: string, chosen: QuotaSwitchCardData["engines"][number], messageId: string | undefined): Promise<void> => {
    if (!deps.enabled()) return notice(threadId, "continuing on another engine is switched off — nothing switched.", false);
    const engines = deps.engines();
    const engine = engines.find((candidate) => candidate.instanceId === chosen.instanceId);
    if (!engine) return notice(threadId, `${chosen.name} is no longer configured — nothing switched.`, false);
    const before = store.projectBotForTask(botId, threadId);
    if (!before) return;
    // The card was built a while ago: read the engine again before trusting it.
    const selection = await takeover(engine, before, engines.find((candidate) => candidate.instanceId === before.modelSelection.instanceId));
    // No await from here on: the gate's verdict, the switch and the resend
    // must see one state, or a turn started in between could lose to them.
    const bot = store.projectBotForTask(botId, threadId);
    if (!bot) return;
    if (!selection) return notice(threadId, `${chosen.name} is no longer available — nothing switched.`, false);
    // Already there (the person changed the model by hand): nothing to gate.
    if (bot.modelSelection.instanceId !== selection.instanceId) {
      const checked = deps.gate(bot, selection);
      if (!checked.ok) return notice(threadId, `could not switch to ${chosen.name} — ${checked.error}`, false);
      // This conversation only: the bot's own model and its other
      // conversations stay where they are, as with automatic recovery.
      try {
        store.switchTaskModel(botId, threadId, checked.selection, false, false, deps.reset?.(bot.modelSelection, checked.selection));
      } catch {
        return notice(threadId, `could not switch to ${chosen.name} — the model switch could not be saved.`, false);
      }
    }
    if (deps.held(botId, threadId)) {
      return notice(threadId, `switched to ${chosen.name}. The work already under way in this conversation continues there.`, true);
    }
    const original = resendable(store, threadId, messageId);
    if (!original) {
      return notice(threadId, `switched to ${chosen.name}, but the message that hit quota could not be found to resend — send it again.`, false);
    }
    notice(threadId, `continuing on ${chosen.name} after hitting quota`, true);
    try {
      await deps.resend(botId, threadId, original, original.replyToId ? store.messagesFor(threadId).find((message) => message.id === original.replyToId) : undefined);
    } catch (error) {
      if (store.taskByThread(botId, threadId)) {
        notice(threadId, `could not continue on ${chosen.name} — ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, false);
      }
    }
  };

  const answer = (threadId: string, requestId: string, message: string | undefined): { done: Promise<void> } | null => {
    const cardMessage = store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId);
    const card = cardMessage?.card;
    const offer = card?.quotaSwitch;
    if (!cardMessage || !card || !offer || card.answered || card.dismissed) return null;
    // The label is matched in the card's own order; anything else, typed
    // words included, is "Not now".
    const index = message === undefined ? -1 : card.options.indexOf(message);
    const chosen = index >= 0 ? offer.engines[index] : undefined;
    // "answer" with the words beside it, as every question-shaped card
    // remembers its reply (index.ts's answerRequest).
    store.patchMessage(threadId, cardMessage.id, { card: { ...card, answered: "answer", answeredText: chosen ? chosen.name : NOT_NOW } });
    const bot = store.botByThread(threadId);
    if (!chosen || !bot) return { done: Promise.resolve() };
    return {
      done: switchAndContinue(bot.id, threadId, chosen, offer.messageId).catch((error) => {
        console.warn(`quota switch: answer for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }),
    };
  };

  return { turnFailed, turnSucceeded, answer };
}
