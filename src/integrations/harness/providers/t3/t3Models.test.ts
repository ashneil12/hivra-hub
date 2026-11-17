import { describe, expect, it } from "vitest";
import type { AgentModel } from "../../../../features/sessions/model/models";
import { t3Availability, t3ProviderFacts, t3SetUp, t3TurnOn, t3Model, t3Options, t3PickerModels, t3Provider, t3ProviderProblem, type T3Model, type T3Provider } from "./t3Models";

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

  it("says which of this app's providers the engine can run, and why not for the rest", () => {
    const signedIn = { ...claude, version: "2.1.50", status: "ready", auth: { status: "authenticated", label: "Claude Max", email: "example@example.com" } };
    const providers = [signedIn, provider("codex", "codex", { displayName: "Codex", enabled: false }), provider("cursor", "cursor", { installed: false })];
    const title = (harness: string) => ({ claude: "Claude Code", hermes: "Hermes" })[harness] ?? harness;
    const said = t3Availability(["claude", "codex", "cursor", "hermes"], providers, title);
    expect(said.available).toEqual({ claude: true, codex: false, cursor: false, hermes: false });
    expect(said.why).toEqual({
      codex: "Codex is switched off in the engine.",
      cursor: "cursor is not installed for the engine to use.",
      hermes: "The engine has no provider set up for Hermes.",
    });
    // What Settings says on the row of one it can run.
    expect(said.facts).toEqual({
      claude: { version: "2.1.50", signedIn: true, plan: "Claude Max", email: "example@example.com" },
      // Switched off is not "install it": the row offers to turn it on.
      codex: { off: true },
      // No driver for it in the engine, but it speaks the protocol the engine's generic driver runs.
      hermes: { setUp: true },
    });
    expect(t3ProviderFacts(provider("codex", "codex", { status: "error", message: "Example: the CLI is too old.", auth: { status: "unauthenticated" } }))).toEqual({
      signedIn: false,
      note: "Example: the CLI is too old.",
    });
    expect(t3ProviderFacts(provider("pi", "pi", { status: "ready", message: "Example: fine.", auth: { status: "unknown" } }))).toEqual({});
    // A dev page that names one provider runs every chat on it.
    const replay = t3Availability(["claude", "hermes"], [...providers, provider("devReplay", "devReplay")], title, "devReplay");
    expect(replay).toEqual({ available: { claude: true, hermes: true }, why: {}, facts: { claude: {}, hermes: {} } });
  });

  it("switches one provider on without sending the engine a list that would replace the others", () => {
    expect(t3TurnOn(provider("grok", "grok", { enabled: false }), undefined)).toEqual({
      patch: {},
      providerInstanceMutation: { operation: "upsert", instanceId: "grok", instance: { driver: "grok", enabled: true } },
    });
    // What the engine keeps for it stays.
    const kept = { driver: "acpRegistry", displayName: "Example agent", enabled: false, config: { commandPath: "/usr/local/bin/example" } };
    expect(t3TurnOn(provider("example", "acpRegistry", { enabled: false }), kept).providerInstanceMutation.instance).toEqual({ ...kept, enabled: true });
  });

  it("gives a tool the engine has no driver for a provider that runs the tool's own command", () => {
    expect(t3SetUp("hermes", "/Users/example/.local/bin/hermes")).toEqual({
      patch: {},
      providerInstanceMutation: {
        operation: "create",
        instanceId: "hermes",
        instance: {
          driver: "acpRegistry",
          displayName: "Hermes Agent",
          config: { source: "local", commandPath: "/Users/example/.local/bin/hermes", commandArgs: ["acp"] },
        },
      },
    });
    // Not found by this app: the engine looks the command up by name.
    expect((t3SetUp("devin")?.providerInstanceMutation.instance.config as { commandPath: string }).commandPath).toBe("devin");
    expect(t3SetUp("claude")).toBeUndefined();
    // Once set up, the provider named after the tool is the one its chats run on.
    expect(t3Provider("hermes", [provider("hermes", "acpRegistry")])?.instanceId).toBe("hermes");
  });
});
