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
import type { Catalog, RouteDefaults } from "./resolve";
import type { CrewRule } from "./rules";

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
  /** WP-21: rules stored on the Mono. They are that Mono's rules when any survive the checks. */
  monoRules?: CrewRule[];
  /** WP-89: the Mono, project and system defaults. The command judges them against `catalog`. */
  defaults?: RouteDefaults;
  catalog?: Catalog;
};

/** One thing the route left out: a CLI on Never use, or the Lead's pick the lock dropped. */
export type CrewRouteSkip = {
  field?: string | null;
  from?: string | null;
  value?: string | null;
  reason?: string | null;
};

export type CrewRouteAnswer = {
  cli?: string | null;
  model?: string | null;
  effort?: string | null;
  /** Where the CLI came from. A default, or no source, keeps the launch. */
  cliFrom?: string | null;
  modelFrom?: string | null;
  effortFrom?: string | null;
  skipped?: CrewRouteSkip[] | null;
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

const CHOSEN_FROM = new Set(["override", "brief", "rule", "mono", "project", "system"]);

function chosen(from: string | null | undefined): boolean {
  return typeof from === "string" && CHOSEN_FROM.has(from);
}

/** The lock dropped the Lead's pick. Nothing the Lead named may build the launch then. */
function lockDroppedPick(route: CrewRouteAnswer): boolean {
  return (route.skipped ?? []).some((skip) => skip?.field === "cli" && skip.from === "override");
}

/** The route skipped the CLI this launch would run on (Never use, or the lock on a cooled CLI). */
function launchCliSkipped(route: CrewRouteAnswer, harness: string | undefined): boolean {
  return Boolean(harness) && (route.skipped ?? []).some((skip) => skip?.field === "cli" && skip.value === harness);
}

/**
 * A route that must replace the CLI whatever its source: the lock dropped the Lead's pick, or the
 * launch's own CLI is on Never use. The route's CLI then wins, even when it came from the signed-in default.
 */
export function crewForcesCli(route: CrewRouteAnswer | null | undefined, current: CrewLaunch): boolean {
  if (!route) return false;
  return lockDroppedPick(route) || launchCliSkipped(route, current.harness);
}

/**
 * The reason a forced CLI cannot be run: the route named no CLI at all. The caller refuses the start with it.
 * Undefined when nothing forces a change, or the route names a CLI.
 */
export function crewRefusal(route: CrewRouteAnswer | null | undefined, current: CrewLaunch): string | undefined {
  if (!route || route.cli || !crewForcesCli(route, current)) return undefined;
  const reasons = (route.skipped ?? []).map((skip) => skip?.reason?.trim()).filter((text): text is string => Boolean(text));
  return reasons.length
    ? `No CLI can take this work. ${reasons.join(" ")}`
    : "No CLI can take this work: none is installed and signed in.";
}

/**
 * The launch fields a crew answer replaces. A field changes when it came from the override,
 * the brief, a matching rule, or a Mono, project or system default. The app's usual rule, or no
 * source, keeps what the app already picked.
 * An unknown CLI leaves the launch as it was. A different CLI does not keep the previous model's id.
 * An effort the model doesn't offer is left off, so the start is not refused for it.
 */
export function applyCrewLaunch(route: CrewRouteAnswer | null | undefined, named: CrewLaunch): CrewLaunch {
  if (!route) return named;
  // The lock dropped the Lead's pick: its model and effort never build the launch either.
  const current: CrewLaunch = lockDroppedPick(route) ? { harness: named.harness } : named;
  const forced = crewForcesCli(route, named);
  const cliChosen = forced ? Boolean(route.cli) : chosen(route.cliFrom);
  const modelChosen = chosen(route.modelFrom);
  const effortChosen = chosen(route.effortFrom);
  if (!cliChosen && !modelChosen && !effortChosen) return current;
  const askedCli = cliChosen && typeof route.cli === "string" ? route.cli.trim() : "";
  if (cliChosen && (!askedCli || !isCli(askedCli) || !(HARNESSES as readonly string[]).includes(askedCli))) {
    return current;
  }
  const harness = (cliChosen ? askedCli : current.harness) as HarnessId | undefined;
  if (!harness) return current;
  const same = current.harness === harness;
  const asked = modelChosen && typeof route.model === "string" ? route.model.trim() : "";
  const known = asked && knownModel(harness, asked) ? asked : undefined;
  const model = known ?? (same ? current.model : undefined);
  const namedEffort = effortChosen && typeof route.effort === "string" && route.effort.trim() ? route.effort : undefined;
  const carriedEffort = same ? current.effort : undefined;
  const effort = effortFits(harness, model, namedEffort ?? (effortChosen ? undefined : carriedEffort));
  return {
    harness,
    ...(model ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}
