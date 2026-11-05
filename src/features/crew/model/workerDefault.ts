// WP-89: a worker default is { cli?, model?, effort? }. Reading an old project row
// (a Claude model and effort, no CLI) stays that Claude choice. Nothing here rewrites the row.

import { isCli } from "./clis";
import type { Pick, RouteDefaults } from "./resolve";

export type StoredProjectDefault = {
  cli?: string | null;
  model?: string | null;
  effort?: string | null;
};

function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return undefined;
  return text;
}

/**
 * What a stored project row means. A model or effort with no CLI is the old
 * Claude-only setting. A CLI that isn't one is dropped, not rewritten to Claude.
 * A blank row is unset.
 */
export function readProjectWorkerDefault(stored: StoredProjectDefault | null | undefined): Pick | undefined {
  if (!stored) return undefined;
  const model = clean(stored.model);
  const effort = clean(stored.effort);
  const rawCli = clean(stored.cli);
  const cli = rawCli && isCli(rawCli) ? rawCli : undefined;
  if (!cli && !model && !effort) return undefined;
  const assumed = !rawCli && (model || effort) ? "claude" : undefined;
  const use = cli ?? assumed;
  return {
    ...(use ? { cli: use } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * A default as it was stored, without the old project row's Claude assumption.
 * A CLI that isn't one is dropped. A blank or broken field is dropped.
 */
export function cleanStoredDefault(stored: StoredProjectDefault | null | undefined): Pick | undefined {
  if (!stored) return undefined;
  const model = clean(stored.model);
  const effort = clean(stored.effort);
  const rawCli = clean(stored.cli);
  const cli = rawCli && isCli(rawCli) ? rawCli : undefined;
  if (!cli && !model && !effort) return undefined;
  return {
    ...(cli ? { cli } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function setPick(pick: Pick | undefined): Pick | undefined {
  if (!pick || (!pick.cli && !pick.model && !pick.effort)) return undefined;
  return pick;
}

/** The defaults a launch sends with the crew route. An empty scope is left out. */
export function routeDefaults(input: {
  mono?: Pick;
  project?: Pick;
  system?: Pick;
}): RouteDefaults | undefined {
  const mono = setPick(input.mono);
  const project = setPick(input.project);
  const system = setPick(input.system);
  if (!mono && !project && !system) return undefined;
  return {
    ...(mono ? { mono } : {}),
    ...(project ? { project } : {}),
    ...(system ? { system } : {}),
  };
}
