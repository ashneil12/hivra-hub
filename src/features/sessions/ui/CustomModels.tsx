import { useState, useSyncExternalStore } from "react";
import { Plus } from "../../../shared/ui/icons";
import {
  addCustomModel,
  CUSTOM_PROVIDERS,
  customModelsVersion,
  emptyForm,
  listCustomModels,
  needsKey,
  providerName,
  removeCustomModel,
  showsBaseUrl,
  subscribeCustomModels,
  testCustomModel,
  validateCustomModel,
  defaultBaseUrl,
  type CustomModel,
  type CustomModelForm,
  type CustomProvider,
  type KeyTestResult,
} from "../model/customModels";

export function useCustomModels(): CustomModel[] {
  useSyncExternalStore(subscribeCustomModels, customModelsVersion, customModelsVersion);
  return listCustomModels();
}

/** "Other models": Ash's own models under the subscription list, each tagged "billed separately", then Add model. */
export function OtherModelsSection({
  query,
  currentModel,
  onPick,
  onAdd,
}: {
  query: string;
  currentModel: string;
  onPick: (model: CustomModel) => void;
  onAdd: () => void;
}) {
  const all = useCustomModels();
  // Removing is a big deal (it also deletes the key), so it asks first.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const models = needle
    ? all.filter((m) => `${m.name} ${providerName(m.provider)} ${m.modelId}`.toLowerCase().includes(needle))
    : all;
  if (needle && !models.length) return null;
  return (
    <div role="group" aria-label="Other models" data-other-models className="mt-1 border-t border-stroke pt-1">
      <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/40">Other models</div>
      {models.map((m) =>
        confirming === m.id ? (
          <div key={m.id} data-remove-confirm={m.id} className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-content/80">
            <span className="min-w-0 flex-1 truncate">Remove {m.name} and its key?</span>
            <button
              type="button"
              data-remove-keep
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setConfirming(null)}
              className="rounded-md px-2 py-0.5 text-content/60 hover:bg-content/8"
            >
              Keep
            </button>
            <button
              type="button"
              data-remove-yes
              onMouseDown={(e) => e.preventDefault()}
              onClick={async () => {
                try {
                  await removeCustomModel(m.id);
                  setProblem(null);
                } catch {
                  setProblem("Couldn't remove the key from the Keychain, so the model was kept");
                }
                setConfirming(null);
              }}
              className="rounded-md bg-red-500/15 px-2 py-0.5 text-red-400 hover:bg-red-500/25"
            >
              Remove
            </button>
          </div>
        ) : (
        <div key={m.id} className="group relative">
        <button
          key={m.id}
          type="button"
          role="option"
          aria-selected={currentModel === `custom:${m.id}`}
          aria-label={`${m.name}, ${providerName(m.provider)}, billed separately`}
          data-custom-model={m.id}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(m)}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-content hover:bg-content/5"
        >
          <span className="min-w-0 flex-1 truncate">{m.name}</span>
          <span className="shrink-0 text-[10px] text-content/40 group-hover:invisible" data-billed-separately>billed separately</span>
        </button>
        <button
          type="button"
          data-remove-model={m.id}
          aria-label={`Remove ${m.name}`}
          title="Remove"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setConfirming(m.id)}
          className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1.5 text-[12px] text-content/45 hover:bg-content/8 hover:text-content/80 group-hover:block"
        >
          ×
        </button>
        </div>
        ),
      )}
      {problem ? <div className="px-2.5 py-1 text-[11px] text-content/55" data-remove-problem>{problem}</div> : null}
      {needle ? null : (
        <button
          type="button"
          data-add-model
          onMouseDown={(e) => e.preventDefault()}
          onClick={onAdd}
          className="flex h-8 w-full items-center gap-1.5 rounded-lg px-2.5 text-left text-[12px] text-content/50 hover:bg-content/5 hover:text-content/70"
        >
          <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
          Add model
        </button>
      )}
    </div>
  );
}

const input =
  "w-full rounded-md border border-content/15 bg-content/3 px-2 py-1.5 text-[12px] text-content outline-none placeholder:text-content/35 focus:border-content/35";

