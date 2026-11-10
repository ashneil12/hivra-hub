// WP-13: the two commands the running app asks. The route is filled in by the command when `present` is empty.
// Failure text is sent so it can be classified, and the command does not store it.

import { invoke } from "@tauri-apps/api/core";
import type { Delegation } from "../../monos/model/delegations";
import type { MonoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import type { CrewFailureNote } from "./advice";
import { isCli, isEffort } from "./clis";
import type { Route } from "./resolve";
import type { CrewRouteQuery } from "./taskRoute";
import { sanitizePolicy } from "./policy";
import type { CrewPickAnswer, CrewPickQuery } from "../../agent-app/model/agentAppTasks";
import type { LeadTarget } from "../../hub/model/leadershipDelegation";

export function crewRouteFor(query: CrewRouteQuery): Promise<Route> {
  return invoke<Route>("crew_route", { query });
}

/** WP-141: the first mate's pick across signed-in CLIs and the Monos it may brief (crew_pick). Reads only. */
export function crewPickFor(request: CrewPickQuery): Promise<CrewPickAnswer> {
  return invoke<CrewPickAnswer>("crew_pick", { request });
}

/**
 * WP-141: the pick's Mono roster: the Leads a Mono may brief, each with its own role words. `lead` is what
 * delegate_task's `lead` takes.
 */
export function pickMonosFrom(
  targets: readonly Pick<LeadTarget, "leadId" | "leadName" | "projectId">[],
  monos: readonly { id: string; role?: string }[],
): { id: string; name: string; role?: string; lead: string }[] {
  return targets.map((target) => {
    const role = monos.find((mono) => mono.id === target.leadId)?.role?.trim();
    return { id: target.leadId, name: target.leadName, ...(role ? { role } : {}), lead: target.projectId };
  });
}

function currentPick(current: { cli?: string | null; model?: string | null; effort?: string | null }) {
  const cli = current.cli && isCli(current.cli) ? current.cli : null;
  const model = typeof current.model === "string" && current.model.trim() ? current.model.trim() : null;
  const effort = typeof current.effort === "string" && isEffort(current.effort.trim()) ? current.effort.trim() : null;
  return { cli, model, effort };
}

/**
 * `folder` is the project's folder, which is what Crew Defaults saves a project's policy and budget under. A row
 * carries the hub project id, so the caller passes the folder; without one the row's own project is sent.
 */
export function recordCrewFailure(
  row: Pick<Delegation, "id" | "project" | "ownerMono">,
  result: Pick<MonoSessionCompletionResult, "errorClass" | "error" | "resetsAt">,
  current: { cli?: string | null; model?: string | null; effort?: string | null },
  folder?: string | null,
): Promise<CrewFailureNote | undefined> {
  const project = folder?.trim() || row.project;
  const resetsAt = result.resetsAt ? Date.parse(result.resetsAt) : NaN;
  return invoke<{ action?: unknown; to?: unknown }>("crew_on_failure", {
    input: {
      delegationId: row.id,
      ...(result.errorClass ? { errorClass: result.errorClass } : {}),
      ...(result.error ? { text: result.error } : {}),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      current: currentPick(current),
      present: [],
      ...(project ? { project } : {}),
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

/** The lock and Never use list in force for a Mono in a folder: its own policy, else the project's, else everything's. */
export async function crewPolicyInForce(
  monoId: string | undefined,
  folder: string | undefined,
): Promise<{ neverUse: string[]; lock: boolean }> {
  const scopes: [string, string][] = [];
  if (monoId) scopes.push(["mono", monoId]);
  if (folder) scopes.push(["project", folder]);
  scopes.push(["system", "system"]);
  for (const [scope, scopeId] of scopes) {
    const got = await invoke<{ policy?: unknown; policyOwn?: boolean } | undefined>("crew_rules_get", {
      scope,
      scopeId,
      project: folder ?? null,
    }).catch(() => undefined);
    if (!got || typeof got !== "object") continue;
    if (got.policyOwn === true || scope === "system") {
      const policy = sanitizePolicy(got.policy);
      return { neverUse: policy.neverUse, lock: policy.lockDefault };
    }
  }
  return { neverUse: [], lock: false };
}
