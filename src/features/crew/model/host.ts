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
import { routeDefaults } from "./workerDefault";
import { monoForSession } from "../../monos/model/mono";
import { hasHeadlessChildBackend } from "../../../integrations/harness/core/child";
import { pathKey } from "../../../shared/lib/paths";
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

/** A usable name for an error thrown by the command, the webview's bridge or a test. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CREW_READ_LEAD = "The crew policy could not be read";

/**
 * The person-facing line for a crew read that failed. A reason that is already that sentence is returned as it is,
 * so the gate and the webview do not wrap it into a second copy.
 */
export function crewReadRefusal(error: unknown, sentence: string): string {
  const reason = reasonOf(error);
  if (reason.startsWith(CREW_READ_LEAD)) return reason;
  return `${sentence} (${reason}).`;
}

/**
 * The lock and the Never use list in force for a Mono in a folder: the union of the Mono's, the project's and the
 * system's saved policies (WP-141 MEDIUM 6). A policy that can't be read is an error, never an empty policy
 * (MEDIUM 4): the caller refuses the launch or the change.
 */
async function policyInForce(
  monoId: string | undefined,
  folder: string | undefined,
): Promise<{ neverUse: string[]; lock: boolean; owners: string[] }> {
  // Round 9 (LOW-3): every project that owns the folder counts, so a Lead in a worktree or a package gets its project's
  // lock. A folder no saved project owns reads only the Mono's and the system's.
  const owners = folder ? await owningProjects(folder) : [];
  const scopes: [string, string][] = [];
  if (monoId) scopes.push(["mono", monoId]);
  for (const owner of owners) scopes.push(["project", owner]);
  scopes.push(["system", "system"]);
  const neverUse: string[] = [];
  let lock = false;
  for (const [scope, scopeId] of scopes) {
    let got: { policy?: unknown; policyOwn?: boolean } | undefined;
    try {
      got = await invoke<{ policy?: unknown; policyOwn?: boolean } | undefined>("crew_rules_get", {
        scope,
        scopeId,
        project: folder ?? null,
      });
    } catch (error) {
      throw new Error(crewReadRefusal(error, "The crew policy could not be read, so nothing was started"));
    }
    if (!got || typeof got !== "object") {
      throw new Error("The crew policy could not be read, so nothing was started (no answer).");
    }
    // A scope with no policy of its own adds nothing. The system's is always read.
    if (got.policyOwn !== true && scope !== "system") continue;
    const policy = sanitizePolicy(got.policy);
    lock = lock || policy.lockDefault;
    for (const id of policy.neverUse) if (!neverUse.includes(id)) neverUse.push(id);
  }
  return { neverUse, lock, owners };
}

export async function crewPolicyInForce(
  monoId: string | undefined,
  folder: string | undefined,
): Promise<{ neverUse: string[]; lock: boolean }> {
  const { neverUse, lock } = await policyInForce(monoId, folder);
  return { neverUse, lock };
}

/**
 * WP-141: the one gate a worker or session launch passes before its process starts (Rust: crew/gate.rs). It refuses a
 * CLI on Never use, a CLI other than the locked default under the lock, and a policy that can't be read. It rejects
 * with the reason, which is the line the person and the Lead see.
 */
export function crewLaunchCheck(input: {
  cli: string;
  mono?: string;
  folder?: string;
  /** The CLI the route picked, which the lock pins this launch to. */
  lockedDefault?: string;
  /** The session this launch starts. Its spawn is judged against the decision recorded here. */
  sessionId?: string;
  /** The session that started this one. Its grant's projects stay in force for the child. */
  parentSession?: string;
}): Promise<void> {
  return invoke<void>("crew_launch_check", {
    input: {
      cli: input.cli,
      ...(input.mono ? { mono: input.mono } : {}),
      ...(input.folder ? { project: input.folder } : {}),
      ...(input.lockedDefault ? { lockedDefault: input.lockedDefault } : {}),
    },
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.parentSession ? { parentSession: input.parentSession } : {}),
  });
}

/** WP-141: the one-time ticket harness_spawn needs for an agent session's process (judged again at the spawn). */
export function crewSpawnTicket(input: { sessionId: string; cli: string; folder: string }): Promise<string> {
  return invoke<string>("crew_spawn_ticket", input);
}

/** WP-141 HIGH-B: whether any saved crew policy, in any scope, has the lock on. */
export function crewAnyLock(): Promise<boolean> {
  return invoke<boolean>("crew_any_lock");
}

/**
 * Round 6: the OpenCode 2.x bind (crew_bind_v2_session). The v2 service start and session create run only after this
 * consumes the ticket crewSpawnTicket minted for the same session, CLI and folder. It refuses without a valid one.
 */
