// "Other models" in the model picker: models Ash adds himself (Grok first), billed by their own provider rather than
// his subscription. Only metadata lives in settings. The key goes through ModelKeyStore, which CoS wires to the macOS
// Keychain; in dev and tests it is an in-memory stub. A key never touches localStorage or a file from here.
import { invoke } from "@tauri-apps/api/core";
import type { ModelTarget } from "./session";
import { TEXT_MODEL as GROK_MODEL } from "../../../integrations/harness/providers/grok/grokProtocol";

export type CustomProvider = "xai" | "openrouter" | "deepseek" | "ollama" | "custom";

/**
 * The model each provider gets without asking. xAI takes the Grok harness's own TEXT_MODEL, so it moves with the
 * harness (one place); OpenRouter routes the same Grok by its "x-ai/" name; DeepSeek's chat model; Ollama's small
 * Llama. Custom has none: its model id is under Advanced.
 */
export const CUSTOM_PROVIDERS: { id: CustomProvider; name: string; baseUrl: string }[] = [
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434" },
  { id: "custom", name: "Custom", baseUrl: "" },
];
/** Read when asked, not at load: the Grok harness module and this one import each other through models.ts. */
export function defaultModelId(id: CustomProvider): string {
  switch (id) {
    case "xai": return GROK_MODEL;
    case "openrouter": return `x-ai/${GROK_MODEL}`;
    case "deepseek": return "deepseek-chat";
    case "ollama": return "llama3.2";
    default: return "";
  }
}
/** The model id field is always visible now (land-5); kept for callers that still ask. */
export function showsAdvanced(_id: CustomProvider): boolean {
  return false;
}

export function providerName(id: CustomProvider): string {
  return CUSTOM_PROVIDERS.find((p) => p.id === id)?.name ?? id;
}
export function defaultBaseUrl(id: CustomProvider): string {
  return CUSTOM_PROVIDERS.find((p) => p.id === id)?.baseUrl ?? "";
}
/** Ollama runs on this Mac and needs no key. */
export function needsKey(id: CustomProvider): boolean {
  return id !== "ollama";
}
/** Every provider shows its address: Custom must fill it in, the rest are prefilled and editable. */
export function showsBaseUrl(_id: CustomProvider): boolean {
  return true;
}

/** What settings keep for a custom model. Never a key. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export function reasoningEfforts(value: unknown): ReasoningEffort[] {
  return Array.isArray(value) ? REASONING_EFFORTS.filter((level) => value.includes(level)) : [];
}
/** Only levels explicitly enabled for this model are offered or sent. */
export type CustomModel = { id: string; name: string; provider: CustomProvider; baseUrl: string; modelId: string; reasoningEfforts?: ReasoningEffort[] };

const KEY = "monocode:custom-models";
const CHANGED = "monocode:custom-models-change";

export const CUSTOM_MODEL_PREFIX = "custom:";
export function isCustomModelId(model: string | undefined): boolean {
  return !!model?.startsWith(CUSTOM_MODEL_PREFIX);
}

/** Every custom model, Grok (xAI) first, then in the order added. */
export function listCustomModels(): CustomModel[] {
  let list: CustomModel[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed))
      list = parsed.filter((m): m is CustomModel => !!m && typeof m.id === "string" && typeof m.name === "string" && typeof m.modelId === "string");
  } catch {
    list = [];
  }
  return [...list.filter((m) => m.provider === "xai"), ...list.filter((m) => m.provider !== "xai")];
}

export function findCustomModel(model: string | undefined): CustomModel | undefined {
  if (!isCustomModelId(model)) return undefined;
  const id = model!.slice(CUSTOM_MODEL_PREFIX.length);
  return listCustomModels().find((m) => m.id === id);
}

let version = 0;
export function customModelsVersion(): number {
  return version;
}
export function subscribeCustomModels(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}

