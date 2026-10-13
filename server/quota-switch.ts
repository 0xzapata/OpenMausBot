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
// of the offered engines is read as "Not now". So is every decline, whatever
// words it carries: only an answer may name an engine.
//
// Unlike a peer approval, the offer is kept on the card itself
// (card.quotaSwitch): nothing an answer needs lives in memory. A tool-less
// card is a question to the rest of the server, and a question whose asker
// is gone takes a late answer as a new message to the bot (index.ts's
// deliverLateQuestionAnswer): an offer remembered only in memory would, after
// a restart, send the bot the word "Codex" on the engine that just ran out.
// A card that names its own engines is always answered here instead, and it
// stays open until a choice took effect: a refusal never spends it.
//
// What it must never do is start a request twice. Every turn is a root of
// the job runtime (docs/runtime-contract.md): a failed turn's root is
// settled once, by that turn. When the root ended there, the answer sends
// the person's message again, which is a new root like any message they
// type. When the runtime still holds that request (the failed turn had handed
// work to teammates, or left a card it parks on), the runtime runs its root
// again itself, on whatever engine the thread has by then: the answer only
// switches the engine and sends nothing. The card names that root, so the
// question is asked of the request that ran out and never of the thread: an
// older request parked on a card nobody answered holds nothing here.
import { approvalModeFor, modelSwitchNeedsAsk } from "../shared/approval-mode.ts";
import type { QuotaSwitchCardData } from "../shared/wire.ts";
import { recoveryCapabilityError } from "./automatic-recovery.ts";
import { newId } from "./contracts.ts";
import type { EngineAccess, ModelCatalog, ModelSelection, ProviderAdapter, ProviderSnapshot } from "./contracts.ts";
import type { Coordinator } from "./coordinator.ts";
import { readyToRun, selectDefaultModelSelection, type SelectableInstance } from "./default-model-selection.ts";
import { classifyError } from "./drivers/retry.ts";
import { PROBE_TIMEOUT_MS } from "./engine-install.ts";
import { spokenLineFields } from "./live-call-record.ts";
import type { WorkOrigin } from "./peer-provenance.ts";
import type { BotRecord, Message, Store, TaskRecord } from "./store.ts";
import type { TurnStops } from "./turn-outcome.ts";

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

/** A thread's request record as the harness holds it (index.ts's
 * directRequestOwners): the message the request began with, where its work
 * started, the provider turn that runs it and every turn generation it has
 * had, its roots in the job runtime among them. */
export interface QuotaRequest {
  generations: ReadonlySet<string>;
  messageId?: string;
  turnId: string | null;
  stopped?: boolean;
  origin?: WorkOrigin;
}

/** A direct turn that ended, as its turn.completed event names it. */
export type SettledTurn = Parameters<TurnStops["failureCause"]>[0];

/** What the card needs from the server: its singletons, and the three
 * things only index.ts can do. Everything else is store reads and writes. */
export interface QuotaSwitchDeps {
  store: Store;
  /** The job runtime, read only: is the request that ran out still held. */
  coordinator: Pick<Coordinator, "all" | "node">;
  /** Every live engine of this workspace. */
  registry: { instances(): QuotaSwitchEngine[] };
  /** Why a settled turn failed, in the runtime's words. */
  turnStops: Pick<TurnStops, "failureCause">;
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
  /** A turn is running in the thread, or is being set up (index.ts's
   * threadBusy, the gate's own notion of a working thread). */
  busy: (botId: string, threadId: string) => boolean;
  /** The thread's request record, read while its turn's end is folded. */
  request: (threadId: string) => QuotaRequest | undefined;
  /** Send `message` again as the person's own message, through the same
   * admission a typed message gets (it may queue), under the line it
   * replied to. `spoken` says whether it was spoken on a Live call, and on
   * which: the line sent again is as spoken as the first, so its words stay
   * out of the log exactly as they did. Rejects when it could not be sent. */
  resend: (botId: string, threadId: string, message: Message, replyTo: Message | undefined, spoken: { via?: "call"; callId?: string }) => Promise<unknown>;
  /** The kill switch; quotaSwitchEnabled (below) unless a test says otherwise. */
  enabled?: () => boolean;
  /** The clock a probe's wait runs on; a real timer unless a test says otherwise. */
  after?: (ms: number, run: () => void) => { cancel(): void };
}

