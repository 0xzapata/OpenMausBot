// The quota-switch card's lifecycle on a real Store (so message and task
// writes take the genuine paths), with fake engines and fakes for the three
// things only server/index.ts can do: the thread's gated model switch, what
// the job runtime still holds, and a person's send.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection, ProviderAdapter, ProviderSnapshot } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import { createQuotaSwitch, NOT_NOW, quotaSwitchEnabled, type FailedQuotaTurn, type QuotaSwitch, type QuotaSwitchDeps, type QuotaSwitchEngine } from "./quota-switch.ts";
import { Store, type BotRecord, type Message } from "./store.ts";

const QUOTA = "You've hit your weekly limit · resets Oct 12 at 2:30pm (Asia/Calcutta)";
const defaultSelection = (): ModelSelection => ({ instanceId: "claude", model: "claude-default" });
const caps = (extra: Partial<ProviderAdapter["capabilities"]> = {}): ProviderAdapter["capabilities"] =>
  ({ sessionModelSwitch: "unsupported", ...extra });
const available = async (): Promise<ProviderSnapshot> => ({ state: "available", authenticated: true });

function engine(instanceId: string, driverKind: string, displayName: string, overrides: Partial<QuotaSwitchEngine> = {}): QuotaSwitchEngine {
  return {
    instanceId, driverKind, displayName, enabled: true,
    models: { default: `${instanceId}-default`, options: [{ id: `${instanceId}-default`, label: "Default" }] },
    adapter: { capabilities: caps() },
    snapshot: available,
    ...overrides,
  };
}

describe("quotaSwitchEnabled", () => {
  it("is on unless config or OMB_QUOTA_SWITCH switches it off", () => {
    // On by default: the card is only an offer, and nothing changes until it is answered.
    expect(quotaSwitchEnabled({}, {})).toBe(true);
    expect(quotaSwitchEnabled({ quotaSwitch: { enabled: true } }, {})).toBe(true);
    expect(quotaSwitchEnabled({ quotaSwitch: { enabled: false } }, {})).toBe(false);
    // The environment wins when it says either way; anything else leaves the file's choice.
    expect(quotaSwitchEnabled({}, { OMB_QUOTA_SWITCH: "0" })).toBe(false);
    expect(quotaSwitchEnabled({ quotaSwitch: { enabled: true } }, { OMB_QUOTA_SWITCH: " 0 " })).toBe(false);
    expect(quotaSwitchEnabled({ quotaSwitch: { enabled: false } }, { OMB_QUOTA_SWITCH: "1" })).toBe(true);
    expect(quotaSwitchEnabled({ quotaSwitch: { enabled: false } }, { OMB_QUOTA_SWITCH: "" })).toBe(false);
    expect(quotaSwitchEnabled({}, { OMB_QUOTA_SWITCH: "maybe" })).toBe(true);
  });
});

