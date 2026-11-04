// WP-13: the two commands the running app asks. The route is filled in by the command when `present` is empty.
// Failure text is sent so it can be classified, and the command does not store it.

import { invoke } from "@tauri-apps/api/core";
import type { Delegation } from "../../monos/model/delegations";
import type { MonoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import type { CrewFailureNote } from "./advice";
import { isCli, isEffort } from "./clis";
import type { Route } from "./resolve";
import type { CrewRouteQuery } from "./taskRoute";

export function crewRouteFor(query: CrewRouteQuery): Promise<Route> {
  return invoke<Route>("crew_route", { query });
}

function currentPick(current: { cli?: string | null; model?: string | null; effort?: string | null }) {
  const cli = current.cli && isCli(current.cli) ? current.cli : null;
  const model = typeof current.model === "string" && current.model.trim() ? current.model.trim() : null;
  const effort = typeof current.effort === "string" && isEffort(current.effort.trim()) ? current.effort.trim() : null;
  return { cli, model, effort };
}

export function recordCrewFailure(
  row: Pick<Delegation, "id" | "project" | "ownerMono">,
  result: Pick<MonoSessionCompletionResult, "errorClass" | "error" | "resetsAt">,
  current: { cli?: string | null; model?: string | null; effort?: string | null },
): Promise<CrewFailureNote | undefined> {
  const resetsAt = result.resetsAt ? Date.parse(result.resetsAt) : NaN;
  return invoke<{ action?: unknown; to?: unknown }>("crew_on_failure", {
    input: {
      delegationId: row.id,
      ...(result.errorClass ? { errorClass: result.errorClass } : {}),
      ...(result.error ? { text: result.error } : {}),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      current: currentPick(current),
      present: [],
      ...(row.project ? { project: row.project } : {}),
      ...(row.ownerMono ? { mono: row.ownerMono } : {}),
    },
  }).then((got) => {
    if (typeof got?.action !== "string") return undefined;
    const note: CrewFailureNote = { action: got.action };
    if (typeof got.to === "string") note.to = got.to;
    return note;
  });
}

/** A usage limit on a row that stays open. The failure text is not sent, and the row is not settled. */
export function recordCrewPause(
  row: Pick<Delegation, "id">,
  result: Pick<MonoSessionCompletionResult, "resetsAt">,
  current: { cli?: string | null; model?: string | null; effort?: string | null },
): Promise<void> {
  const resetsAt = result.resetsAt ? Date.parse(result.resetsAt) : NaN;
  return invoke("crew_note_pause", {
    input: {
      delegationId: row.id,
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      current: currentPick(current),
    },
  }).then(() => undefined);
}
