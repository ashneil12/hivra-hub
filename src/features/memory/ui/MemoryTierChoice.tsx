// WP-103: the three memory tiers, in plain words, at the top of Settings > Memory. Presentational on purpose: the
// wrapper below wires localStorage and the model list, and a browser test drives this one directly.

import { useState, useSyncExternalStore } from "react";
import { customModelsVersion, listCustomModels, subscribeCustomModels } from "../../sessions/model/customModels";
import { testCheapModel } from "../model/cheapAsk";
import { saveMemoryTier, tierLabel, useMemoryTier, type MemoryTier, type TierChoice } from "../model/tier";

export type TierModel = { id: string; name: string };

const OPTIONS: { tier: MemoryTier; summary: string }[] = [
  {
    tier: "rules",
    summary: "Nothing leaves this Mac. A fact is kept only when you say to remember it, or when your next message says the reply was wrong.",
  },
  {
    tier: "cheap",
    summary: "The text of each finished turn, with up to 30 facts already kept, goes to a model you pick from Other models, billed by its provider. You need its key saved there.",
  },
  {
    tier: "crew",
    summary: "The text of each finished turn, with up to 30 facts already kept, goes to your crew's signed-in CLI, and comes out of your plan. This is the default.",
  },
];

const ROW = "flex cursor-pointer items-start gap-2 rounded-md border border-content/10 px-3 py-2 text-sm";

export function MemoryTierChoice({
  value,
  models,
  onChange,
  test = testCheapModel,
}: {
  value: TierChoice;
  models: readonly TierModel[];
  onChange: (choice: TierChoice) => void;
  /** "Test this model": one tiny call. A parameter so the browser test can drive it without a key. */
  test?: (modelId: string | undefined) => Promise<{ ok: boolean; message: string }>;
}) {
  const picked = value.tier === "cheap" ? models.find((model) => model.id === value.model) : undefined;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; message: string } | undefined>();
  return (
    <section className="flex flex-col gap-2" aria-label="How Hivra remembers">
      <p className="text-sm">How Hivra remembers</p>
      <div role="radiogroup" aria-label="How Hivra remembers" className="flex flex-col gap-2">
        {OPTIONS.map((option) => (
          <label key={option.tier} className={ROW} data-tier={option.tier}>
            <input
              type="radio"
              name="memory-tier"
              className="mt-1"
              checked={value.tier === option.tier}
              onChange={() =>
                onChange(option.tier === "cheap" ? { tier: "cheap", ...(picked ? { model: picked.id } : models[0] ? { model: models[0].id } : {}) } : { tier: option.tier })
              }
            />
            <span className="flex flex-col gap-0.5">
              <span data-tier-label>{tierLabel(option.tier)}</span>
              <span className="text-content/60" data-tier-cost>
                {option.summary}
              </span>
            </span>
          </label>
        ))}
      </div>
      {value.tier === "cheap" ? (
        models.length === 0 ? (
          <p className="text-sm" data-tier-no-model>
            Add a model under Other models first, with its key, then pick it here.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1 text-sm">
              The model to use
              <select
                aria-label="The model to use"
                className="rounded-md border border-content/15 bg-transparent px-2 py-1"
                value={value.model && picked ? value.model : ""}
                onChange={(event) => {
                  setChecked(undefined);
                  onChange({ tier: "cheap", ...(event.target.value ? { model: event.target.value } : {}) });
                }}
              >
                {value.model && picked ? null : <option value="">Pick a model</option>}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={checking || !picked}
              className="self-start rounded-md border border-content/15 px-2 py-1 text-sm disabled:opacity-50"
              onClick={async () => {
                setChecking(true);
                setChecked(undefined);
                try {
                  setChecked(await test(value.model));
                } finally {
                  setChecking(false);
                }
              }}
            >
              {checking ? "Testing" : "Test this model"}
            </button>
            {checked ? (
              <p className={checked.ok ? "text-sm" : "text-sm text-content/60"} role="status" data-tier-test>
                {checked.message}
              </p>
            ) : null}
          </div>
        )
      ) : null}
      <p className="text-xs text-content/50">A change starts with your next turn. What is already remembered stays.</p>
    </section>
  );
}

/** The saved setting, and the models the person has already added. */
export function MemoryTierSetting() {
  const choice = useMemoryTier();
  // The version, not the list: listCustomModels builds a new array and would re-render forever.
  useSyncExternalStore(subscribeCustomModels, customModelsVersion, customModelsVersion);
  const models = listCustomModels();
  return (
    <MemoryTierChoice
      value={choice}
      models={models.map((model) => ({ id: model.id, name: model.name }))}
      onChange={saveMemoryTier}
    />
  );
}
