import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import { EFFORT_LEVELS } from "../../shared/wire";
import {
  applyTeamPlan,
  planNeedsLocalAutoConsent,
  planTeamChange,
  teamBots,
  teamEffortChoices,
  teamModelChoices,
  teamResultCounts,
} from "./team-bulk-settings";
import { TeamSettingsRows } from "@/components/TeamSettingsDialog";
import { TeamMenuItems } from "@/components/Sidebar";

vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

const engine = (instanceId: string, driverKind: string, models: string[], extra: Partial<InstanceInfo> = {}) => ({
  instanceId, driverKind, displayName: instanceId[0]!.toUpperCase() + instanceId.slice(1), enabled: true,
  snapshot: { state: "available" },
  models: { default: models[0]!, options: models.map((id) => ({ id, label: id })) },
  ...extra,
}) as unknown as InstanceInfo;

const instances = [
  engine("claude", "claudeAgent", ["opus", "sonnet"], { capabilities: { effortLevels: ["low", "medium", "high", "max"] } }),
  engine("codex", "codex", ["gpt-5", "gpt-5-mini"], { capabilities: { effortLevels: ["low", "medium", "high", "xhigh"] } }),
  engine("pi", "pi", ["local"], { capabilities: { modelVariants: true } }),
];

const bot = (id: string, fields: Partial<Bot> = {}) => ({
  id, threadId: `${id}-t`, name: id, title: "", description: "", notifications: true, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "opus" }, section: "Editing Team", ...fields,
}) as Bot;

