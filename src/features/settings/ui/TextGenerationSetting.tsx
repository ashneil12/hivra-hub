// WP-129: who writes titles, commit messages, pull request text and branch names.
import { useState, useSyncExternalStore } from "react";
import {
  CUSTOM_PROVIDERS,
  addressShownFor,
  defaultBaseUrl,
  defaultModelId,
  type CustomProvider,
} from "../../sessions/model/customModels";
import {
  loadTextGeneration,
  readTextGeneration,
  saveTextGeneration,
  subscribeTextGeneration,
  type TextGenerationSetting as SavedTextGeneration,
} from "../model/textGeneration";

type Draft = {
  provider: CustomProvider;
  model: string;
  baseUrl: string;
};

const savedOrMissing = (): SavedTextGeneration | null => null;

function isProvider(value: string): value is CustomProvider {
  return CUSTOM_PROVIDERS.some((provider) => provider.id === value);
}

export function TextGenerationSetting() {
  const saved = useSyncExternalStore(subscribeTextGeneration, loadTextGeneration, savedOrMissing);
  // A draft is an edit that has not been saved. Another window must not wipe it.
  const [draft, setDraft] = useState<Draft | null>(null);
  const shown: Draft | { provider: "agent"; model: ""; baseUrl: "" } = draft
    ?? (saved
      ? { provider: saved.provider, model: saved.model, baseUrl: saved.baseUrl }
      : { provider: "agent", model: "", baseUrl: "" });

  function pick(value: string) {
    if (value === "agent") {
      setDraft(null);
      saveTextGeneration(null);
      return;
    }
    if (!isProvider(value)) return;
    if (value === "custom") {
      setDraft({
        provider: "custom",
        model: saved?.provider === "custom" ? saved.model : "",
        baseUrl: saved?.provider === "custom" ? saved.baseUrl : "",
      });
      return;
    }
    setDraft(null);
    saveTextGeneration({
      provider: value,
      model: defaultModelId(value),
      baseUrl: defaultBaseUrl(value),
    });
  }

  function edit(patch: Partial<Pick<Draft, "model" | "baseUrl">>) {
    if (shown.provider === "agent") return;
    setDraft({
      provider: shown.provider,
      model: patch.model ?? shown.model,
      baseUrl: patch.baseUrl ?? shown.baseUrl,
    });
  }

  function commit() {
    if (!draft) return;
    const clean = readTextGeneration(draft);
    if (!clean) return;
    setDraft(null);
    saveTextGeneration(clean);
  }

  return (
    <fieldset
      id="setting-text-generation"
      data-setting-id="text-generation"
      className="m-0 flex flex-col gap-2 border-0 p-0"
    >
      <legend className="text-[13px]">Short text</legend>
      <p className="m-0 text-[12px]">
        Titles, commit messages, pull request text and branch names. Pick the coding agent to keep using it for those.
      </p>
      <label className="flex flex-col gap-1 text-[12px]">
        Who writes short text
        <select aria-label="Who writes short text" value={shown.provider} onChange={(event) => pick(event.target.value)}>
          <option value="agent">The coding agent</option>
          {CUSTOM_PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.id === "custom" ? "Custom address" : provider.name}
            </option>
          ))}
        </select>
      </label>
      {shown.provider === "agent" ? null : (
        <label className="flex flex-col gap-1 text-[12px]">
          Model
          <input
            aria-label="Model"
            value={shown.model}
            onChange={(event) => edit({ model: event.target.value })}
            onBlur={commit}
          />
        </label>
      )}
      {shown.provider !== "agent" && shown.provider !== "custom" && addressShownFor(shown.provider, shown.baseUrl) ? (
        // A named provider on a stored proxy address: the key is sent there, so say where. The default needs no line.
        <div className="flex flex-col gap-1 text-[12px]">
          <span>Sent to</span>
          <span data-saved-address>{addressShownFor(shown.provider, shown.baseUrl)}</span>
        </div>
      ) : null}
      {shown.provider === "custom" ? (
        <label className="flex flex-col gap-1 text-[12px]">
          Address
          <input
            aria-label="Address"
            value={shown.baseUrl}
            onChange={(event) => edit({ baseUrl: event.target.value })}
            onBlur={commit}
          />
        </label>
      ) : null}
    </fieldset>
  );
}