/** Metadata only: whatever is passed, a key-like field is dropped before anything is written. */
function writeModels(list: CustomModel[]): void {
  const clean = list.map(({ id, name, provider, baseUrl, modelId, reasoningEfforts: levels }) => ({ id, name, provider, baseUrl, modelId, ...(reasoningEfforts(levels).length ? { reasoningEfforts: reasoningEfforts(levels) } : {}) }));
  localStorage.setItem(KEY, JSON.stringify(clean));
  version++;
  window.dispatchEvent(new CustomEvent(CHANGED));
}

/**
 * Models from a setup import: each one whose id isn't here yet is added, metadata only (writeModels drops anything
 * key-like). Its key is entered again on this Mac. Returns how many were added.
 */
export function importCustomModels(models: readonly unknown[]): number {
  const have = listCustomModels();
  const ids = new Set(have.map((m) => m.id));
  const add = models.filter(
    (m): m is CustomModel =>
      !!m && typeof m === "object" && typeof (m as CustomModel).id === "string" && typeof (m as CustomModel).name === "string" &&
      typeof (m as CustomModel).modelId === "string" && CUSTOM_PROVIDERS.some((p) => p.id === (m as CustomModel).provider) && !ids.has((m as CustomModel).id),
  );
  if (add.length) writeModels([...have, ...add]);
  return add.length;
}

// ---- the form -------------------------------------------------------------------------------------------------------

export type CustomModelForm = { name: string; provider: CustomProvider; baseUrl: string; modelId: string; key: string; reasoningEfforts?: ReasoningEffort[] };

export function emptyForm(provider: CustomProvider = "xai"): CustomModelForm {
  return { name: "", provider, baseUrl: defaultBaseUrl(provider), modelId: defaultModelId(provider), key: "" };
}

/** Plain-words problems with the form, by field. Empty when it can be tested. */
export function validateCustomModel(form: CustomModelForm): Partial<Record<keyof CustomModelForm, string>> {
  const errors: Partial<Record<keyof CustomModelForm, string>> = {};
  if (!form.name.trim()) errors.name = "Give it a name";
  if (!form.modelId.trim()) errors.modelId = "Add the model id";
  else if (/\s/.test(form.modelId.trim())) errors.modelId = "The model id has no spaces";
  if (showsBaseUrl(form.provider)) {
    const url = form.baseUrl.trim();
    if (!url) errors.baseUrl = "Add your provider's address";
    else if (!/^https?:\/\/[^\s/]+/.test(url)) errors.baseUrl = "The address starts with https://";
    else if (/anthropic\.com|\/anthropic\b|claude\.ai/i.test(url))
      errors.baseUrl = "Use the provider's OpenAI-style address (usually ending in /v1), not an Anthropic one";
  }
  if (needsKey(form.provider) && !form.key.trim()) errors.key = "Add the key";
  return errors;
}

// ---- the key store (CoS wires this to the Keychain) ------------------------------------------------------------------

/** `code` is the backend's error identifier, when it has one (see CLAUDE_KEY_ERROR). */
export type KeyTestResult = { ok: true; message: string } | { ok: false; message: string; code?: string };

/**
 * The backend's own words for a pasted Claude/Anthropic key (save_key_in / session_token in src-tauri/src/model_router.rs).
 * The frontend never looks at the key itself; it only matches this substring in the error, or `code` on a failed result.
 */
export const CLAUDE_KEY_ERROR = "looks like a Claude key";
export const CLAUDE_KEY_MESSAGE = "Claude uses your subscription, so no key is needed.";
export function isClaudeKeyError(e: unknown): boolean {
  if (!e) return false;
  if (typeof e === "string") return e.includes(CLAUDE_KEY_ERROR);
  const r = e as { code?: unknown; message?: unknown; kind?: unknown };
  return r.code === CLAUDE_KEY_ERROR || r.kind === CLAUDE_KEY_ERROR || (typeof r.message === "string" && r.message.includes(CLAUDE_KEY_ERROR));
}

