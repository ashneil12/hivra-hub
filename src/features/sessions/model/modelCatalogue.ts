// WP-104: model windows from models.dev, bundled so a custom route can read them offline.
// scripts/refresh-models-dev.mjs refreshes the file. This module never fetches.
//
// The file is large, so it is its own chunk and is read the first time a custom route asks for a window
// (`loadCatalogue`), not when the app starts. Until it has arrived, a lookup that names no table answers "unknown" and
// the caller falls back to its hand-written ceiling; `subscribeCatalogue` says when that answer can change.

let loaded: unknown;
let pending: Promise<unknown> | undefined;
let version = 0;
const listeners = new Set<() => void>();

/**
 * Read the bundled file once. Everyone who asks while it loads gets the same promise. A load that fails (a chunk that
 * would not come in) is not final: it resolves to nothing now and the next ask tries again.
 */
export function loadCatalogue(): Promise<unknown> {
  if (loaded !== undefined) return Promise.resolve(loaded);
  pending ??= import("./modelsDev.json").then(
    (file) => {
      loaded = "default" in file ? file.default : file;
      pending = undefined;
      version += 1;
      for (const listener of [...listeners]) listener();
      return loaded;
    },
    () => {
      pending = undefined;
      return undefined;
    },
  );
  return pending;
}

/** Changes each time the bundled file arrives, for `useSyncExternalStore`. */
export function catalogueVersion(): number {
  return version;
}

export function subscribeCatalogue(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * The window a catalogue row gives a model, a positive finite number, or undefined when the row does not say.
 *
 * With a provider, its own row (`provider/model`) comes first: two providers can serve one model id with different
 * windows, and the bare id only holds the first of them. A provider whose row exists but gives no window is not
 * answered from the bare id. Pass `catalogue` to read a table you already hold; leave it out for the bundled one,
 * which starts loading if it hasn't yet.
 */
export function catalogueWindow(modelId: string, catalogue?: unknown, provider?: string): number | undefined {
  const table = catalogue === undefined ? bundledTable() : catalogue;
  const id = modelId.trim();
  if (!id) return undefined;
  const slug = provider?.trim();
  if (slug) {
    const own = lookup(`${slug}/${id}`, table);
    if (own !== undefined) return asRow(own)?.context;
  }
  return asRow(lookup(id, table))?.context;
}

function bundledTable(): unknown {
  if (loaded === undefined) void loadCatalogue();
  return loaded;
}

function lookup(id: string, catalogue: unknown): unknown {
  if (!catalogue || typeof catalogue !== "object" || Array.isArray(catalogue)) return undefined;
  const table = catalogue as Record<string, unknown>;
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
