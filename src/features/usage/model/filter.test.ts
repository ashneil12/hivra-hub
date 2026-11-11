import { describe, expect, it } from "vitest";
import { buildUsageHistory, type UsageSession } from "./history";
import {
  applyUsageFilter,
  defaultUsageFilter,
  usageFilterChoices,
  usageFilterFrom,
  usageFilterIsAll,
} from "./filter";

const NOW = new Date(2026, 10, 6, 15).getTime();

function session(
  id: string,
  harness: string,
  model: string,
  blocks: UsageSession["blocks"],
): UsageSession {
  return { id, cwd: "/work/app", harness, model, blocks };
}

function turn(
  id: string,
  harness: string,
  model: string,
  inputTokens: number,
): UsageSession["blocks"][number] {
  return {
    id,
    role: "user",
    startedAt: NOW,
    turnMetrics: { inputTokens },
    turnModel: { harness, name: model },
  };
}

const mixed = session("s1", "claude", "sonnet-5", [
  turn("a", "claude", "sonnet-5", 100),
  turn("b", "codex", "gpt-5", 40),
  { id: "note", role: "assistant", text: "not a turn" },
]);

const again = session("s2", "claude", "sonnet-5", [turn("a", "claude", "sonnet-5", 5)]);

describe("usage filter", () => {
  it("defaults to every provider and every model", () => {
    const filter = defaultUsageFilter();
    expect(usageFilterIsAll(filter)).toBe(true);
    const filtered = applyUsageFilter([mixed, again], filter);
    expect(filtered).toEqual([mixed, again]);
    expect(filtered[0]).toBe(mixed);
    const history = buildUsageHistory(filtered, { now: NOW });
    expect(history.last30.inputTokens).toBe(145);
    expect(history.byEngine.map((row) => row.key).sort()).toEqual(["claude", "codex"]);
    expect(history.byModel.map((row) => row.key).sort()).toEqual(["gpt-5", "sonnet-5"]);
  });

  it("keeps one provider, one model, or both, and does not change the input", () => {
    const before = mixed.blocks.length;
    const byProvider = applyUsageFilter([mixed], { provider: "codex", model: "" });
    expect(buildUsageHistory(byProvider, { now: NOW }).last30.inputTokens).toBe(40);
    expect(buildUsageHistory(byProvider, { now: NOW }).byModel.map((row) => row.label)).toEqual(["gpt-5"]);

    const byModel = applyUsageFilter([mixed, again], { provider: "", model: "sonnet-5" });
    expect(buildUsageHistory(byModel, { now: NOW }).last30.inputTokens).toBe(105);
    expect(buildUsageHistory(byModel, { now: NOW }).byEngine.map((row) => row.key)).toEqual(["claude"]);

    const both = applyUsageFilter([mixed], { provider: "claude", model: "gpt-5" });
    expect(both).toEqual([]);

    expect(mixed.blocks).toHaveLength(before);
    expect(mixed.blocks.some((block) => block.id === "b")).toBe(true);
  });

  it("lists each provider and model once, and limits models to the chosen provider", () => {
    const all = usageFilterChoices([mixed, again, mixed]);
    expect(all.providers.map((choice) => choice.id)).toEqual(["claude", "codex"]);
    expect(all.providers.map((choice) => choice.label)).toEqual(["Claude Code", "Codex"]);
    expect(all.models.map((choice) => choice.id)).toEqual(["gpt-5", "sonnet-5"]);

    const claude = usageFilterChoices([mixed, again], "claude");
    expect(claude.providers.map((choice) => choice.id)).toEqual(["claude", "codex"]);
    expect(claude.models.map((choice) => choice.id)).toEqual(["sonnet-5"]);

    expect(usageFilterChoices([], "nope")).toEqual({ providers: [], models: [] });
    expect(usageFilterChoices(null, "")).toEqual({ providers: [], models: [] });
  });

  it("falls back to all for an unreadable filter, and drops an unknown name", () => {
    for (const value of [null, undefined, "codex", 4, [], { provider: 1 }, { model: "  " }, { provider: "all", model: "All" }]) {
      expect(usageFilterIsAll(usageFilterFrom(value))).toBe(true);
    }
    expect(usageFilterFrom({ provider: " codex\r", model: "gpt-5\r\n" })).toEqual({
      provider: "codex",
      model: "gpt-5",
    });

    const none = applyUsageFilter([mixed], { provider: "missing", model: "" });
    expect(none).toEqual([]);
    expect(applyUsageFilter(undefined, defaultUsageFilter())).toEqual([]);
    expect(applyUsageFilter([null as unknown as UsageSession, mixed], { provider: "claude", model: "" }).map((item) => item.id)).toEqual(["s1"]);
  });

  it("uses the session provider when a turn names none, and a blank model as unknown", () => {
    const bare = session("bare", "claude", "", [
      { id: "t", role: "user", startedAt: NOW, turnMetrics: { inputTokens: 7 } },
    ]);
    const choices = usageFilterChoices([bare]);
    expect(choices.providers).toEqual([{ id: "claude", label: "Claude Code" }]);
    expect(choices.models).toEqual([{ id: "Unknown model", label: "Unknown model" }]);
    expect(buildUsageHistory(applyUsageFilter([bare], { provider: "", model: "Unknown model" }), { now: NOW }).last30.inputTokens).toBe(7);
    expect(applyUsageFilter([bare], { provider: "codex", model: "" })).toEqual([]);
  });

  it("ignores a turn with no usable counts, and a duplicate block id still filters once", () => {
    const messy = session("m", "claude", "sonnet-5", [
      { id: "bad", role: "user", startedAt: NOW, turnMetrics: { inputTokens: Number.NaN } },
      turn("a", "claude", "sonnet-5", 3),
      turn("a", "codex", "gpt-5", 9),
    ]);
    const choices = usageFilterChoices([messy]);
    expect(choices.models.map((choice) => choice.id)).toEqual(["gpt-5", "sonnet-5"]);
    const history = buildUsageHistory(applyUsageFilter([messy], { provider: "codex", model: "" }), { now: NOW });
    expect(history.last30.inputTokens).toBe(9);
    expect(history.last30.turns).toBe(1);
  });
});