export interface ModelKeyStore {
  /** Keep the key for this custom model somewhere safe (the macOS Keychain). Never in settings or a file. */
  saveModelKey(customModelId: string, key: string): Promise<void>;
  /**
   * One tiny request to the model with this key. For Ollama there is no key: it checks Ollama answers at baseUrl.
   * Resolve with { ok: true } and the model's name when it replied.
   */
  testModelKey(provider: CustomProvider, baseUrl: string, modelId: string, key: string): Promise<KeyTestResult>;
  /** Forget this custom model's key. True when it's gone, including when there was no key to begin with; false or a
   * thrown error only for a real Keychain failure. */
  deleteModelKey(customModelId: string): Promise<boolean>;
  /**
   * The provider's own context window for this route, or null when the provider publishes no such field.
   *
   * The context meter needs the window as well as the level, and only the level arrives mid-turn (Claude Code
   * sends the window on the turn's `result`, at the end). Without this a routed session shows no bar while a
   * turn runs. Remembered per route in Rust, so it costs one provider call per model per run.
   */
  contextWindow?(provider: CustomProvider, baseUrl: string, modelId: string, customModelId: string): Promise<number | null>;
}

/** Dev and test stand-in: keys stay in memory only. A key containing "bad" fails; Ollama is up unless its URL says "down". */
export function createDevModelKeyStore(): ModelKeyStore & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    async saveModelKey(id, key) {
      keys.set(id, key);
    },
    async deleteModelKey(id) {
      keys.delete(id);
      return true; // a missing key counts as removed, like the backend
    },
    async testModelKey(provider, baseUrl, modelId, key) {
      if (provider === "ollama")
        return /down/.test(baseUrl) ? { ok: false, message: OLLAMA_DOWN } : { ok: true, message: OLLAMA_UP };
      // Stands in for the backend, which answers a Claude key with its own error.
      if (/^sk-ant-/.test(key)) return { ok: false, message: `That ${CLAUDE_KEY_ERROR}` };
      return key.length >= 8 && !/bad/i.test(key)
        ? { ok: true, message: replied(modelId) }
        : { ok: false, message: KEY_FAILED };
    },
  };
}

export const KEY_FAILED = "That key didn't work";
export const OLLAMA_UP = "Connected, Ollama is running";
export const OLLAMA_DOWN = "Can't reach Ollama on this Mac";
export function replied(model: string): string {
  return `Connected, ${model} replied`;
}

/** The real store: the hub plugin keeps the key in the macOS Keychain (service `monocode-hub:model-key`) and runs one
 * tiny request to the provider for the test. The key goes in and never comes back to the webview. */
export const tauriModelKeyStore: ModelKeyStore = {
  saveModelKey: (customModelId, key) => invoke("plugin:hub|model_key_save", { customModelId, key }),
  testModelKey: (provider, baseUrl, modelId, key) =>
    invoke<KeyTestResult>("plugin:hub|model_key_test", { provider, baseUrl, modelId, key }),
  deleteModelKey: (customModelId) => invoke<boolean>("plugin:hub|model_key_delete", { customModelId }),
  contextWindow: (provider, baseUrl, modelId, customModelId) =>
    invoke<number | null>("plugin:hub|model_context_window", { provider, baseUrl, modelId, customModelId }),
};

let store: ModelKeyStore = createDevModelKeyStore();
/** CoS: call this once at startup with the Keychain-backed store. */
export function setModelKeyStore(next: ModelKeyStore): void {
  store = next;
}
export function modelKeyStore(): ModelKeyStore {
  return store;
}

/** Runs the check the form shows inline. */
export async function testCustomModel(form: CustomModelForm): Promise<KeyTestResult> {
  try {
    const r = await store.testModelKey(form.provider, form.baseUrl.trim() || defaultBaseUrl(form.provider), form.modelId.trim(), needsKey(form.provider) ? form.key : "");
    return !r.ok && isClaudeKeyError(r) ? { ok: false, code: CLAUDE_KEY_ERROR, message: CLAUDE_KEY_MESSAGE } : r;
  } catch (e) {
    if (isClaudeKeyError(e)) return { ok: false, code: CLAUDE_KEY_ERROR, message: CLAUDE_KEY_MESSAGE };
    return { ok: false, message: form.provider === "ollama" ? OLLAMA_DOWN : KEY_FAILED };
  }
}

