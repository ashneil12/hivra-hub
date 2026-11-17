import { describe, expect, it } from "vitest";
import type { AgentModel } from "../../../../features/sessions/model/models";
import { t3Model, t3Options, t3PickerModels, t3Provider, t3ProviderProblem, type T3Model, type T3Provider } from "./t3Models";

const reasoning = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
};
const opus: T3Model = {
  slug: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  aliases: ["opus", "opus-5.5"],
  capabilities: {
    optionDescriptors: [reasoning, { id: "ultracode", label: "Ultracode", type: "boolean" }, { id: "fastMode", label: "Fast Mode", type: "boolean" }],
  },
};
const provider = (instanceId: string, driver: string, extra: Partial<T3Provider> = {}): T3Provider => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  ...extra,
});
const claude = provider("claudeAgent", "claudeAgent", { displayName: "Claude", models: [opus, { slug: "claude-example-9", name: "Claude Example 9" }] });

describe("the engine's provider for a chat", () => {
  const providers = [
    provider("codex", "codex", { displayName: "Codex", enabled: false }),
    claude,
    provider("claude-example", "claudeAgent"),
    provider("hermes", "acpRegistry"),
    provider("grok-off", "grok", { enabled: false }),
    provider("grok-two", "grok"),
  ];

  it("is the driver's own instance, an instance named after the provider, or the first one switched on", () => {
    expect(t3Provider("claude", providers)?.instanceId).toBe("claudeAgent");
    expect(t3Provider("hermes", providers)?.instanceId).toBe("hermes");
    expect(t3Provider("grok", providers)?.instanceId).toBe("grok-two");
    expect(t3Provider("devin", providers)).toBeUndefined();
  });

  it("is the one asked for by name when the page names one", () => {
    expect(t3Provider("claude", providers, "claude-example")?.instanceId).toBe("claude-example");
    expect(t3Provider("claude", providers, "missing")).toBeUndefined();
  });

  it("says in plain words why a chat cannot run on it", () => {
    expect(t3ProviderProblem("claude", claude)).toBeUndefined();
    expect(t3ProviderProblem("devin", undefined)).toBe("The engine has no provider set up for devin.");
    expect(t3ProviderProblem("codex", providers[0])).toBe("Codex is switched off in the engine.");
    expect(t3ProviderProblem("grok", provider("grok", "grok", { installed: false }))).toBe("grok is not installed for the engine to use.");
  });
});

describe("the engine's model for a chat", () => {
  it("is found by its own id or by one of its other names", () => {
    expect(t3Model(claude, "claude-opus-5-5")).toBe(opus);
    expect(t3Model(claude, "opus")).toBe(opus);
    expect(t3Model(claude, "claude-unlisted")).toBeUndefined();
    expect(t3Model(undefined, "opus")).toBeUndefined();
  });

  it("takes the chat's settings as its own options and leaves out what it does not have", () => {
    expect(t3Options(opus, { effort: "high", fastMode: "true", ultracode: "false", thinking: "true" })).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    expect(t3Options(opus, { effort: "galactic" })).toEqual([]);
    expect(t3Options(opus, undefined)).toEqual([]);
    expect(t3Options(undefined, { effort: "high" })).toEqual([]);
  });

  it("turns on the engine's own switch for a choice this app keeps in the reasoning list", () => {
    expect(t3Options(opus, { effort: "ultracode" })).toEqual([{ id: "ultracode", value: true }]);
  });
});

describe("the picker's list from the engine", () => {
  const effort = { id: "effort", label: "Reasoning", kind: "select" as const, value: "high", options: [{ value: "high", label: "High" }] };
  const known: AgentModel[] = [
    { id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5", nativeId: "claude-opus-5-5" },
    { id: "claude:old", harness: "claude", name: "Example: an older model", nativeId: "claude-old" },
  ];

  it("keeps this app's id and name for a model it knows, and takes the engine's settings when it has none", () => {
    const [, opusRow, example] = t3PickerModels("claude", claude, known);
    expect(opusRow).toMatchObject({ id: "claude:opus-5-5", name: "Claude Opus 5.5", nativeId: "claude-opus-5-5" });
    expect(opusRow.settings?.map((setting) => [setting.id, setting.kind, setting.value])).toEqual([
      ["effort", "select", "medium"],
      ["ultracode", "toggle", "false"],
      ["fastMode", "toggle", "false"],
    ]);
    expect(example).toEqual({ id: "claude:claude-example-9", harness: "claude", name: "Claude Example 9", nativeId: "claude-example-9" });
  });

  it("keeps this app's own settings where it has them, and lists only what the engine can run", () => {
    const list = t3PickerModels("claude", claude, [{ ...known[0], settings: [effort] }, known[1]]);
    expect(list[1].settings).toEqual([effort]);
    expect(list.map((model) => model.id)).toEqual(["claude:opus", "claude:opus-5-5", "claude:claude-example-9"]);
  });

  it("lists a family name that moves with each release ahead of the model it stands for, once", () => {
    const twice = { ...claude, models: [opus, { ...opus, slug: "claude-opus-5-4", name: "Claude Opus 5.4", aliases: ["opus", "opus-5.4"] }] };
    const list = t3PickerModels("claude", twice, known);
    expect(list.map((model) => model.id)).toEqual(["claude:opus", "claude:opus-5-5", "claude:claude-opus-5-4"]);
    expect(list[0]).toMatchObject({ name: "Claude Opus", nativeId: "opus", aliasTarget: "claude-opus-5-5" });
    expect(list[0].settings?.map((setting) => setting.id)).toEqual(["effort", "ultracode", "fastMode"]);
  });
});
