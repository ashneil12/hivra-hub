// WP-104: model windows from models.dev, bundled so a custom route can read them offline.
// scripts/refresh-models-dev.mjs refreshes the file. This module never fetches.
import bundled from "./modelsDev.json";

/** A positive finite window from a catalogue row, or undefined when the row does not say. */
export function catalogueWindow(modelId: string, catalogue: unknown = bundled): number | undefined {
  const row = asRow(lookup(modelId, catalogue));
  return row?.context;
}

function lookup(modelId: string, catalogue: unknown): unknown {
  if (!catalogue || typeof catalogue !== "object" || Array.isArray(catalogue)) return undefined;
  const table = catalogue as Record<string, unknown>;
  const id = modelId.trim();
  if (!id) return undefined;
  if (Object.prototype.hasOwnProperty.call(table, id)) return table[id];
  const lower = id.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(table, lower)) return table[lower];
  const found = Object.keys(table).find((key) => key.toLowerCase() === lower);
  return found === undefined ? undefined : table[found];
}

function asRow(value: unknown): { context?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const context = (value as Record<string, unknown>).context;
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) return undefined;
  return { context };
}