export interface QuotaSwitch {
  /** A direct turn of `bot` broke (`internal`: a teammate's or a peer's turn,
   * whose failure reaches whoever asked for it). Raises the card when its
   * engine ran out, the request was the person's own and another engine can
   * take over; resolves with the card, or null. Never rejects. */
  turnFailed(bot: BotRecord, event: SettledTurn, internal: boolean): Promise<Message | null>;
  /** A turn of `bot` completed in this thread: its engine works, and an
   * offer still open there is spent, because the conversation went on
   * without it. Never throws. */
  turnSucceeded(bot: BotRecord, threadId: string): void;
  /** The respond endpoints call this before anything else looks for the
   * request. Null when `requestId` is not an open quota card of this thread,
   * and the endpoint keeps looking. Otherwise the card is this module's, and
   * the promise resolves with what the endpoint answers once the choice was
   * decided: "answered" (an engine was switched to, or "Not now" was the
   * answer), "rejected" (a decline: only an "answer" may name an engine) or
   * "unavailable" (the choice was refused and the offer is still open).
   * The endpoint awaits it, so whoever answered is recorded on the card it
   * settled. Never rejects. */
  answer(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message: unknown): Promise<QuotaAnswer> | null;
}

export type QuotaAnswer = "answered" | "rejected" | "unavailable";

const MAX_ENGINES = 3;
export const NOT_NOW = "Not now";

/** A node of the job runtime that has ended, in the words the server reads it by. */
const ENDED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** The kill switch. On unless switched off, because the card is only an
 * offer: nothing changes until the person answers it. OMB_QUOTA_SWITCH=0
 * switches it off; any other value, or none, leaves it on. The environment
 * is the only switch for now. A `quotaSwitch.enabled` key in config.json
 * needs its place in server/config.ts's schema, which the file-size ratchet
 * (scripts/testing/file-size-ratchet.test.ts) pins at its present size; a
 * key read past that schema would be unvalidated, and a save through the
 * schema could drop it and bring the offer back unasked. */