/** Name, provider, model id and a masked key; Test first, then Save. The key goes to the key store, never settings. */
export function AddModelForm({ onDone, onCancel }: { onDone: (model: CustomModel) => void; onCancel: () => void }) {
  const [form, setForm] = useState<CustomModelForm>(() => emptyForm());
  const [touched, setTouched] = useState(false);
  const [test, setTest] = useState<KeyTestResult | "testing" | null>(null);
  const [saving, setSaving] = useState(false);
  const errors = validateCustomModel(form);
  const valid = Object.keys(errors).length === 0;
  const passed = test !== null && test !== "testing" && test.ok;
  // Any change after a test means it has to be tested again.
  const set = (patch: Partial<CustomModelForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setTest(null);
  };
  const field = (name: keyof CustomModelForm) =>
    touched && errors[name] ? <span className="text-[11px] text-content/55" data-form-error={name}>{errors[name]}</span> : null;
  const keyed = needsKey(form.provider);
  return (
    <div className="flex flex-col gap-2.5 p-2" data-add-model-form onKeyDown={(e) => e.stopPropagation()}>
      <div className="text-[13px] text-content">Add a model</div>
      <label className="flex flex-col gap-1 text-[11px] text-content/55">
        Name
        <input className={input} value={form.name} placeholder="Grok" aria-label="Name" onChange={(e) => set({ name: e.target.value })} />
        {field("name")}
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-content/55">
        Provider
        <select
          className={input}
          aria-label="Provider"
          value={form.provider}
          onChange={(e) => {
            const provider = e.target.value as CustomProvider;
            set({ provider, baseUrl: defaultBaseUrl(provider), key: needsKey(provider) ? form.key : "" });
          }}
        >
          {CUSTOM_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      {showsBaseUrl(form.provider) ? (
        <label className="flex flex-col gap-1 text-[11px] text-content/55">
          Base URL
          <input className={input} value={form.baseUrl} placeholder="https://…/v1" aria-label="Base URL" onChange={(e) => set({ baseUrl: e.target.value })} />
          {field("baseUrl")}
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-[11px] text-content/55">
        Model id
        <input className={input} value={form.modelId} placeholder={form.provider === "ollama" ? "llama3.2" : "grok-4"} aria-label="Model id" onChange={(e) => set({ modelId: e.target.value })} />
        {field("modelId")}
      </label>
      {keyed ? (
        <label className="flex flex-col gap-1 text-[11px] text-content/55">
          Key
          <input
            className={input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.key}
            placeholder="Kept in your Keychain"
            aria-label="Key"
            onChange={(e) => set({ key: e.target.value })}
          />
          {field("key")}
        </label>
      ) : null}
      {test && test !== "testing" ? (
        <div className="flex items-center gap-1.5 text-[12px] text-content/70" data-key-test={test.ok ? "ok" : "failed"}>
          <span className={`size-1.5 shrink-0 rounded-full ${test.ok ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden />
          {test.message}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button type="button" onClick={onCancel} className="rounded-md px-2.5 py-1 text-[12px] text-content/60 hover:bg-content/8">
          Cancel
        </button>
        <button
          type="button"
          data-test-key
          disabled={test === "testing"}
          onClick={async () => {
            setTouched(true);
            if (!valid) return;
            setTest("testing");
            setTest(await testCustomModel(form));
          }}
          className="rounded-md bg-content/8 px-2.5 py-1 text-[12px] text-content/85 hover:bg-content/12 disabled:opacity-40"
        >
          {test === "testing" ? "Testing…" : keyed ? "Test key" : "Test connection"}
        </button>
        <button
          type="button"
          data-save-model
          disabled={!valid || !passed || saving}
          onClick={async () => {
            setSaving(true);
            try {
              onDone(await addCustomModel(form));
            } finally {
              setSaving(false);
            }
          }}
          className="rounded-md bg-selection px-2.5 py-1 text-[12px] text-content hover:bg-selection-hover disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}
