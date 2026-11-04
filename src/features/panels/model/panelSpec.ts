// A panel contribution (WP-33): a PageSpec in a plugin's `hivra/panels/<id>/` folder. Blocks keep their spec in
// `panel.json`. A bespoke panel keeps HTML, CSS and JS beside it (`index.html`, `style.css`, `script.js`) and its
// permission list in `panel.json`. Files read from disk are untrusted and checked again here.
import { validatePageSpec, type Capability, type PageSpec } from "../../pages/model/pageSpec";

const PANEL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BESPOKE_FIELDS = new Set(["kind", "title", "permissions"]);
const BLOCK_FIELDS = new Set(["kind", "title", "blocks"]);

export type PanelRead = { spec: PageSpec; permissions: Capability[] };
export type PanelResult = { ok: true; value: PanelRead } | { ok: false; error: string };

/** An id a panel folder may use: the same grammar as a plugin skill name. */
export function panelIdOk(id: string): boolean {
  return id.length > 0 && id.length <= 64 && PANEL_ID.test(id);
}

/** A file name that stays inside one panel folder. `..`, slashes and odd names are refused. */
function fileNameOk(name: string): boolean {
  return name === "panel.json" || name === "index.html" || name === "style.css" || name === "script.js";
}

/**
 * Turn one panel folder's files into a spec. `files` is keyed by the file's own name, never a path.
 * Anything that doesn't validate is an error, not a guess.
 */
export function readPanelDir(id: string, files: Record<string, string>): PanelResult {
  if (!panelIdOk(id)) return { ok: false, error: "That panel id isn't allowed." };
  for (const key of Object.keys(files)) {
    if (!fileNameOk(key)) return { ok: false, error: "A panel file points outside its folder." };
  }
  const raw = files["panel.json"];
  if (raw === undefined || raw.trim() === "") return { ok: false, error: "panel.json is missing." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "panel.json isn't JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "panel.json must be an object." };
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === "bespoke") {
    for (const key of Object.keys(obj)) {
      if (!BESPOKE_FIELDS.has(key)) return { ok: false, error: "A bespoke panel has an extra field." };
    }
    const html = files["index.html"];
    if (typeof html !== "string" || html.length === 0) return { ok: false, error: "A bespoke panel needs index.html beside panel.json." };
    const checked = validatePageSpec({
      kind: "bespoke",
      title: obj.title,
      html,
      ...(typeof files["style.css"] === "string" ? { css: files["style.css"] } : {}),
      ...(typeof files["script.js"] === "string" ? { js: files["script.js"] } : {}),
      permissions: obj.permissions,
    });
    if (!checked.ok) return checked;
    return { ok: true, value: { spec: checked.value, permissions: checked.value.kind === "bespoke" ? checked.value.permissions : [] } };
  }
  if (obj.kind === "blocks") {
    for (const key of Object.keys(obj)) {
      if (!BLOCK_FIELDS.has(key)) return { ok: false, error: "A blocks panel has an extra field." };
    }
    const checked = validatePageSpec(obj);
    if (!checked.ok) return checked;
    return { ok: true, value: { spec: checked.value, permissions: [] } };
  }
  return { ok: false, error: "panel.json's kind must be blocks or bespoke." };
}
