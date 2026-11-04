// Kept Pages become panels in one local plugin (WP-33), so they can be edited, exported and rolled back like any
// other plugin. The plugin's id is `my-panels` (a plugin name can't contain a space); its description is "My panels".
import { isCapability, validatePageSpec, type Capability, type PageSpec } from "../../pages/model/pageSpec";

export const MY_PANELS_ID = "my-panels";
export const MY_PANELS_TITLE = "My panels";
const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** The fields a kept page needs. Anything else on the record is ignored. */
export type KeptPage = {
  id?: unknown;
  keptAt?: unknown;
  removed?: unknown;
  spec?: unknown;
  /** What was approved. Missing means nothing was approved. This is not the spec's ask list. */
  permissions?: unknown;
};

export type PanelMerge = { files: Record<string, string>; added: string[]; skipped: string[] };

const PANEL_JSON = /^hivra\/panels\/([^/]+)\/panel\.json$/;

function safeKey(key: string): boolean {
  if (key.includes("\\") || key.includes("\0")) return false;
  const parts = key.split("/");
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/** The folder name a page id would use, before another page in this batch has taken it. A path is refused. */
export function panelBaseId(raw: string): string | undefined {
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) return undefined;
  let base = "";
  let dash = false;
  for (const char of raw.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      base += char;
      dash = false;
    } else if (!dash && base.length > 0) {
      base += "-";
      dash = true;
    }
  }
  while (base.endsWith("-")) base = base.slice(0, -1);
  if (base.length > 64) base = base.slice(0, 64).replace(/-+$/g, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(base)) return undefined;
  return base;
}

/** A free folder. An id already on disk is not given a suffix: that file is left as it is. */
function freeId(base: string, taken: ReadonlySet<string>): string | undefined {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const cut = base.slice(0, 64 - suffix.length).replace(/-+$/g, "");
    const next = `${cut}${suffix}`;
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(next) && !taken.has(next)) return next;
  }
  return undefined;
}

/** Approved grants only. A list that isn't a list of real permissions is refused. Asks that were not approved are left out. */
function approvedGrants(spec: PageSpec, approved: unknown): Capability[] | undefined {
  if (spec.kind !== "bespoke") return [];
  if (approved === undefined) return [];
  if (!Array.isArray(approved)) return undefined;
  const grants: Capability[] = [];
  for (const item of approved) {
    if (typeof item !== "string" || !isCapability(item)) return undefined;
    if (!spec.permissions.includes(item) || grants.includes(item)) continue;
    grants.push(item);
  }
  return grants;
}

function panelFiles(id: string, spec: PageSpec, grants: Capability[]): Record<string, string> | undefined {
  const dir = `hivra/panels/${id}`;
  if (spec.kind === "blocks") {
    return { [`${dir}/panel.json`]: JSON.stringify({ kind: "blocks", title: spec.title, blocks: spec.blocks }) };
  }
  if (!spec.html) return undefined;
  return {
    [`${dir}/panel.json`]: JSON.stringify({ kind: "bespoke", title: spec.title, permissions: grants }),
    [`${dir}/index.html`]: spec.html,
    ...(spec.css ? { [`${dir}/style.css`]: spec.css } : {}),
    ...(spec.js ? { [`${dir}/script.js`]: spec.js } : {}),
  };
}

/**
 * Merge kept pages into a plugin's files. An existing `panel.json` is never overwritten (someone may have edited
 * it). A page that isn't kept, was removed, or doesn't validate is skipped. An empty merge with nothing already
 * there makes no plugin.
 */
export function mergeMyPanels(existing: Record<string, string>, pages: readonly KeptPage[]): PanelMerge {
  const files: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (safeKey(key)) files[key] = value;
  }
  const taken = new Set<string>();
  for (const key of Object.keys(files)) {
    const match = PANEL_JSON.exec(key);
    if (match) taken.add(match[1]);
  }
  const onDisk = new Set(taken);
  const added: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const sourceId = typeof page?.id === "string" ? page.id : "";
    if (page?.removed === true || typeof page?.keptAt !== "number") {
      skipped.push(sourceId);
      continue;
    }
    if (sourceId === "" || seen.has(sourceId)) {
      skipped.push(sourceId);
      continue;
    }
    seen.add(sourceId);
    const base = panelBaseId(sourceId);
    // A folder that is already there belongs to an earlier migrate or an edit. It is not overwritten and not copied aside.
    if (!base || onDisk.has(base)) {
      skipped.push(sourceId);
      continue;
    }
    const id = freeId(base, taken);
    if (!id) {
      skipped.push(sourceId);
      continue;
    }
    const checked = validatePageSpec(page.spec);
    if (!checked.ok) {
      skipped.push(sourceId);
      continue;
    }
    const grants = approvedGrants(checked.value, page.permissions);
    if (!grants) {
      skipped.push(sourceId);
      continue;
    }
    const written = panelFiles(id, checked.value, grants);
    if (!written) {
      skipped.push(sourceId);
      continue;
    }
    Object.assign(files, written);
    taken.add(id);
    added.push(id);
  }
  const hasPanel = Object.keys(files).some((key) => PANEL_JSON.test(key));
  if (!hasPanel) return { files: {}, added: [], skipped };
  if (files["plugin.json"] === undefined) {
    files["plugin.json"] = JSON.stringify({
      $schema: SCHEMA,
      name: MY_PANELS_ID,
      version: "1.0.0",
      description: MY_PANELS_TITLE,
    });
  }
  return { files, added, skipped };
}
