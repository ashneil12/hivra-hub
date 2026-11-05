// WP-84: the project's default path, and whether a review waits.

import { useState } from "react";
import { modelsFor } from "../../sessions/model/models";
import { loadPhaseSettings, savePhaseSettings } from "../model/store";
import type { PathId } from "../model/settings";

const PATHS: { id: PathId; label: string }[] = [
  { id: "straight", label: "Straight build" },
  { id: "research-plan-build", label: "Research, plan, build" },
  { id: "product-first", label: "Product first" },
];

export function PhaseSettings({ projectKey }: { projectKey: string }) {
  const [settings, setSettings] = useState(() => loadPhaseSettings(projectKey));
  const models = modelsFor("claude");
  const keep = (next: unknown) => setSettings(savePhaseSettings(projectKey, next));
  return (
    <section aria-label="Phase settings" className="mt-8">
      <h3 className="text-[13px] text-content">Phases</h3>
      <p className="mt-1 text-[12px] text-content/70">How much process a task gets before anyone builds it. A small task still goes straight to building.</p>
      <label className="mt-2 block text-[12px] text-content/70">
        Default path
        <select
          aria-label="Default path"
          className="ml-2 bg-transparent text-content"
          value={settings.defaultPath}
          onChange={(event) => keep({ ...settings, defaultPath: event.target.value })}
        >
          {PATHS.map((path) => (
            <option key={path.id} value={path.id}>
              {path.label}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-[12px] text-content/70">
        <input
          type="checkbox"
          className="mr-2"
          checked={settings.continueWithoutWaiting}
          onChange={(event) => keep({ ...settings, continueWithoutWaiting: event.target.checked })}
        />
        Continue without waiting
      </label>
      <label className="mt-2 block text-[12px] text-content/70">
        Search model
        <select
          aria-label="Search model"
          className="ml-2 bg-transparent text-content"
          value={settings.models.search}
          onChange={(event) => keep({ ...settings, models: { ...settings.models, search: event.target.value } })}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-[12px] text-content/70">
        Judgment model
        <select
          aria-label="Judgment model"
          className="ml-2 bg-transparent text-content"
          value={settings.models.judgment}
          onChange={(event) => keep({ ...settings, models: { ...settings.models, judgment: event.target.value } })}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
