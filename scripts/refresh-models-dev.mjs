// WP-104: refresh the bundled model catalogue from models.dev.
// The app never runs this and never fetches. A person runs it when the list should move:
//   node scripts/refresh-models-dev.mjs
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = "https://models.dev/api.json";
const ID_MAX = 200;
const CONTEXT_MAX = 10_000_000;

function okId(id) {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (!trimmed || [...trimmed].length > ID_MAX) return false;
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function windowOf(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > CONTEXT_MAX) return undefined;
  return value;
}

function rowOf(model) {
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
  const limit = model.limit;
  const context =
    limit && typeof limit === "object" && !Array.isArray(limit) ? windowOf(limit.context) : undefined;
  const tools = typeof model.tool_call === "boolean" ? model.tool_call : undefined;
  if (context === undefined && tools === undefined) return undefined;
  const row = {};
  if (context !== undefined) row.context = context;
  if (tools !== undefined) row.tools = tools;
  return row;
}

function modelId(model, key) {
  if (model && typeof model === "object" && typeof model.id === "string" && okId(model.id)) return model.id.trim();
  return okId(key) ? key.trim() : "";
}

function qualified(providerId, id) {
  if (typeof providerId !== "string" || id.includes("/")) return "";
  const provider = providerId.trim();
  if (!okId(provider)) return "";
  const both = `${provider}/${id}`;
  return okId(both) ? both : "";
}

/** The first window stays. A later one must not invent or replace it. Tools prefer true. */
function merge(rows, id, row) {
  const prev = rows.get(id);
  if (!prev) {
    rows.set(id, { ...row });
    return;
  }
  const next = { ...prev };
  if (row.tools === true) next.tools = true;
  else if (next.tools === undefined && row.tools !== undefined) next.tools = row.tools;
  rows.set(id, next);
}

/**
 * Trim a models.dev payload to `{ [id]: { context?, tools? } }`.
 * A bad entry is skipped. Two providers sharing an id keep the first window and prefer tools.
 * Each provider-qualified id is kept on its own, so neither window is invented for the other.
 */
export function trimModelsDev(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const providers =
    data.providers && typeof data.providers === "object" && !Array.isArray(data.providers) ? data.providers : data;
  const rows = new Map();
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const models = provider.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [key, model] of Object.entries(models)) {
      const row = rowOf(model);
      const id = modelId(model, key);
      if (!row || !id) continue;
      merge(rows, id, row);
      const both = qualified(providerId, id);
      if (both && both !== id) merge(rows, both, row);
      if (key !== id && okId(key)) merge(rows, key.trim(), row);
    }
  }
  const out = {};
  for (const key of [...rows.keys()].sort()) out[key] = rows.get(key);
  return out;
}

async function refresh() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = resolve(root, "src/features/sessions/model/modelsDev.json");
  let response;
  try {
    response = await fetch(SOURCE, { signal: AbortSignal.timeout(20_000) });
  } catch {
    console.error("Couldn't reach models.dev; left the old file");
    process.exitCode = 1;
    return;
  }
  if (!response.ok) {
    console.error(`models.dev answered ${response.status}; left the old file`);
    process.exitCode = 1;
    return;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error("models.dev did not send JSON; left the old file");
    process.exitCode = 1;
    return;
  }
  const catalogue = trimModelsDev(payload);
  if (Object.keys(catalogue).length === 0) {
    console.error("models.dev catalogue was empty; left the old file");
    process.exitCode = 1;
    return;
  }
  const tmp = `${out}.tmp`;
  let moved = false;
  try {
    writeFileSync(tmp, `${JSON.stringify(catalogue, null, 2)}\n`);
    renameSync(tmp, out);
    moved = true;
  } finally {
    if (!moved) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file was never written.
      }
    }
  }
  console.log(`wrote ${Object.keys(catalogue).length} models`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refresh().catch((err) => {
    console.error(err instanceof Error ? err.message : "refresh failed");
    process.exitCode = 1;
  });
}