describe("team-wide settings", () => {
  it("collects a team's visible bots, General being the bots without a team", () => {
    const bots = [bot("a"), bot("b", { section: " Editing Team " }), bot("c", { hidden: true }), bot("d", { section: undefined })];
    expect(teamBots(bots, "Editing Team").map((b) => b.id)).toEqual(["a", "b"]);
    expect(teamBots(bots, "").map((b) => b.id)).toEqual(["d"]);
  });

  it("plans an approval level per bot: unchanged, busy, unsupported and Full on every thread", () => {
    const bots = [
      bot("ask"),
      bot("already", { approvalMode: "full" }),
      bot("busy", { busy: true }),
      bot("antigravity", { modelSelection: { instanceId: "ag", model: "x" } }),
    ];
    const plan = planTeamChange(bots, [...instances, engine("ag", "antigravityAgent", ["x"])], { kind: "approval", mode: "full" });
    expect(plan.map((row) => row.status)).toEqual(["apply", "unchanged", "skip", "apply"]);
    expect(plan[0]).toMatchObject({ patch: { approvalMode: "full", applyToAllThreads: true } });
    expect(plan[2]).toMatchObject({ reason: expect.stringMatching(/busy/) });
    // Antigravity's picker offers no Auto: the team change says so instead of
    // writing a level that bot's own panel would never offer.
    const auto = planTeamChange([bots[3]!], [engine("ag", "antigravityAgent", ["x"])], { kind: "approval", mode: "auto" });
    expect(auto[0]).toMatchObject({ status: "skip", reason: "Ag does not offer this approval level" });
    expect(planTeamChange([bot("codex", { modelSelection: { instanceId: "codex", model: "gpt-5" } })], instances,
      { kind: "approval", mode: "edits" })[0]).toMatchObject({ status: "skip" });
  });

  it("asks for the local-computer consent only when Auto reaches a bot on this computer", () => {
    expect(planNeedsLocalAutoConsent(planTeamChange([bot("a", { computer: "local" })], instances, { kind: "approval", mode: "auto" }))).toBe(true);
    expect(planNeedsLocalAutoConsent(planTeamChange([bot("a", { computer: "cloud" })], instances, { kind: "approval", mode: "auto" }))).toBe(false);
    expect(planNeedsLocalAutoConsent(planTeamChange([bot("a", { computer: "local" })], instances, { kind: "approval", mode: "ask" }))).toBe(false);
  });

  it("keeps each bot on its own engine and skips models and efforts that engine does not offer", () => {
    const bots = [
      bot("claude", { modelSelection: { instanceId: "claude", model: "sonnet", effort: "low" } }),
      bot("codex", { modelSelection: { instanceId: "codex", model: "gpt-5" } }),
      bot("pi", { modelSelection: { instanceId: "pi", model: "local", variant: "fast" } }),
      bot("gone", { modelSelection: { instanceId: "removed", model: "m" } }),
    ];
    const toOpus = planTeamChange(bots, instances, { kind: "model", model: "opus" });
    expect(toOpus.map((row) => row.status)).toEqual(["apply", "skip", "skip", "skip"]);
    expect(toOpus[0]).toMatchObject({ patch: { modelSelection: { instanceId: "claude", model: "opus", effort: "low" } } });
    expect(toOpus[1]).toMatchObject({ reason: "Codex does not offer opus" });
    expect(toOpus[3]).toMatchObject({ reason: "its engine is not available" });

    const high = planTeamChange(bots, instances, { kind: "model", effort: "high" });
    expect(high.map((row) => row.status)).toEqual(["apply", "apply", "skip", "skip"]);
    expect(high[1]).toMatchObject({ patch: { modelSelection: { instanceId: "codex", model: "gpt-5", effort: "high" } } });
    expect(high[2]).toMatchObject({ reason: "Pi uses reasoning variants instead of effort levels" });
    expect(planTeamChange([bots[0]!], instances, { kind: "model", effort: "xhigh" })[0]).toMatchObject({ status: "skip", reason: "Claude does not offer this effort level" });

    // Clearing the effort, and a variant only following its own model.
    expect(planTeamChange([bots[0]!], instances, { kind: "model", effort: null })[0])
      .toMatchObject({ patch: { modelSelection: { instanceId: "claude", model: "sonnet" } } });
    expect(planTeamChange([bots[2]!], instances, { kind: "model", model: "local" })[0]).toMatchObject({ status: "unchanged" });
    expect(planTeamChange([bot("busy", { busy: true })], instances, { kind: "model", model: "sonnet" })[0]).toMatchObject({ status: "skip" });
  });

  it("lists each model once with the engines offering it, and only effort levels some engine offers", () => {
    const bots = [bot("a"), bot("b", { modelSelection: { instanceId: "codex", model: "gpt-5" } })];
    expect(teamModelChoices(bots, instances).map((choice) => `${choice.id}:${choice.engines.join("+")}`))
      .toEqual(["gpt-5:Codex", "gpt-5-mini:Codex", "opus:Claude", "sonnet:Claude"]);
    expect(teamEffortChoices(bots, instances, EFFORT_LEVELS)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("applies one bot at a time and reports the server's refusal as the skip reason", async () => {
    const bots = [bot("a"), bot("b"), bot("c", { busy: true }), bot("d", { approvalMode: "auto", computer: "local" }), bot("e", { computer: "local" })];
    const plan = planTeamChange(bots, instances, { kind: "approval", mode: "auto" });
    const order: string[] = [];
    let inFlight = 0;
    const results = await applyTeamPlan(plan, async (target, patch) => {
      inFlight++;
      expect(inFlight).toBe(1);
      order.push(`${target.id}:${JSON.stringify(patch)}`);
      await Promise.resolve();
      inFlight--;
      if (target.id === "b") throw new Error("Stop this bot's turn before changing its approval level");
    }, { acknowledgeLocalAuto: true });
    expect(order).toEqual([
      'a:{"approvalMode":"auto"}',
      'b:{"approvalMode":"auto"}',
      'e:{"approvalMode":"auto","acknowledgeLocalAuto":true}',
    ]);
    expect(results.map((row) => row.status)).toEqual(["applied", "skipped", "skipped", "unchanged", "applied"]);
    expect(results[1]).toMatchObject({ reason: "Stop this bot's turn before changing its approval level" });
    expect(teamResultCounts(results)).toEqual({ applied: 2, unchanged: 1, skipped: 2 });
    const markup = renderToStaticMarkup(createElement(TeamSettingsRows, { rows: results }));
    expect(markup).toContain("Skipped: busy. Stop its turn, then try again");
    expect(markup).toContain("Already set");
  });

  it("is offered in the team menu only when the caller passes the owner's action", () => {
    const base = { onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn() };
    expect(renderToStaticMarkup(createElement(TeamMenuItems, base))).not.toContain("Set for all bots");
    expect(renderToStaticMarkup(createElement(TeamMenuItems, { ...base, onSetForAll: vi.fn() }))).toContain("Set for all bots in this team…");
  });
});