export function crewBindV2Session(input: { sessionId: string; cli: string; folder: string; ticket: string }): Promise<void> {
  return invoke<void>("crew_bind_v2_session", input);
}

/**
 * Round 7: the OpenCode 2.x judgment for one session: the ticket, then the bind that consumes it. It runs where the
 * crew gate runs, the webview. The headless host has no window and no gate, so it skips here and the app enforces it.
 */
export async function judgeV2Session(input: { sessionId: string; folder: string }): Promise<void> {
  if (typeof window === "undefined") {
    // The headless host runs its own child backend and has no gate; anywhere else a missing window means no gate.
    if (hasHeadlessChildBackend()) return;
    throw new Error("The crew gate is unavailable, so nothing was started.");
  }
  const ticket = await crewSpawnTicket({ sessionId: input.sessionId, cli: "opencode", folder: input.folder });
  await crewBindV2Session({ sessionId: input.sessionId, cli: "opencode", folder: input.folder, ticket });
}

/** A stored default the route can use. A blank pick is no default. */
function usableDefault(
  pick: Parameters<typeof routeDefaults>[0]["project"],
): Parameters<typeof routeDefaults>[0]["project"] {
  if (!pick || (!pick.cli && !pick.model && !pick.effort)) return undefined;
  return pick;
}

type WorkerPick = Parameters<typeof routeDefaults>[0]["project"];

/**
 * WP-141 round 11: the worker default for a folder. Its own hub project wins, then the most specific project that
 * owns it. `roots` are hub project folders, so a project with a worker default and no crew row is still found.
 * A plan, a session start, a brief and the crew pick all use this.
 * The gate already returns owners most specific first. Sorting them again by the length of the spelling would let a
 * long path beat the package the gate put first.
 */
export async function projectDefaultForFolder(
  folder: string,
  lookup: (key: string) => WorkerPick,
  opts?: { roots?: readonly string[] },
): Promise<WorkerPick> {
  const own = usableDefault(lookup(folder));
  if (own) return own;
  const seen = pathKey(folder);
  for (const owner of await owningProjects(folder, opts?.roots)) {
    if (pathKey(owner) === seen) continue;
    const pick = usableDefault(lookup(owner));
    if (pick) return pick;
  }
  return undefined;
}

/**
 * Round 8 (MED-C): the crew policy in force for a plan the Lead starts in a folder. It reads the Lead's own Mono, and
 * the locked default the route picks for that Mono and folder, so a plan is judged against that default rather than
 * the Lead's own CLI. A route that can't be read fails the plan closed.
 *
 * Round 11: the project default is the folder's own worker default, then the most specific owning project's. Hub project
 * folders are passed as roots, so a project with a worker default and no crew row is still found.
 */
export async function crewPolicyForLead(
  folder: string,
  leadId: string,
  defaults?: {
    project?: (folder: string) => WorkerPick;
    system?: () => Parameters<typeof routeDefaults>[0]["system"];
    roots?: readonly string[];
  },
): Promise<{ neverUse: string[]; lock: boolean; lockedDefault?: string }> {
  const mono = monoForSession(leadId);
  const { neverUse, lock } = await policyInForce(mono?.id, folder);
  if (!lock) return { neverUse, lock: false };
  const project = defaults?.project
    ? await projectDefaultForFolder(folder, defaults.project, { roots: defaults.roots })
    : undefined;
  let route: Route;
  try {
    route = await crewRouteFor({
      labels: [],
      paths: [],
      project: folder,
      ...(mono?.id ? { mono: mono.id } : {}),
      defaults: routeDefaults({
        mono: mono?.workerDefault,
        project,
        system: defaults?.system?.(),
      }),
    });
  } catch (error) {
    throw new Error(crewReadRefusal(error, "The crew policy could not be read, so nothing was started"));
  }
  return { neverUse, lock: true, ...(route.cli ? { lockedDefault: route.cli } : {}) };
}

/**
 * Round 9 (LOW-3): the saved projects that own a folder, read by the gate (crew_projects_owning). A folder the gate
 * cannot answer for falls back to the folder itself, so the Mono's and the system's policies still apply.
 */
async function owningProjects(folder: string, roots?: readonly string[]): Promise<string[]> {
  let got: unknown;
  try {
    got = await invoke<unknown>("crew_projects_owning", {
      folder,
      ...(roots && roots.length > 0 ? { roots: [...roots] } : {}),
    });
  } catch (error) {
    throw new Error(crewReadRefusal(error, "The crew policy could not be read, so nothing was started"));
  }
  if (Array.isArray(got) && got.every((owner) => typeof owner === "string")) return got as string[];
  return [folder];
}