export function quotaSwitchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_QUOTA_SWITCH?.trim() !== "0";
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
  const { store, coordinator } = deps;
  const enabled = deps.enabled ?? (() => quotaSwitchEnabled());
  const after = deps.after ?? ((ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  /** Engines whose last turn here ended on their own limit, until one of
   * their turns completes. In memory only, and never a clock: when a limit
   * reopens is the provider's to say, so the next turn that works says it. */
  const limited = new Set<string>();
  /** Cards being built: the engines are read between a turn's failure and
   * the write, and a turn of the thread that works meanwhile makes the
   * offer stale before it exists. */
  const building = new Set<{ threadId: string; stale: boolean }>();
  /** Choices being decided, by request: a second press on the card while
   * its engine is read is the same answer, never another. */
  const answering = new Map<string, Promise<QuotaAnswer>>();

  const notice = (threadId: string, text: string, ok: boolean): void => {
    // `notice:` keeps the line a status row every client always shows
    // (src/lib/activity-runs.ts), never a tool step folded away.
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${text}`, ok } });
  };

  const openCard = (threadId: string): Message | undefined => store.messagesFor(threadId)
    .find((message) => message.card?.quotaSwitch && !message.card.answered && !message.card.dismissed);

  /** The engine as the one picker reads it, with its state read now, or null
   * when it did not say within the time an engine probe gets
   * (engine-install.ts): a CLI that hangs must hold neither a card nor the
   * request that answers one. A probe that throws is an engine that cannot run. */
  const described = async (engine: QuotaSwitchEngine): Promise<SelectableInstance | null> => {
    const snapshot = await new Promise<ProviderSnapshot | null>((resolve) => {
      const wait = after(PROBE_TIMEOUT_MS, () => resolve(null));
      // Asked at once, inside a promise of its own so that a probe that throws is one that rejects.
      new Promise<ProviderSnapshot>((read) => read(engine.snapshot())).catch((): ProviderSnapshot => ({ state: "unavailable" }))
        .then((read) => { wait.cancel(); resolve(read); });
    });
    if (!snapshot) return null;
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
  const takeover = async (engine: QuotaSwitchEngine, bot: BotRecord, current: QuotaSwitchEngine | undefined): Promise<ModelSelection | "timed-out" | null> => {
    // Without the engine the thread runs on there is nothing to check a
    // backup against: no engine passes a check that could not be made.
    if (!current || limited.has(engine.instanceId)) return null;
    if (recoveryCapabilityError(
      { driverKind: current.driverKind, capabilities: current.adapter.capabilities },
      { driverKind: engine.driverKind, capabilities: engine.adapter.capabilities },
    )) return null;
    if (modelSwitchNeedsAsk(approvalModeFor(bot), current.driverKind, engine.driverKind)) return null;
    const context = { refusal: () => deps.refusal?.(engine) };
    const instance = await described(engine);
    if (!instance) return "timed-out";
    if (!readyToRun(instance, context)) return null;
    const selection = selectDefaultModelSelection([instance], undefined, context);
    return selection.instanceId && selection.model ? selection : null;
  };

  /** The root of the job runtime this request runs as: the newest of its
   * roots in the thread, as the host reads it (index.ts's
   * settleTrackedRequest). A backup engine's retry or a change of computer
   * begins another root for the same request. */
  const rootOf = (threadId: string, request: QuotaRequest): string | undefined => coordinator.all()
    .filter((node) => !node.parentId && node.threadId === threadId && request.generations.has(node.id))
    .sort((a, b) => a.createdAt - b.createdAt).at(-1)?.id;

  const turnFailed = async (bot: BotRecord, event: SettledTurn, internal: boolean): Promise<Message | null> => {
    const { threadId } = event;
    try {
      // Read before anything is awaited: the record is this turn's only now.
      const request = deps.request(threadId);
      if (classifyError({ text: deps.turnStops.failureCause(event) ?? "" }).reason !== "quota") return null;
      const currentId = bot.modelSelection.instanceId;
      limited.add(currentId);
      // Only the person's own request is offered a way on: one that began
      // with their line (peer-provenance.ts's origin: never a routine's, a
      // webhook's, a relayed or a guest's), that nobody stopped, and whose
      // record names this provider turn when it names one.
      const own = !internal && request && !request.stopped && request.origin?.kind === "user"
        && (!request.turnId || !event.turnId || request.turnId === event.turnId);
      if (!own || !enabled() || openCard(threadId)) return null;
      const messageId = request.messageId;
      // A thread a bot opened on itself answers that bot's line, not the person's.
      if (messageId && store.messagesFor(threadId).find((message) => message.id === messageId)?.peerAsk) return null;
      const engines = deps.registry.instances();
      const current = engines.find((engine) => engine.instanceId === currentId);
      // The engine the thread runs on is gone from here: no backup can be
      // checked against it (takeover), so there is nothing to offer.
      if (!current) return null;
      const others = engines.filter((engine) => engine.instanceId !== currentId);
      const build = { threadId, stale: false };
      building.add(build);
      // Read together: each probe may ask a CLI, and the card waits on all.
      const able = await Promise.all(others.map((engine) => takeover(engine, bot, current))).finally(() => building.delete(build));
      const offered: QuotaSwitchCardData["engines"] = [];
      for (const engine of others.filter((_, index) => able[index] && able[index] !== "timed-out").slice(0, MAX_ENGINES)) {
        // The label is the answer, so two engines of one name are told apart.
        const name = nameOf(engine);
        const taken = name === NOT_NOW || offered.some((other) => other.name === name);
        offered.push({ instanceId: engine.instanceId, name: taken ? `${name} (${engine.instanceId})` : name });
      }
      // The probes took a while: the thread may be gone, a turn of it may
      // have worked since (the conversation went on, and the offer would be
      // stale the moment it appeared), or another failure of it may have
      // raised the card. Nothing awaits between this check and the write, so
      // a thread never holds two open offers.
      if (!offered.length || build.stale || !store.taskByThread(bot.id, threadId) || openCard(threadId)) return null;
      const original = resendable(store, threadId, messageId);
      const rootId = rootOf(threadId, request);
      return store.appendMessage(threadId, {
        role: "bot",
        kind: "options",
        card: {
          title: `${nameOf(current)} is out of quota`,
          subtitle: original ? "Continue this conversation on another engine?"
            : "Switch this conversation to another engine? Send your message again afterwards.",
          options: [...offered.map((engine) => engine.name), NOT_NOW],
          requestId: newId(),
          fixedOptions: true,
          quotaSwitch: { engines: offered, ...(original ? { messageId: original.id } : {}), ...(rootId ? { rootId } : {}) },
        },
      });
    } catch (error) {
      // An offer that could not be made is no failure of the turn's.
      console.warn(`quota switch: no card for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const turnSucceeded = (bot: BotRecord, threadId: string): void => {
    limited.delete(bot.modelSelection.instanceId);
    for (const build of building) if (build.threadId === threadId) build.stale = true;
    try {
      const open = openCard(threadId);
      // Closed the way an ask nobody can answer any more is closed
      // (index.ts's answerRequest), so every client stops offering it.
      if (open?.card) store.patchMessage(threadId, open.id, { card: { ...open.card, answered: "unavailable", dismissed: true } });
    } catch (error) {
      // A card that could not be closed is no failure of the turn that worked.
      console.warn(`quota switch: stale card left open in ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** What keeps the message from being sent again once the switch went
   * through, or null when it may be. The request that ran out is asked about
   * by its own root: while that is live the runtime runs it again itself,
   * after the card it parked on ("card") or on its own ("runtime"). The
   * thread is asked one thing only, the rule a person's line meets in
   * startTurn (coordinator.answer): a teammate's turn here that ended on a
   * question takes their next line as its answer, and a resend would be that
   * line ("question"). A root parked on its cards takes no typed line, so
   * another request's unanswered card holds nothing. And a thread that is
   * working takes nothing ("busy"): the switch gate refuses a working
   * thread, but a thread already on the chosen engine never meets the gate,
   * and the turn running there may be the same message, typed again. */
  const heldBy = (botId: string, threadId: string, rootId: string | undefined): "card" | "runtime" | "busy" | "question" | null => {
    const root = rootId ? coordinator.node(rootId) : undefined;
    if (root && !ENDED.has(root.status)) return root.cards?.length ? "card" : "runtime";
    if (deps.busy(botId, threadId)) return "busy";
    const asked = coordinator.all().some((node) => node.parentId !== undefined && node.threadId === threadId
      && node.status === "waiting" && node.question !== undefined && !node.cards?.length);
    return asked ? "question" : null;
  };

  /** Decides one choice of an engine; true once the thread runs on it. The
   * offer is spent only then: a refusal that may pass (a thread busy for a
   * moment, an account being updated, an engine that dropped out or did not
   * answer) says why in the conversation and leaves the card open. One that
   * cannot pass says why once: an engine that was removed leaves the card,
   * and the card closes when nothing is left on it or the conversation's own
   * engine is gone. A conversation that is gone gets no line nobody would read. */
  const decide = async (botId: string, threadId: string, cardId: string, chosen: QuotaSwitchCardData["engines"][number]): Promise<boolean> => {
    /** The offer as it stands: undefined once it was settled meanwhile (a
     * "Not now", a turn that worked) or its conversation is gone. */
    const offer = () => {
      const card = store.messagesFor(threadId).find((message) => message.id === cardId)?.card;
      return card?.quotaSwitch && !card.answered && !card.dismissed ? card : undefined;
    };
    /** Says why and leaves the offer as `left` has it: unchanged when
     * omitted, which sends the card again as it stands, because a client
     * folds it the moment it is pressed and must show it open again. */
    const refuse = (why: string, left: (card: NonNullable<Message["card"]>) => Partial<NonNullable<Message["card"]>> = () => ({})): false => {
      const card = offer();
      if (!card) return false;
      notice(threadId, why, false);
      store.patchMessage(threadId, cardId, { card: { ...card, ...left(card) } });
      return false;
    };
    /** Closed the way an ask nobody can answer any more is closed. */
    const closed = () => ({ answered: "unavailable", dismissed: true });
    if (!enabled()) return refuse("continuing on another engine is switched off — nothing switched.", closed);
    const engines = deps.registry.instances();
    const engine = engines.find((candidate) => candidate.instanceId === chosen.instanceId);
    if (!engine) {
      // Removed for good: it leaves the card, so it is refused once and not
      // on every press, and what is left can still be chosen. With nothing
      // left on it the card closes.
      const rest = (offer()?.quotaSwitch!.engines ?? []).filter((other) => other.instanceId !== chosen.instanceId);
      if (!rest.length) return refuse(`${chosen.name} is no longer configured, and the card offered no other engine — nothing switched.`, closed);
      return refuse(`${chosen.name} is no longer configured — nothing switched.`,
        (card) => ({ options: [...rest.map((other) => other.name), NOT_NOW], quotaSwitch: { ...card.quotaSwitch!, engines: rest } }));
    }
    const before = store.projectBotForTask(botId, threadId);
    if (!before) return false;
    const current = engines.find((candidate) => candidate.instanceId === before.modelSelection.instanceId);
    // No backup can be checked against an engine that is gone (takeover),
    // on this press or the next: say whose engine it is, and close the offer.
    if (!current) return refuse("this conversation's own engine is no longer configured here, so no other engine can be checked against it — nothing switched. Choose a model for this conversation instead.", closed);
    // The card was built a while ago: read the engine again before trusting it.
    const selection = await takeover(engine, before, current);
    // No await from here on: the gate's verdict, the switch and the resend
    // must see one state, or a turn started in between could lose to them.
    const card = offer();
    const bot = store.projectBotForTask(botId, threadId);
    if (!card || !bot) return false;
    if (selection === "timed-out") return refuse(`${chosen.name} did not answer in time — nothing switched. Try again in a moment.`);
    if (!selection) return refuse(`${chosen.name} is no longer available — nothing switched.`);
    // Already there (the person changed the model by hand): nothing to gate.
    const already = bot.modelSelection.instanceId === selection.instanceId;
    if (!already) {
      const checked = deps.gate(bot, selection);
      if (!checked.ok) return refuse(`could not switch to ${chosen.name} — ${checked.error}`);
      // This conversation only: the bot's own model and its other
      // conversations stay where they are, as with automatic recovery.
      try {
        store.switchTaskModel(botId, threadId, checked.selection, false, false, deps.reset?.(bot.modelSelection, checked.selection));
      } catch {
        return refuse(`could not switch to ${chosen.name} — the model switch could not be saved.`);
      }
    }
    // "answer" with the words beside it, as every question-shaped card
    // remembers its reply (index.ts's answerRequest).
    store.patchMessage(threadId, cardId, { card: { ...card, answered: "answer", answeredText: chosen.name } });
    const now = `${already ? "already on" : "switched to"} ${chosen.name}`;
    const held = heldBy(botId, threadId, card.quotaSwitch!.rootId);
    const original = held ? undefined : resendable(store, threadId, card.quotaSwitch!.messageId);
    if (held === "card") notice(threadId, `${now}. Your request waits on a card above and continues on ${chosen.name} once you act on it.`, true);
    else if (held === "runtime") notice(threadId, `${now}. Your request is still under way here and continues on ${chosen.name}.`, true);
    else if (held === "busy") notice(threadId, `${now}. This conversation is working, so your message was not sent again.`, true);
    else if (held === "question") {
      notice(threadId, `${now}. A teammate's question is waiting for your answer in this conversation, so your message was not sent again — answer it, then send your message again.`, false);
    } else if (!original) {
      notice(threadId, `${now}, but the message that hit quota could not be found to resend — send it again.`, false);
    } else {
      notice(threadId, `continuing on ${chosen.name} after hitting quota`, true);
      try {
        await deps.resend(botId, threadId, original, original.replyToId ? store.messagesFor(threadId).find((message) => message.id === original.replyToId) : undefined, spokenLineFields(original.via, original.callId));
      } catch (error) {
        if (store.taskByThread(botId, threadId)) {
          notice(threadId, `could not continue on ${chosen.name} — ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, false);
        }
      }
    }
    return true;
  };

  const answer: QuotaSwitch["answer"] = (threadId, requestId, behavior, message) => {
    const cardMessage = store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId);
    const card = cardMessage?.card;
    const offer = card?.quotaSwitch;
    if (!cardMessage || !card || !offer || card.answered || card.dismissed) return null;
    // Only an answer may name an engine. A decline is "Not now" whatever
    // words it carries: where local services may only decline a card
    // (request-auth.ts's service trust), a bot's own shell can read this
    // card's request and labels and post to it, and its decline must never
    // switch the engine or send the person's message again. The label is
    // matched in the card's own order; anything else, typed words included,
    // is "Not now" too.
    const index = behavior === "answer" && typeof message === "string" ? card.options.indexOf(message) : -1;
    const chosen = index >= 0 ? offer.engines[index] : undefined;
    const bot = store.botByThread(threadId);
    if (!chosen || !bot) {
      store.patchMessage(threadId, cardMessage.id, { card: { ...card, answered: "answer", answeredText: NOT_NOW } });
      return Promise.resolve(behavior === "answer" ? "answered" : "rejected");
    }
    let deciding = answering.get(requestId);
    if (!deciding) {
      deciding = decide(bot.id, threadId, cardMessage.id, chosen)
        .then((switched): QuotaAnswer => switched ? "answered" : "unavailable", (error): QuotaAnswer => {
          console.warn(`quota switch: answer for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
          return "unavailable";
        })
        .finally(() => answering.delete(requestId));
      answering.set(requestId, deciding);
    }
    return deciding;
  };

  return { turnFailed, turnSucceeded, answer };
}
