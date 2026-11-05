// WP-84: the first mate starts phases before anyone writes code. A usual task does not wait.

import { LARGE_SCOPE } from "../../agent-app/model/taskDifficulty";
import { commentId, loadPhaseSettings, startPhaseWork } from "./store";
import { isPath, type PathId, type TaskHint } from "./settings";

/** A usual job stays small, so the project default cannot phase it. A hard job researches first. */
export function phaseHint(input: { hard?: unknown; heavy?: unknown; scope?: unknown; path?: unknown }): TaskHint {
  if (isPath(input.path)) return { path: input.path };
  const scope = Array.isArray(input.scope) ? input.scope.length : 0;
  if (input.hard === true || input.heavy === true || scope >= LARGE_SCOPE) return { weight: "costly" };
  return { weight: "small" };
}

/** Holds the coding worker until the phase documents are accepted, or until there is nothing to wait for. */
export async function phaseBeforeCrew(
  taskId: string,
  hint: TaskHint,
  projectKey: string,
  ids: () => string = commentId,
): Promise<{ hold: boolean; why: string; path: PathId }> {
  let chosen = hint;
  if (chosen.weight === "costly" && !isPath(chosen.path)) {
    const settings = loadPhaseSettings(projectKey);
    if (settings.defaultPath === "product-first") chosen = { weight: "product" };
  }
  const work = await startPhaseWork(taskId, chosen, loadPhaseSettings(projectKey), ids);
  if (!work || work.removed || work.path === "straight" || work.building) {
    return { hold: false, why: work?.why ?? "", path: work?.path ?? "straight" };
  }
  return { hold: true, why: work.why, path: work.path };
}
