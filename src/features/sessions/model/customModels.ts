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
/**
 * The address to show beside a stored key, or undefined when the key goes only to the provider's own default address.
 * A custom model always shows its address. A named provider shows one only when it is a stored proxy, not the default.
 */
export function addressShownFor(provider: string, storedAddress: string | null | undefined): string | undefined {
  const url = (storedAddress ?? "").trim().replace(/\/+$/, "");
  if (!url) return undefined;
  if (provider === "custom") return url;
  const fallback = defaultBaseUrl(provider as CustomProvider).replace(/\/+$/, "");
  return url === fallback ? undefined : url;
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
/**
 * The levels a custom model offers. A model nobody narrowed (no saved list, which is every model added before this
 * and every new one) offers all of them, None through Max. A saved list is a deliberate choice and is kept as is;
 * an empty one means "leave effort to the provider".
 */
export function customModelEfforts(value: unknown): ReasoningEffort[] {
  return Array.isArray(value) ? reasoningEfforts(value) : [...REASONING_EFFORTS];
}
/** Kept only when narrowed on purpose: no list means every level (customModelEfforts). */
function savedEfforts(value: unknown): { reasoningEfforts?: ReasoningEffort[] } {
  if (!Array.isArray(value)) return {};
  const levels = reasoningEfforts(value);
  return levels.length === REASONING_EFFORTS.length ? {} : { reasoningEfforts: levels };
}
/** What Ash sees for a level: "Extra high" for xhigh, otherwise the word with a capital. */
export function effortLabel(level: string): string {
  return level === "xhigh" ? "Extra high" : level ? level[0].toUpperCase() + level.slice(1) : level;
}
/**
 * Only levels enabled for this model are offered or sent; see customModelEfforts for the default. `refusedEfforts`
 * are levels the provider itself refused on this Mac (the router retried without them): they stay listed, marked as
 * not supported, are never sent, and never look selected. "Try them again" in Reasoning settings clears them.
 */
export type CustomModel = {
  id: string; name: string; provider: CustomProvider; baseUrl: string; modelId: string;
  reasoningEfforts?: ReasoningEffort[]; refusedEfforts?: ReasoningEffort[];
};

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

/**
 * WP-176: a per-task ceiling applies only to a model a provider bills per token.
 * A subscription CLI is not one. An unknown custom model is treated as billed.
 * A model served by Ollama on this machine is not.
 */
export function isBilledModel(model: string | undefined): boolean {
  if (!isCustomModelId(model)) return false;
  const found = findCustomModel(model);
  if (!found) return true;
  return found.provider !== "ollama";
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
  const clean = list.map(({ id, name, provider, baseUrl, modelId, reasoningEfforts: levels, refusedEfforts: refused }) => {
    const kept = reasoningEfforts(refused);
    return { id, name, provider, baseUrl, modelId, ...savedEfforts(levels), ...(kept.length ? { refusedEfforts: kept } : {}) };
  });
  localStorage.setItem(KEY, JSON.stringify(clean));
  version++;
  window.dispatchEvent(new CustomEvent(CHANGED));
}

/**
 * Models from a setup import: each one whose id isn't here yet is added, metadata only (writeModels drops anything
 * key-like). Its key is entered again on this Mac. An address the form would refuse (baseUrlProblem) is never taken
 * from a file either: that model is left out, and `onSkipped` hears why. Returns how many were added.
 */
export function importCustomModels(models: readonly unknown[], onSkipped?: (reason: string) => void): number {
  const have = listCustomModels();
  const ids = new Set(have.map((m) => m.id));
  const shaped = models.filter(
    (m): m is CustomModel =>
      !!m && typeof m === "object" && typeof (m as CustomModel).id === "string" && typeof (m as CustomModel).name === "string" &&
      typeof (m as CustomModel).modelId === "string" && CUSTOM_PROVIDERS.some((p) => p.id === (m as CustomModel).provider) && !ids.has((m as CustomModel).id),
  );
  const add = shaped.filter((m) => {
    const problem = baseUrlProblem(m.baseUrl);
    if (problem) onSkipped?.(`Left out the custom model "${m.name}": ${problem}.`);
    return !problem;
  });
  if (add.length) writeModels([...have, ...add]);
  return add.length;
}

// ---- the form -------------------------------------------------------------------------------------------------------

export type CustomModelForm = { name: string; provider: CustomProvider; baseUrl: string; modelId: string; key: string; reasoningEfforts?: ReasoningEffort[] };

export function emptyForm(provider: CustomProvider = "xai"): CustomModelForm {
  return { name: "", provider, baseUrl: defaultBaseUrl(provider), modelId: defaultModelId(provider), key: "" };
}

/** What is wrong with a provider address, in plain words, or nothing. The form and an import check it the same way. */
export function baseUrlProblem(baseUrl: unknown): string | undefined {
  const url = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!url) return "Add your provider's address";
  if (!/^https?:\/\/[^\s/]+/.test(url)) return "The address starts with https://";
  if (/anthropic\.com|\/anthropic\b|claude\.ai/i.test(url))
    return "Use the provider's OpenAI-style address (usually ending in /v1), not an Anthropic one";
  return undefined;
}

