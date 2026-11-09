// WP-103: how Hivra remembers. Three tiers, chosen in Settings > Memory: rules (no model, nothing leaves this Mac),
// cheap (a model the person already added under Other models, billed by its provider) and crew (today's behaviour:
// the crew's signed-in CLI). Crew is the default, so a person who never opens the setting sees no change.
// Stored in localStorage beside the other display settings; a tier change lands on the next turn, never a past one.

import { useSyncExternalStore } from "react";
import { mentionsSecret } from "./doc";

export const MEMORY_TIER_KEY = "monocode.memoryTier";
export const MEMORY_TIER_CHANGE_EVENT = "monocode:memorytierchange";

export type MemoryTier = "rules" | "cheap" | "crew";

export type TierChoice = {
  tier: MemoryTier;
  /** The custom model the cheap tier asks, by its id under Other models. Absent on the other tiers. */
  model?: string;
};

export const DEFAULT_TIER: MemoryTier = "crew";

/** A custom model id: opaque, but never something with spaces, a path or a secret in it. */
const MODEL_ID = /^[A-Za-z0-9._:-]{1,120}$/;

function isTier(value: unknown): value is MemoryTier {
  return value === "rules" || value === "cheap" || value === "crew";
}

function cleanModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!MODEL_ID.test(id) || mentionsSecret(id)) return undefined;
  return id;
}

/** A stored value, read as untrusted: anything unreadable is crew, and a model only survives on the cheap tier. */
export function readMemoryTier(value: unknown): TierChoice {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      raw = undefined;
    }
  }
  if (typeof raw === "string" && isTier(raw)) return { tier: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { tier: DEFAULT_TIER };
  const row = raw as { tier?: unknown; model?: unknown };
  if (!isTier(row.tier)) return { tier: DEFAULT_TIER };
  if (row.tier !== "cheap") return { tier: row.tier };
  const model = cleanModel(row.model);
  return model ? { tier: "cheap", model } : { tier: "cheap" };
}

export function loadMemoryTier(): TierChoice {
  try {
    return readMemoryTier(localStorage.getItem(MEMORY_TIER_KEY));
  } catch {
    return { tier: DEFAULT_TIER };
  }
}

// useSyncExternalStore calls its snapshot on every render and must get the same value back while nothing changed,
// so the parsed choice is kept beside the string it came from, not rebuilt each time.
let cachedRaw: string | null = null;
let cachedChoice: TierChoice | undefined;

/** The saved setting, stable between changes: the same object until localStorage or a save has moved it. */
export function snapshotMemoryTier(): TierChoice {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(MEMORY_TIER_KEY);
  } catch {
    return { tier: DEFAULT_TIER };
  }
  if (!cachedChoice || raw !== cachedRaw) {
    cachedRaw = raw;
    cachedChoice = readMemoryTier(raw);
  }
  return cachedChoice;
}

export function saveMemoryTier(choice: TierChoice): void {
  const clean = readMemoryTier(choice);
  cachedChoice = undefined;
  let saved = clean;
  try {
    localStorage.setItem(MEMORY_TIER_KEY, JSON.stringify(clean));
  } catch {
    // Private mode or a full quota: nothing was written, so the screen keeps showing what is actually saved.
    saved = snapshotMemoryTier();
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TierChoice>(MEMORY_TIER_CHANGE_EVENT, { detail: saved }));
}

/** Every window that saved this setting, this one and any other. */
export function subscribeMemoryTier(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== MEMORY_TIER_KEY && event.key !== null) return;
    onChange();
  };
  window.addEventListener(MEMORY_TIER_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(MEMORY_TIER_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const TORN_DOWN: TierChoice = { tier: DEFAULT_TIER };

export function useMemoryTier(): TierChoice {
  return useSyncExternalStore(subscribeMemoryTier, snapshotMemoryTier, () => TORN_DOWN);
}

/** Whether this tier sends the turn's text off the machine at all, for the setting's own cost lines. */
export function tierSendsText(tier: MemoryTier): boolean {
  return tier !== "rules";
}

export function tierLabel(tier: MemoryTier): string {
  if (tier === "rules") return "Rules on this Mac";
  if (tier === "cheap") return "A cheap model";
  return "Your crew";
}
