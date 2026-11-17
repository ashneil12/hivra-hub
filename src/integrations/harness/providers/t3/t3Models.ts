// Which of the engine's providers and models a chat runs on. T3 lists what it has (`server.getConfig`): provider
// instances, each with its models, their other names and their options (reasoning, fast mode). The model picker here
// keeps this app's own names and settings for every model it already knows, and takes the rest from the engine.
import type { AgentModel, ModelSetting } from "../../../../features/sessions/model/models";
import type { HarnessId } from "../../../../features/sessions/model/session";

export type T3Option = {
  id: string;
  label: string;
  type: string;
  options?: Array<{ id: string; label: string; isDefault?: boolean }>;
};

export type T3Model = {
  slug: string;
  name: string;
  aliases?: string[];
  isDefault?: boolean;
  capabilities?: { optionDescriptors?: T3Option[] } | null;
};

/** One provider instance of the engine (`ServerProvider` in T3's contracts), as far as this app reads it. */
export type T3Provider = {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  models?: T3Model[];
};

/**
 * T3's driver for each provider this app knows. One with no driver of its own there (Oh My Pi, Hermes, Devin) runs
 * through an instance the engine's settings name after it.
 */
export const T3_DRIVER: Partial<Record<HarnessId, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  pi: "pi",
  fx: "fx",
  antigravity: "antigravity",
};

/**
 * The engine's provider for a chat's provider: the one asked for by name, else the driver's own instance, else the
 * first instance of that driver that is switched on.
 */
export function t3Provider(harness: HarnessId, providers: T3Provider[], named?: string): T3Provider | undefined {
  if (named) return providers.find((provider) => provider.instanceId === named);
  const driver = T3_DRIVER[harness] ?? harness;
  const mine = providers.filter((provider) => provider.driver === driver || provider.instanceId === harness);
  return (
    mine.find((provider) => provider.instanceId === driver || provider.instanceId === harness) ??
    mine.find((provider) => provider.enabled) ??
    mine[0]
  );
}

/** Why a chat cannot run on this provider, in words the chat can show; nothing when it can. */
export function t3ProviderProblem(name: string, provider: T3Provider | undefined): string | undefined {
  if (!provider) return `The engine has no provider set up for ${name}.`;
  const shown = provider.displayName ?? provider.instanceId;
  if (!provider.enabled) return `${shown} is switched off in the engine.`;
  if (!provider.installed) return `${shown} is not installed for the engine to use.`;
  return undefined;
}

/** The engine's model for the name this app sends: its own id, or one of its other names (`opus`). */
export function t3Model(provider: T3Provider | undefined, model: string): T3Model | undefined {
  return (provider?.models ?? []).find((candidate) => candidate.slug === model || candidate.aliases?.includes(model));
}

/**
 * A chat's model settings as the options the engine's model takes. A setting the model does not have is left out; a
 * choice this app keeps in a list and the engine keeps as a switch of its own (Ultracode) turns that switch on.
 */
export function t3Options(
  model: T3Model | undefined,
  settings: Record<string, string> | undefined,
): Array<{ id: string; value: string | boolean }> {
  const known = model?.capabilities?.optionDescriptors ?? [];
  if (!settings || known.length === 0) return [];
  const switches = new Set(known.filter((option) => option.type === "boolean").map((option) => option.id));
  const picked = new Map<string, string | boolean>();
  for (const option of known) {
    const value = settings[option.id];
    if (value === undefined) continue;
    if (option.type === "boolean") {
      if (value === "true") picked.set(option.id, true);
    } else if (option.options?.some((choice) => choice.id === value)) picked.set(option.id, value);
    else if (switches.has(value)) picked.set(value, true);
  }
  return [...picked].map(([id, value]) => ({ id, value }));
}

function settingsFrom(model: T3Model): ModelSetting[] | undefined {
  const settings = (model.capabilities?.optionDescriptors ?? []).flatMap((option): ModelSetting[] => {
    if (option.type === "boolean")
      return [
        {
          id: option.id,
          label: option.label,
          kind: "toggle",
          value: "false",
          options: [
            { value: "true", label: "On" },
            { value: "false", label: "Off" },
          ],
        },
      ];
    const choices = option.options ?? [];
    if (option.type !== "select" || choices.length === 0) return [];
    return [
      {
        id: option.id,
        label: option.label,
        kind: "select",
        value: (choices.find((choice) => choice.isDefault) ?? choices[0]).id,
        options: choices.map((choice) => ({ value: choice.id, label: choice.label })),
      },
    ];
  });
  return settings.length > 0 ? settings : undefined;
}

/**
 * The picker's list for one provider: the engine's models in the engine's order. A model this app already lists keeps
 * its id (so a saved pick still fits), its name and its settings; the engine fills in settings it has none for. A
 * family name that moves with each release (`opus`) is listed ahead of the model it stands for today, as the CLI's own
 * list has it.
 */
export function t3PickerModels(harness: HarnessId, provider: T3Provider, known: AgentModel[]): AgentModel[] {
  const taken = new Set<string>();
  const entry = (nativeId: string, name: string, model: T3Model, aliasTarget?: string): AgentModel[] => {
    const mine = known.find((candidate) => candidate.nativeId === nativeId);
    const settings = mine?.settings ?? settingsFrom(model);
    const made: AgentModel = {
      ...(mine ?? { id: `${harness}:${nativeId}`, harness, name, nativeId }),
      ...(aliasTarget ? { aliasTarget } : {}),
      ...(settings ? { settings } : {}),
    };
    if (taken.has(made.id)) return [];
    taken.add(made.id);
    return [made];
  };
  return (provider.models ?? []).flatMap((model) => [
    ...(model.aliases ?? [])
      .filter((alias) => /^[a-z]+$/.test(alias))
      .flatMap((alias) => entry(alias, model.name.replace(/\s+\d+(\.\d+)*$/, ""), model, model.slug)),
    ...entry(model.slug, model.name, model),
  ]);
}
