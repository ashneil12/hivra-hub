// WP-129: an optional provider and model for titles, commit messages, pull request text and branch names.
// Missing or unreadable means the coding CLI still does that work. A key never belongs in this setting.

import {
  CUSTOM_PROVIDERS,
  baseUrlProblem,
  defaultBaseUrl,
  type CustomProvider,
} from "../../sessions/model/customModels";
import { hasSecretText, isSecretKey } from "../../portable/model/secrets";

export const TEXT_GENERATION_KEY = "monocode.textGeneration";
export const TEXT_GENERATION_CHANGE_EVENT = "monocode:text-generation-change";

/** What is saved. Never a key. Absent means today's coding-CLI path. */
export type TextGenerationSetting = {
  provider: CustomProvider;
  model: string;
  baseUrl: string;
};

const MODEL_ID = /^[A-Za-z0-9._:+/-]{1,200}$/;

function isProvider(value: unknown): value is CustomProvider {
  return typeof value === "string" && CUSTOM_PROVIDERS.some((provider) => provider.id === value);
}

function cleanModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  if (!MODEL_ID.test(model)) return undefined;
  if (model.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  if (hasSecretText(model)) return undefined;
  return model;
}

/** https anywhere; plain http only on this Mac. A key in the address is refused. */
function cleanBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = value.trim().replace(/\/+$/, "");
  if (baseUrlProblem(url)) return undefined;
  if (hasSecretText(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined;
  }
  return url;
}

/** Undefined when the address was left out. Null when it was present and refused. */
function storedAddress(value: unknown): string | undefined | null {
  if (value == null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return cleanBaseUrl(trimmed) ?? null;
}

function unwrap(value: unknown, depth = 0): unknown {
  if (typeof value !== "string" || depth > 2) return value;
  const text = value.replace(/^﻿/, "").trim();
  if (!text) return null;
  try {
    return unwrap(JSON.parse(text) as unknown, depth + 1);
  } catch {
    return null;
  }
}

function withoutSecrets(value: unknown): Record<string, unknown> | null {
  const raw = unwrap(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (isSecretKey(key)) continue;
    kept[key] = field;
  }
  return kept;
}

/**
 * A stored value, read as untrusted. A version 1 `{ provider, modelId }` becomes the current shape.
 * Anything unreadable is missing, which means the coding CLI. This does not write.
 */
export function readTextGeneration(value: unknown): TextGenerationSetting | null {
  const row = withoutSecrets(value);
  if (!row || !isProvider(row.provider)) return null;
  const model = cleanModel(row.model) ?? cleanModel(row.modelId);
  if (!model) return null;
  // An address that was stored and is no good is missing, not silently swapped for the provider default.
  const address = storedAddress(row.baseUrl);
  if (address === null) return null;
  const baseUrl = address ?? (row.provider === "custom" ? undefined : cleanBaseUrl(defaultBaseUrl(row.provider)));
  if (!baseUrl) return null;
  return { provider: row.provider, model, baseUrl };
}

let cache: { raw: string | null; value: TextGenerationSetting | null } | undefined;

/** The saved setting. The same object until the stored text changes, so a subscriber can compare it. */
export function snapshotTextGeneration(): TextGenerationSetting | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(TEXT_GENERATION_KEY);
  } catch {
    return null;
  }
  if (cache && cache.raw === raw) return cache.value;
  const value = readTextGeneration(raw);
  cache = { raw, value };
  return value;
}

export function loadTextGeneration(): TextGenerationSetting | null {
  return snapshotTextGeneration();
}

/** Save a whole setting, or null to go back to the coding CLI. An invalid value is left untouched. */
export function saveTextGeneration(value: TextGenerationSetting | null): void {
  const clean = value == null ? null : readTextGeneration(value);
  if (value != null && clean == null) return;
  const raw = clean == null
    ? null
    : JSON.stringify({ v: 2, provider: clean.provider, model: clean.model, baseUrl: clean.baseUrl });
  try {
    if (raw == null) localStorage.removeItem(TEXT_GENERATION_KEY);
    else localStorage.setItem(TEXT_GENERATION_KEY, raw);
  } catch {
    return;
  }
  cache = { raw, value: clean };
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TEXT_GENERATION_CHANGE_EVENT, { detail: clean }));
}

/** This window and any other window that changes the setting. */
export function subscribeTextGeneration(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TEXT_GENERATION_KEY && event.key !== null) return;
    onChange();
  };
  window.addEventListener(TEXT_GENERATION_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TEXT_GENERATION_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
