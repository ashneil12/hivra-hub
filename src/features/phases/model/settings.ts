// WP-84: how much process a task gets. Untrusted settings fall back to a straight build.

import { modelsFor } from "../../sessions/model/models";

export type PathId = "straight" | "research-plan-build" | "product-first";

export type PhaseSettings = {
  defaultPath: PathId;
  /** Only a real true skips the review wait. Anything else waits. */
  continueWithoutWaiting: boolean;
  models: { search: string; judgment: string };
};

const PATHS: readonly PathId[] = ["straight", "research-plan-build", "product-first"];

export const SEARCH_MODEL = "claude:haiku-4.5";
export const JUDGMENT_MODEL = "claude:opus-5-5";

function catalogHas(id: string): boolean {
  return modelsFor("claude").some((model) => model.id === id);
}

function modelId(value: unknown, fallback: string): string {
  const safe = catalogHas(fallback) ? fallback : (modelsFor("claude")[0]?.id ?? fallback);
  if (typeof value !== "string") return safe;
  const id = value.trim();
  if (!id || id.length > 80 || !catalogHas(id)) return safe;
  return id;
}

export function isPath(value: unknown): value is PathId {
  return typeof value === "string" && (PATHS as readonly string[]).includes(value);
}

/** A missing or broken setting is a straight build that still waits at a review. */
export function readSettings(raw: unknown): PhaseSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const models = record.models && typeof record.models === "object" && !Array.isArray(record.models) ? (record.models as Record<string, unknown>) : {};
  return {
    defaultPath: isPath(record.defaultPath) ? record.defaultPath : "straight",
    continueWithoutWaiting: record.continueWithoutWaiting === true,
    models: {
      search: modelId(models.search, SEARCH_MODEL),
      judgment: modelId(models.judgment, JUDGMENT_MODEL),
    },
  };
}

export type TaskHint = {
  /** The person's choice, when they set one. Anything else is ignored. */
  path?: unknown;
  /** small skips the phases. costly researches first. product asks for a product document first. */
  weight?: unknown;
};

export function pathLabel(path: PathId): string {
  if (path === "straight") return "Straight build";
  if (path === "product-first") return "Product first";
  return "Research, plan, build";
}

/** The first mate's choice. A person's path wins. A small task gets none of this. */
export function choosePath(task: TaskHint, settingsRaw: unknown): { path: PathId; why: string } {
  if (isPath(task.path)) return { path: task.path, why: "The person set this path." };
  if (task.weight === "small") return { path: "straight", why: "A small task gets none of this." };
  if (task.weight === "product") return { path: "product-first", why: "A large change the person should approve in product terms first." };
  if (task.weight === "costly") return { path: "research-plan-build", why: "A wrong choice would be expensive, so research and a design come before building." };
  const fallback = readSettings(settingsRaw).defaultPath;
  if (fallback === "straight") return { path: "straight", why: "The project default is a straight build." };
  return { path: fallback, why: `The project default is ${pathLabel(fallback)}.` };
}