/** Plain-words problems with the form, by field. Empty when it can be tested. */
export function validateCustomModel(form: CustomModelForm): Partial<Record<keyof CustomModelForm, string>> {
  const errors: Partial<Record<keyof CustomModelForm, string>> = {};
  if (!form.name.trim()) errors.name = "Give it a name";
  if (!form.modelId.trim()) errors.modelId = "Add the model id";
  else if (/\s/.test(form.modelId.trim())) errors.modelId = "The model id has no spaces";
  if (showsBaseUrl(form.provider)) {
    const problem = baseUrlProblem(form.baseUrl);
    if (problem) errors.baseUrl = problem;
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

/** The address Rust stored with each model's key, by model id. Undefined until it has been read. */
const savedAddresses = new Map<string, string | null>();
export function savedAddressOf(customModelId: string): string | null | undefined {
  return savedAddresses.get(customModelId);
}
/** Reads the stored address of every custom model's key from Rust (addresses are not secrets; keys never come back). */
export async function refreshSavedAddresses(): Promise<void> {
  await Promise.all(
    listCustomModels().map(async (m) => {
      try {
        const address = await store.keyAddress(m.id);
        savedAddresses.set(m.id, typeof address === "string" ? address : null);
      } catch {
        savedAddresses.set(m.id, null);
      }
    }),
  );
  version++;
  window.dispatchEvent(new CustomEvent(CHANGED));
}

export interface ModelKeyStore {
  /** Keep the key for this custom model somewhere safe (the macOS Keychain). Never in settings or a file.
   * When the provider, model and address are passed, Rust stores that address with the key. Short text
   * may send the key only to that host. */
  saveModelKey(
    customModelId: string,
    key: string,
    binding?: { provider: string; modelId: string; baseUrl: string },
  ): Promise<void>;
  /**
   * One tiny request to the model with this key. For Ollama there is no key: it checks Ollama answers at baseUrl.
   * Resolve with { ok: true } and the model's name when it replied.
   */
  testModelKey(provider: CustomProvider, baseUrl: string, modelId: string, key: string): Promise<KeyTestResult>;
  /** Forget this custom model's key. True when it's gone, including when there was no key to begin with; false or a
   * thrown error only for a real Keychain failure. */
  deleteModelKey(customModelId: string): Promise<boolean>;
  /** The address the key was saved with, or null when it was saved with none (the key is then never sent). */
  keyAddress(customModelId: string): Promise<string | null>;
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
  const addresses = new Map<string, string>();
  return {
    keys,
    async saveModelKey(id, key, binding) {
      keys.set(id, key);
      if (binding) addresses.set(id, binding.baseUrl);
      else addresses.delete(id);
    },
    async deleteModelKey(id) {
      keys.delete(id);
      addresses.delete(id);
      return true; // a missing key counts as removed, like the backend
    },
    async keyAddress(id) {
      return addresses.get(id) ?? null;
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

/** The real store: the hub plugin keeps the key in the macOS Keychain (service `monocode-hub:model-key`) and asks the
 * model to call one tool. The key goes in and never comes back to the webview. */
export const tauriModelKeyStore: ModelKeyStore = {
  saveModelKey: (customModelId, key, binding) =>
    invoke("plugin:hub|model_key_save", {
      customModelId,
      key,
      ...(binding
        ? { provider: binding.provider, modelId: binding.modelId, baseUrl: binding.baseUrl }
        : {}),
    }),
  testModelKey: (provider, baseUrl, modelId, key) =>
    invoke<KeyTestResult>("plugin:hub|model_key_test", { provider, baseUrl, modelId, key }),
  deleteModelKey: (customModelId) => invoke<boolean>("plugin:hub|model_key_delete", { customModelId }),
  keyAddress: (customModelId) => invoke<string | null>("plugin:hub|model_key_address", { customModelId }),
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
  if (needsKey(form.provider)) {
    await store.saveModelKey(id, form.key, {
      provider: form.provider,
      modelId: form.modelId.trim(),
      baseUrl: form.baseUrl.trim() || defaultBaseUrl(form.provider),
    });
  }
  const model: CustomModel = {
    id,
    name: form.name.trim(),
    provider: form.provider,
    baseUrl: form.baseUrl.trim() || defaultBaseUrl(form.provider),
    modelId: form.modelId.trim(),
    ...savedEfforts(form.reasoningEfforts),
  };
  writeModels([...listCustomModels(), model]);
  void refreshSavedAddresses();
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

/**
 * The level a chat on a custom model asks for, before anything the provider refused is taken out: the chat's own
 * pick, else for a narrowed list its old default (medium, else the first). A model nobody narrowed sends none unless
 * the chat picked one, so the provider's own default stays the default (some providers refuse the field).
 */
export function pickedCustomEffort(target: { model?: string; modelSettings: Record<string, string> }): { model: CustomModel; effort: ReasoningEffort } | undefined {
  const saved = findCustomModel(target.model);
  if (!saved) return undefined;
  const levels = customModelEfforts(saved.reasoningEfforts);
  const narrowed = Array.isArray(saved.reasoningEfforts);
  const effort = target.modelSettings.effort ?? (narrowed ? (levels.includes("medium") ? "medium" : levels[0]) : undefined);
  return levels.includes(effort as ReasoningEffort) ? { model: saved, effort: effort as ReasoningEffort } : undefined;
}

/** The levels this model's provider refused on this Mac. */
export function refusedEfforts(model: Pick<CustomModel, "refusedEfforts"> | undefined): ReasoningEffort[] {
  return reasoningEfforts(model?.refusedEfforts);
}

/** The route for a session's model, or undefined for a subscription model. Prefers the saved metadata. */
export function customModelRoute(target: Pick<ModelTarget, "model" | "modelSettings">): CustomModelRoute | undefined {
  if (!isCustomModelId(target.model)) return undefined;
  const saved = findCustomModel(target.model);
  if (saved) {
    const picked = pickedCustomEffort(target);
    // A level the provider already refused is not sent again: the reply uses the provider's default, and the chat
    // and the picker say so (effortDroppedText, the picker's "Not supported").
    const send = picked && !refusedEfforts(saved).includes(picked.effort) ? picked.effort : undefined;
    return { ...customModelSettings(saved), ...(send ? { reasoningEffort: send } : {}) } as CustomModelRoute;
  }
  const s = target.modelSettings;
  return s.customModelId ? { provider: s.provider as CustomProvider, baseUrl: s.baseUrl, modelId: s.modelId, customModelId: s.customModelId } : undefined;
}

// ---- levels a provider refused ------------------------------------------------------------------------------------------

/** What the router announces when a provider refused a level (src-tauri/src/model_router.rs, EffortRefusal). */
export type EffortRefusal = { customModelId: string; provider: string; baseUrl: string; modelId: string; effort: string };
export const EFFORT_REFUSED_EVENT = "model-router://effort-refused";

/** Mark a level as refused for the model it belongs to. Returns whether anything changed. */
export function markEffortRefused(refusal: Pick<EffortRefusal, "customModelId" | "effort">): boolean {
  const level = reasoningEfforts([refusal.effort])[0];
  if (!level) return false;
  const list = listCustomModels();
  const model = list.find((m) => m.id === refusal.customModelId);
  if (!model || refusedEfforts(model).includes(level)) return false;
  writeModels(list.map((m) => m.id === model.id ? { ...m, refusedEfforts: [...refusedEfforts(m), level] } : m));
  return true;
}

/** "Try them again": the next message at a refused level asks the provider once more. */
export function clearRefusedEfforts(id: string): void {
  writeModels(listCustomModels().map((m) => m.id === id ? { ...m, refusedEfforts: [] } : m));
}

/** The one plain line a chat shows when its level was dropped: "xAI didn't accept the Medium level, so …". */
export function effortDroppedText(model: Pick<CustomModel, "provider">, effort: string): string {
  const who = model.provider === "custom" ? "Your provider" : providerName(model.provider);
  return `${who} didn't accept the ${effortLabel(effort)} level, so this reply used the provider's default.`;
}

/**
 * The line to show in a chat whose picked level its provider refused, once per chat and level, or undefined.
 * `shown` is the caller's record of what this chat was already told.
 */
export function effortDroppedNotice(
  target: { model?: string; modelSettings: Record<string, string> },
  shown: Set<string>,
): string | undefined {
  const picked = pickedCustomEffort(target);
  if (!picked || !refusedEfforts(picked.model).includes(picked.effort)) return undefined;
  const key = `${picked.model.id}|${picked.effort}`;
  if (shown.has(key)) return undefined;
  shown.add(key);
  return effortDroppedText(picked.model, picked.effort);
}

/** In the app: every refusal the router announces marks that level for its model. Returns the unlisten. */
export async function listenForEffortRefusals(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EffortRefusal>(EFFORT_REFUSED_EVENT, (event) => {
    markEffortRefused(event.payload);
  });
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