/** Save after a passing test: the key to the key store, the rest to settings. Returns the new model. */
export async function addCustomModel(form: CustomModelForm): Promise<CustomModel> {
  const id = `${form.provider}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (needsKey(form.provider)) await store.saveModelKey(id, form.key);
  const model: CustomModel = {
    id,
    name: form.name.trim(),
    provider: form.provider,
    baseUrl: form.baseUrl.trim() || defaultBaseUrl(form.provider),
    modelId: form.modelId.trim(),
    ...(reasoningEfforts(form.reasoningEfforts).length ? { reasoningEfforts: reasoningEfforts(form.reasoningEfforts) } : {}),
  };
  writeModels([...listCustomModels(), model]);
  return model;
}

/** Remove a custom model: its Keychain key first (so no key is left behind), then its settings entry. If the key
 * can't be removed, the model stays so Ash can try again. Ollama models have no key. */
export async function removeCustomModel(id: string): Promise<void> {
  const model = listCustomModels().find((m) => m.id === id);
  if (!model) return;
  // A delete that answers false is a failure too: the model stays, like a thrown one, so the inline line shows.
  if (needsKey(model.provider) && (await store.deleteModelKey(id)) === false) throw new Error("The key wasn't deleted");
  writeModels(listCustomModels().filter((m) => m.id !== id));
}

/** Change reasoning support on an existing model without touching its saved key. */
export function setCustomModelEfforts(id: string, levels: ReasoningEffort[]): void {
  writeModels(listCustomModels().map((m) => m.id === id ? { ...m, reasoningEfforts: reasoningEfforts(levels) } : m));
}

// ---- for CoS's router -------------------------------------------------------------------------------------------------

/** The four fields CoS's router reads off a session's modelSettings when its model is a custom one. */
export type CustomModelRoute = { provider: CustomProvider; baseUrl: string; modelId: string; customModelId: string; reasoningEffort?: ReasoningEffort };

export function customModelSettings(model: CustomModel): Record<string, string> {
  return { provider: model.provider, baseUrl: model.baseUrl, modelId: model.modelId, customModelId: model.id };
}

/** The route for a session's model, or undefined for a subscription model. Prefers the saved metadata. */
export function customModelRoute(target: Pick<ModelTarget, "model" | "modelSettings">): CustomModelRoute | undefined {
  if (!isCustomModelId(target.model)) return undefined;
  const saved = findCustomModel(target.model);
  if (saved) {
    const levels = reasoningEfforts(saved.reasoningEfforts);
    const effort = target.modelSettings.effort ?? (levels.includes("medium") ? "medium" : levels[0]);
    return { ...customModelSettings(saved), ...(reasoningEfforts(saved.reasoningEfforts).includes(effort as ReasoningEffort) ? { reasoningEffort: effort as ReasoningEffort } : {}) } as CustomModelRoute;
  }
  const s = target.modelSettings;
  return s.customModelId ? { provider: s.provider as CustomProvider, baseUrl: s.baseUrl, modelId: s.modelId, customModelId: s.customModelId } : undefined;
}

/** What the bottom pill says: the name, and for a model outside the subscription, "billed separately" in grey. */
export function pillText(model: string, subName: string): { name: string; billing?: string } {
  const custom = findCustomModel(model);
  return custom ? { name: custom.name, billing: "billed separately" } : { name: subName };
}

/**
 * Remove-model confirm copy, text only (to apply to CoS's 9468f70 confirm). `name` is the model's own display name
 * (`CustomModel.name`), never hard-coded. Buttons match the remove-project dialog.
 */
export const REMOVE_MODEL_COPY = {
  title: (name: string): string => `Remove ${name}? Its saved key is deleted too.`,
  cancel: "Cancel",
  confirm: "Remove",
  keyDeleteFailed: (name: string): string => `Couldn't delete the key, so ${name} is still here. Try again.`,
} as const;