describe("quota-switch card", () => {
  let store: Store;
  let bot: BotRecord;
  let engines: QuotaSwitchEngine[];
  let resend: ReturnType<typeof vi.fn<QuotaSwitchDeps["resend"]>>;
  let gate: ReturnType<typeof vi.fn<QuotaSwitchDeps["gate"]>>;
  let switchRefusal: string | undefined;
  let held: boolean;
  let enabled: boolean;
  let deps: QuotaSwitchDeps;
  let quota: QuotaSwitch;

  /** The thread as a turn sees it: its own model and approval level. */
  const thread = () => store.projectBotForTask(bot.id, bot.threadId)!;
  /** A person's own request, as index.ts's record proves it. */
  const mine = (messageId?: string): NonNullable<FailedQuotaTurn["request"]> =>
    ({ generation: "g1", origin: { kind: "user", request: "asked" }, ...(messageId ? { messageId } : {}) });
  const failed = (cause = QUOTA, turn: { messageId?: string } = {}) =>
    quota.turnFailed({ bot: thread(), threadId: bot.threadId, cause, internal: false, request: mine(turn.messageId), generation: "g1" });
  const said = (text: string, extra: Partial<Message> = {}) =>
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text, ...extra }).id;
  const cards = () => store.messagesFor(bot.threadId).filter((m) => m.kind === "options" && m.card?.quotaSwitch);
  const pending = () => cards().find((m) => !m.card!.answered && !m.card!.dismissed);
  const notices = () => store.messagesFor(bot.threadId).flatMap((m) => m.kind === "activity" && m.tool ? [m.tool] : []);
  const answer = async (card: Message, label: string) => {
    const taken = quota.answer(bot.threadId, card.card!.requestId!, label);
    expect(taken).not.toBeNull();
    await taken!.done;
  };

  beforeEach(() => {
    store = new Store(defaultSelection);
    bot = store.patchBot(store.createBot().id, { name: "Wren", modelSelection: defaultSelection() })!;
    engines = [engine("claude", "claudeAgent", "Claude"), engine("codex", "codex", "Codex"), engine("cursor", "cursorAgent", "Cursor")];
    resend = vi.fn<QuotaSwitchDeps["resend"]>(async () => undefined);
    // index.ts answers with checkedTaskModelSwitch here.
    gate = vi.fn<QuotaSwitchDeps["gate"]>((_thread, selection) => switchRefusal ? { ok: false, error: switchRefusal } : { ok: true, selection });
    switchRefusal = undefined;
    held = false;
    enabled = true;
    deps = {
      store,
      enabled: () => enabled,
      engines: () => engines,
      gate,
      held: () => held,
      resend,
    };
    quota = createQuotaSwitch(deps);
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  describe("what is offered", () => {
    it("offers the other engines that can run now, never the current one, and takes no free text", async () => {
      const messageId = said("how's the weather");
      const card = await failed(QUOTA, { messageId });
      expect(card?.card).toMatchObject({
        title: "Claude is out of quota",
        subtitle: "Continue this conversation on another engine?",
        options: ["Codex", "Cursor", NOT_NOW],
        fixedOptions: true,
        quotaSwitch: { engines: [{ instanceId: "codex", name: "Codex" }, { instanceId: "cursor", name: "Cursor" }], messageId },
      });
      expect(card!.card!.requestId).toBeTruthy();
      expect(card!.card!.tool).toBeUndefined();
      expect(pending()?.id).toBe(card!.id);
    });

    it("offers at most three engines, then Not now", async () => {
      engines.push(engine("grok", "grokAgent", "Grok"), engine("gemini", "geminiAgent", "Gemini"));
      expect((await failed())!.card!.options).toEqual(["Codex", "Cursor", "Grok", NOT_NOW]);
    });

    it("raises no second card in a thread while one is pending", async () => {
      expect(await failed()).toBeTruthy();
      expect(await failed()).toBeNull();
      expect(cards()).toHaveLength(1);
    });

    it("raises one card when two failures of the same thread are read at once", async () => {
      const raised = await Promise.all([failed(), failed()]);
      expect(raised.filter(Boolean)).toHaveLength(1);
      expect(cards()).toHaveLength(1);
    });

    it("raises no card for an error that is not a quota or usage limit", async () => {
      expect(await failed("500 internal server error")).toBeNull();
      expect(await failed("Not logged in · Please run /login")).toBeNull();
      expect(cards()).toHaveLength(0);
    });

    it("raises no card when no other engine is configured", async () => {
      engines = [engines[0]!];
      expect(await failed()).toBeNull();
    });

    it("never offers an engine that cannot run a turn when the card is built", async () => {
      engines = [
        engines[0]!,
        engine("gone", "codex", "Uninstalled", { snapshot: async () => ({ state: "unavailable", reason: "not installed" }) }),
        engine("out", "codex", "Signed out", { snapshot: async () => ({ state: "available", authenticated: false }) }),
        engine("off", "codex", "Switched off", { enabled: false }),
        engine("broken", "codex", "Broken", { snapshot: async () => { throw new Error("probe failed"); } }),
        engine("empty", "codex", "No model", { models: { default: "", options: [] } }),
        engine("barred", "codex", "Barred"),
        engine("codex", "codex", "Codex"),
      ];
      deps.refusal = (candidate) => candidate.instanceId === "barred" ? "Your organisation does not allow this engine." : undefined;
      expect((await failed())!.card!.options).toEqual(["Codex", NOT_NOW]);
    });

    it("offers a custom endpoint whatever its sign-in state says: it brings its own credential", async () => {
      engines = [engines[0]!, engine("local", "codex", "Local model", { snapshot: async () => ({ state: "available", authenticated: false }) })];
      deps.access = (instanceId) => instanceId === "local" ? "custom" : "subscription";
      expect((await failed())!.card!.options).toEqual(["Local model", NOT_NOW]);
    });

    it("raises no card when every other engine is unavailable", async () => {
      engines = engines.map((candidate) => candidate.instanceId === "claude" ? candidate
        : { ...candidate, snapshot: async () => ({ state: "unavailable" as const }) });
      expect(await failed()).toBeNull();
    });

    it("never offers an engine known to be at its own limit, and offers it again once a turn on it succeeds", async () => {
      const codexThread = store.createTask(bot.id, undefined, false)!.threadId;
      store.switchTaskModel(bot.id, codexThread, { instanceId: "codex", model: "codex-default" }, false, false);
      const onCodex = store.projectBotForTask(bot.id, codexThread)!;
      // Codex runs out in another conversation; that one is offered Claude and Cursor.
      const elsewhere = await quota.turnFailed({ bot: onCodex, threadId: codexThread, cause: "usage limit reached", internal: false, request: mine(), generation: "g1" });
      expect(elsewhere!.card!.options).toEqual(["Claude", "Cursor", NOT_NOW]);
      // Now Claude runs out here: Codex is known to be limited, so only Cursor is offered.
      const first = (await failed())!;
      expect(first.card!.options).toEqual(["Cursor", NOT_NOW]);
      quota.answer(bot.threadId, first.card!.requestId!, NOT_NOW);
      // A turn on Codex completes: it works again.
      quota.turnSucceeded({ bot: onCodex, threadId: codexThread });
      expect((await failed())!.card!.options).toEqual(["Codex", "Cursor", NOT_NOW]);
    });

    it.each<[string, Partial<FailedQuotaTurn>]>([
      ["a teammate's or a peer's turn", { internal: true }],
      ["a routine's, a webhook's or a relayed request", { request: { generation: "g1", origin: { kind: "outside" } } }],
      ["a request the record no longer proves is this turn's", { request: { ...mine(), generation: "an-older-turn" } }],
      ["a request the person stopped", { request: { ...mine(), stopped: true } }],
      ["a turn with no request record", { request: undefined }],
    ])("raises no card for %s, and still remembers that its engine ran out", async (_name, turn) => {
      const codexThread = store.createTask(bot.id, undefined, false)!.threadId;
      store.switchTaskModel(bot.id, codexThread, { instanceId: "codex", model: "codex-default" }, false, false);
      const raised = await quota.turnFailed({
        bot: store.projectBotForTask(bot.id, codexThread)!, threadId: codexThread, cause: QUOTA, internal: false, request: mine(), generation: "g1", ...turn,
      });
      expect(raised).toBeNull();
      expect(store.messagesFor(codexThread)).toEqual([]);
      expect((await failed())!.card!.options).toEqual(["Cursor", NOT_NOW]);
    });

    it("offers only engines that pass the backup check: the same tools, the same workspace", async () => {
      engines = [
        engine("claude", "claudeAgent", "Claude", { adapter: { capabilities: caps({ agentsMcp: true, images: true }) } }),
        engine("bare", "codex", "No team tools", { adapter: { capabilities: caps({ images: true }) } }),
        // an API model has no working folder (supportsWorkspaceFiles)
        engine("api", "openai-compat", "API model", { adapter: { capabilities: caps({ agentsMcp: true, images: true }) } }),
        engine("codex", "codex", "Codex", { adapter: { capabilities: caps({ agentsMcp: true, images: true, browserMcp: true }) } }),
      ];
      expect((await failed())!.card!.options).toEqual(["Codex", NOT_NOW]);
    });

    it("never offers an engine this conversation's approval level cannot move to", async () => {
      // Auto-accept edits exists on Claude and Grok, not on Codex or Cursor.
      store.patchTask(bot.id, bot.threadId, { approvalMode: "edits", autoApprove: false });
      engines.push(engine("grok", "grokAgent", "Grok"));
      expect((await failed())!.card!.options).toEqual(["Grok", NOT_NOW]);
    });

    it("tells two engines with the same name apart", async () => {
      engines = [engines[0]!, engine("work", "codex", "Codex"), engine("home", "codex", "Codex")];
      const card = (await failed())!;
      expect(card.card!.options).toEqual(["Codex", "Codex (home)", NOT_NOW]);
      await answer(card, "Codex (home)");
      expect(thread().modelSelection).toEqual({ instanceId: "home", model: "home-default" });
    });

    it("raises nothing when it is switched off", async () => {
      enabled = false;
      expect(await failed()).toBeNull();
      expect(cards()).toHaveLength(0);
    });

    it("says on the card to send the message again when there is none to resend", async () => {
      const card = (await failed(QUOTA, { messageId: undefined }))!;
      expect(card.card!.subtitle).toBe("Switch this conversation to another engine? Send your message again afterwards.");
      expect(card.card!.quotaSwitch!.messageId).toBeUndefined();
    });

    it("raises no card for a turn that answered a bot's line, which is never the person's to send again", async () => {
      const peerLine = said("Do the quarterly numbers", { peerAsk: { botId: "chief", name: "Chief" } });
      expect(await failed(QUOTA, { messageId: peerLine })).toBeNull();
      expect(cards()).toHaveLength(0);
    });
  });

  describe("the person's answer", () => {
    it("switches this conversation through the model-switch gate and resends the exact message that failed", async () => {
      const quoted = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "It will rain on Friday." }).id;
      const messageId = said("how's the weather", { dataContext: { cardId: "sales" }, replyToId: quoted });
      const card = (await failed(QUOTA, { messageId }))!;

      await answer(card, "Codex");

      // through the gate, asked for this thread as it stood and the engine's default model
      expect(gate).toHaveBeenCalledTimes(1);
      expect(gate.mock.calls[0]![0]).toMatchObject({ id: bot.id, threadId: bot.threadId, modelSelection: { instanceId: "claude" } });
      expect(gate.mock.calls[0]![1]).toEqual({ instanceId: "codex", model: "codex-default" });
      // this conversation moved; the bot's own model and its other conversations did not
      expect(thread().modelSelection).toEqual({ instanceId: "codex", model: "codex-default" });
      expect(store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(resend).toHaveBeenCalledTimes(1);
      const [botId, threadId, message, replyTo] = resend.mock.calls[0]!;
      expect([botId, threadId]).toEqual([bot.id, bot.threadId]);
      expect(message).toMatchObject({ id: messageId, text: "how's the weather", dataContext: { cardId: "sales" } });
      expect(replyTo).toMatchObject({ id: quoted, text: "It will rain on Friday." });

      const settled = store.messagesFor(bot.threadId).find((m) => m.id === card.id)!.card!;
      expect(settled).toMatchObject({ answered: "answer", answeredText: "Codex" });
      expect(pending()).toBeUndefined();
      expect(notices()).toContainEqual({ name: "notice: continuing on Codex after hitting quota", ok: true });
    });

    it("resends an image-only message, transport tag and all", async () => {
      const text = '<attached-image path="/tmp/x.png" name="x.png"/>';
      const card = (await failed(QUOTA, { messageId: said(text) }))!;
      await answer(card, "Codex");
      expect(resend.mock.calls[0]![2].text).toBe(text);
    });

    it("resends the message whose turn failed, not a newer one written while the card was open", async () => {
      const card = (await failed(QUOTA, { messageId: said("original question") }))!;
      said("a completely different, later message");
      await answer(card, "Codex");
      expect(resend).toHaveBeenCalledTimes(1);
      expect(resend.mock.calls[0]![2].text).toBe("original question");
    });

    it("when the message is gone, switches, posts no 'continuing' line and says to send it again", async () => {
      const messageId = said("will be rewound away");
      const card = (await failed(QUOTA, { messageId }))!;
      store.patchMessage(bot.threadId, messageId, { text: "" });

      await answer(card, "Codex");

      expect(resend).not.toHaveBeenCalled();
      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(notices().some((tool) => tool.name.includes("continuing on"))).toBe(false);
      expect(notices()).toContainEqual({
        name: "notice: switched to Codex, but the message that hit quota could not be found to resend — send it again.", ok: false,
      });
    });

    it("switches and says to send the message again when the card had none to resend", async () => {
      const card = (await failed(QUOTA, { messageId: undefined }))!;
      await answer(card, "Codex");
      expect(resend).not.toHaveBeenCalled();
      expect(thread().modelSelection).toEqual({ instanceId: "codex", model: "codex-default" });
      expect(notices().some((tool) => tool.name.includes("continuing on"))).toBe(false);
      expect(notices().some((tool) => tool.name.includes("send it again"))).toBe(true);
    });

    it("switches nothing when the model-switch gate refuses, and says why", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      switchRefusal = "the bot is working — stop it before changing models";

      await answer(card, "Codex");

      expect(thread().modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({
        name: "notice: could not switch to Codex — the bot is working — stop it before changing models", ok: false,
      });
    });

    it("says so when the switch could not be saved, and resends nothing", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      vi.spyOn(store, "switchTaskModel").mockImplementationOnce(() => { throw new Error("ENOSPC: no space left on device"); });

      await answer(card, "Codex");

      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: could not switch to Codex — the model switch could not be saved.", ok: false });
    });

    it("switches nothing when the chosen engine stopped being available while the card was open", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      engines[1] = engine("codex", "codex", "Codex", { snapshot: async () => ({ state: "unavailable", reason: "signed out" }) });

      await answer(card, "Codex");

      expect(thread().modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: Codex is no longer available — nothing switched.", ok: false });
    });

    it("switches nothing when the chosen engine was removed while the card was open", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      engines = engines.filter((candidate) => candidate.instanceId !== "codex");

      await answer(card, "Codex");

      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: Codex is no longer configured — nothing switched.", ok: false });
    });

    it("switches nothing when the chosen engine ran into its own limit while the card was open", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      const codexThread = store.createTask(bot.id, undefined, false)!.threadId;
      store.switchTaskModel(bot.id, codexThread, { instanceId: "codex", model: "codex-default" }, false, false);
      await quota.turnFailed({ bot: store.projectBotForTask(bot.id, codexThread)!, threadId: codexThread, cause: QUOTA, internal: true });

      await answer(card, "Codex");

      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: Codex is no longer available — nothing switched.", ok: false });
    });

    it("switches but resends nothing while the job runtime still holds this conversation's request", async () => {
      // The failed turn had handed work to teammates: its root waits on them
      // and the runtime resumes it. A resend would start that request twice.
      const card = (await failed(QUOTA, { messageId: said("ask the team for the numbers") }))!;
      held = true;

      await answer(card, "Codex");

      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({
        name: "notice: switched to Codex. The work already under way in this conversation continues there.", ok: true,
      });
    });

    it("says so when the resend could not start", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      resend.mockRejectedValueOnce(new Error("this bot has reached its limit of 3 parallel threads"));

      await answer(card, "Codex");

      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(notices()).toContainEqual({
        name: "notice: could not continue on Codex — this bot has reached its limit of 3 parallel threads", ok: false,
      });
    });

    it("'Not now' settles the card and changes nothing", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      await answer(card, NOT_NOW);
      expect(store.messagesFor(bot.threadId).find((m) => m.id === card.id)!.card).toMatchObject({ answered: "answer", answeredText: NOT_NOW });
      expect(thread().modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toEqual([]);
    });

    it("reads an answer that names none of the offered engines as 'Not now'", async () => {
      // A phone still shows a text box on this card: typed words never switch.
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      await answer(card, "use whatever is fastest");
      expect(store.messagesFor(bot.threadId).find((m) => m.id === card.id)!.card!.answeredText).toBe(NOT_NOW);
      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
    });

    it("frees the thread for a new card once the pending one is answered", async () => {
      const first = (await failed())!;
      await answer(first, NOT_NOW);
      expect(await failed()).toBeTruthy();
      expect(cards()).toHaveLength(2);
    });

    it("leaves a request that is not a pending quota card to its own resolver", async () => {
      expect(quota.answer(bot.threadId, "not-a-quota-request", "Codex")).toBeNull();
      const other = store.appendMessage(bot.threadId, {
        role: "bot", kind: "options", card: { title: "Which file?", subtitle: "", options: ["a.ts"], requestId: "provider-ask" },
      });
      expect(quota.answer(bot.threadId, other.card!.requestId!, "a.ts")).toBeNull();
      const card = (await failed())!;
      await answer(card, NOT_NOW);
      // answered once: a second press belongs to the settled-card path
      expect(quota.answer(bot.threadId, card.card!.requestId!, "Codex")).toBeNull();
      // and a card is only ever answered in its own thread
      const again = (await failed())!;
      expect(quota.answer("another-thread", again.card!.requestId!, "Codex")).toBeNull();
    });

    it("still answers a card raised before a restart", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      // a new process: nothing in memory, the card and its offer on disk
      quota = createQuotaSwitch(deps);
      await answer(card, "Codex");
      expect(thread().modelSelection.instanceId).toBe("codex");
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it("writes nothing into a conversation whose bot was deleted before the switch could land", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      const threadId = bot.threadId;
      const taken = quota.answer(threadId, card.card!.requestId!, "Codex");
      store.deleteBot(bot.id);
      await taken!.done;
      expect(resend).not.toHaveBeenCalled();
      expect(store.messagesFor(threadId)).toEqual([]);
    });

    it("switches nothing from a card answered after it was switched off", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      enabled = false;
      await answer(card, "Codex");
      expect(thread().modelSelection.instanceId).toBe("claude");
      expect(resend).not.toHaveBeenCalled();
      expect(notices()).toContainEqual({ name: "notice: continuing on another engine is switched off — nothing switched.", ok: false });
    });
  });

  describe("a conversation that went on without it", () => {
    it("closes the pending card when a later turn of the thread succeeds, so a stale offer resends nothing", async () => {
      const card = (await failed(QUOTA, { messageId: said("hi") }))!;
      // the person changed the model by hand and sent the message again
      quota.turnSucceeded({ bot: thread(), threadId: bot.threadId });

      expect(store.messagesFor(bot.threadId).find((m) => m.id === card.id)!.card).toMatchObject({ answered: "unavailable", dismissed: true });
      expect(quota.answer(bot.threadId, card.card!.requestId!, "Codex")).toBeNull();
      expect(resend).not.toHaveBeenCalled();
      // and the next limit raises a fresh one
      expect(await failed()).toBeTruthy();
    });

    it("leaves another thread's pending card alone", async () => {
      const card = (await failed())!;
      const otherThread = store.createTask(bot.id, undefined, false)!.threadId;
      quota.turnSucceeded({ bot: store.projectBotForTask(bot.id, otherThread)!, threadId: otherThread });
      expect(pending()?.id).toBe(card.id);
    });
  });
});
