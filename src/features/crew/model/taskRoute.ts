// WP-13: turn a crew route into the fields a worker launch already understands.
// A route that names an unknown CLI, a model the catalog doesn't list, or an
// effort the model doesn't offer is ignored for that field, so the start still happens.

import { isCustomModelId } from "../../sessions/model/customModels";
import {
  modelEffortSetting,
  modelsFor,
  preferredModelId,
  resolveModel,
} from "../../sessions/model/models";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { isCli, isEffort } from "./clis";

export type CrewPick = {
  cli?: string;
  model?: string;
  effort?: string;
};

/** What `tasks.delegate` asks `crew_route`. An empty `present` is filled by the command. */
export type CrewRouteQuery = {
  labels: string[];
  paths: string[];
  override?: CrewPick;
  project?: string;
  mono?: string;
};

export type CrewRouteAnswer = {
  cli?: string | null;
  model?: string | null;
  effort?: string | null;
};

export type CrewLaunch = {
  harness?: HarnessId;
  model?: string;
  effort?: unknown;
};

/** What the caller named. That beats a rule, so it is sent as the override, not the brief. */
export function callerOverride(
  named: { harness: HarnessId; model: string } | undefined,
  effort: unknown,
): CrewPick | undefined {
  const pick: CrewPick = {};
  if (named && isCli(named.harness)) {
    pick.cli = named.harness;
    const model = named.model.trim();
    if (model) pick.model = model;
  }
  if (typeof effort === "string" && isEffort(effort.trim())) pick.effort = effort.trim();
  if (!pick.cli && !pick.model && !pick.effort) return undefined;
  return pick;
}

/** Area tags the pool stores as `area:ui`, as the labels a crew rule matches. */
export function crewLabels(areas: readonly string[]): string[] {
  const out: string[] = [];
  for (const area of areas) {
    const label = area.replace(/^area:/, "").trim();
    if (!label || out.includes(label)) continue;
    out.push(label);
  }
  return out;
}

/** File paths, without the area tags the pool mixes into the same list. */
export function crewPaths(...groups: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const group of groups) {
    for (const path of group) {
      const text = path.trim();
      if (!text || text.startsWith("area:") || out.includes(text)) continue;
      out.push(text);
    }
  }
  return out;
}

function knownModel(harness: HarnessId, id: string): boolean {
  if (modelsFor(harness).some((model) => model.id === id)) return true;
  return harness === "claude" && isCustomModelId(id);
}

function effortFits(harness: HarnessId, modelId: string | undefined, effort: unknown): string | undefined {
  if (typeof effort !== "string" || !isEffort(effort.trim())) return undefined;
  const value = effort.trim();
  const model = resolveModel(harness, modelId ?? preferredModelId(harness));
  if (model.harness !== harness) return undefined;
  const setting = modelEffortSetting(model);
  if (!setting?.options.some((option) => option.value === value)) return undefined;
  return value;
}

/**
 * The launch fields a crew answer replaces. An unknown CLI leaves the launch as it was.
 * A different CLI does not keep the previous model's id. An effort the model doesn't
 * offer is left off, so the start is not refused for it.
 */
export function applyCrewLaunch(route: CrewRouteAnswer | null | undefined, current: CrewLaunch): CrewLaunch {
  const cli = typeof route?.cli === "string" ? route.cli.trim() : "";
  if (!cli || !isCli(cli) || !(HARNESSES as readonly string[]).includes(cli)) return current;
  const harness = cli as HarnessId;
  const same = current.harness === harness;
  const asked = typeof route?.model === "string" ? route.model.trim() : "";
  const known = asked && knownModel(harness, asked) ? asked : undefined;
  const model = known ?? (same ? current.model : undefined);
  const namedEffort = typeof route?.effort === "string" && route.effort.trim() ? route.effort : undefined;
  const effort = effortFits(harness, model, namedEffort ?? current.effort);
  return {
    harness,
    ...(model ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}
