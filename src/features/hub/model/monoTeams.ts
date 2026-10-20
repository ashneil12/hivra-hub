// A Mono's own work, and its optional team. A Mono's delegated work nests under it in the Monos rail as sub-chats,
// folded under a count and opening by themselves when one is stuck (Ash, 20 Oct: "the mono sub chat setup is good too
// ... so team can be optional"). What changed is where work goes:
// - A small fix the Mono does itself, in its own chat.
// - A project's work goes to that project's coding team (codingTeam.ts; Ash, 20 Oct: "it should either do it itself or
//   pick it up with the coding team"): a Mono briefs its Lead (leadershipDelegation.ts), the Lead's workers nest under
//   the Lead, and the Mono's chat shows one line for the brief (monos/model/briefedTeams.ts).
// - Work of the Mono's own, outside any project (a marketing Mono's research or drafts), runs in its own folder, made the
//   first time it hands such work to a worker: `<app data>/mono-teams/<mono id>` (src-tauri/src/mono.rs mono_team_dir).
//   Every copy of the app has its own (the daily app, each dev slot, the bench's throwaway HOME, so a dev copy's workers
//   never write where the daily app's do), and it sits beside the Mono's files rather than in them (a ship backs up
//   monos/, and a team's output can be large).
// - Its own team is optional and off by default. Ash gives a Mono one from its menu in the Monos rail (and takes it back
//   there): that folder then opens as a workspace like a coding team, its Sessions list pinning the Mono's chat on top
//   with its workers under it, and its workers show there rather than under it in the rail, whose row offers "Open team"
//   (teamFor). Off again, they nest under it in the rail again; the folder and its chats stay.
//
// Each Mono's folder and whether its team is on are kept on this Mac by Mono id, so the delegate tool knows the folder
// before a worker starts and the Sessions list knows it before the folder is read.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "../../../shared/lib/paths";
import { monoWorksOn } from "../../monos/model/mono";
import { loadTabGroupLabels, saveTabGroupLabel } from "../../workspace/model/tabGroups";
import { codingTeamName } from "./codingTeam";
import { leadFor, leadMono, leadSpecFor } from "./hubLeads";
import { isGlobalProject } from "./hubProjects";
import type { HubProject } from "./types";

const KEY = "monocode:mono-teams";

/**
 * A Mono's own work: the folder its own workers run in, when it was made, and whether Ash gave it its own team (`on`), so
 * that folder opens as a workspace with its workers in it instead of nesting them under the Mono in the rail.
 */
export type MonoTeam = { monoId: string; folder: string; createdAt: number; on: boolean };

let teams: Record<string, MonoTeam> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function load(): Record<string, MonoTeam> {
  if (teams) return teams;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    teams =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).flatMap(([monoId, entry]) => {
              const team = entry as Partial<MonoTeam> | null;
              return team && typeof team.folder === "string" && team.folder.trim()
                ? [
                    [
                      monoId,
                      {
                        monoId,
                        folder: team.folder,
                        createdAt: typeof team.createdAt === "number" ? team.createdAt : 0,
                        // Off unless Ash switched it on.
                        on: team.on === true,
                      },
                    ],
                  ]
                : [];
            }),
          )
        : {};
  } catch {
    teams = {};
  }
  return teams;
}

function save(next: Record<string, MonoTeam>): void {
  teams = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* kept for this run; the folder is asked for again on the Mono's next delegation */
  }
  version++;
  listeners.forEach((listener) => listener());
}

/** The folder a Mono's own work runs in, once it has one, whether or not its team is on. */
export function monoWorkFolder(monoId: string): string | undefined {
  return load()[monoId]?.folder;
}

/** Whether Ash gave the Mono its own team. */
export function monoTeamOn(monoId: string): boolean {
  return load()[monoId]?.on === true;
}

/** The Mono's own team, while Ash has it on: its folder opens as a workspace with the Mono's workers in it. */
export function monoTeam(monoId: string): MonoTeam | undefined {
  const team = load()[monoId];
  return team?.on ? team : undefined;
}

/** The Mono whose own work runs in this folder (its team on or off). */
export function monoWorkOfFolder(folder: string | null | undefined): MonoTeam | undefined {
  if (!folder) return undefined;
  const key = pathKey(folder);
  return Object.values(load()).find((team) => pathKey(team.folder) === key);
}

/** A Mono's own folder: never a project of Ash's (it stays off the recent projects). */
export function isMonoWorkFolder(folder: string | null | undefined): boolean {
  return !!monoWorkOfFolder(folder);
}

/** The app's folder for a Mono's own work, made if it isn't there (src-tauri/src/mono.rs mono_team_dir). */
export type MakeTeamFolder = (monoId: string) => Promise<string>;
const makeFolder: MakeTeamFolder = (monoId) => invoke<string>("mono_team_dir", { mono: monoId });

/**
 * The Mono's own folder, made the first time it hands out work of its own: the folder is asked for (and made) every
 * time, so one removed by hand comes back, and remembered by the Mono's id with its team as it was (off unless Ash gave
 * it one).
 */
export async function ensureMonoWorkFolder(
  monoId: string,
  make: MakeTeamFolder = makeFolder,
  now = Date.now(),
): Promise<MonoTeam> {
  const folder = await make(monoId);
  if (typeof folder !== "string" || !folder.trim()) throw new Error("The app couldn't make a folder for this Mono's own work.");
  const known = load()[monoId];
  if (known && pathKey(known.folder) === pathKey(folder)) return known;
  const team: MonoTeam = { monoId, folder, createdAt: known?.createdAt ?? now, on: known?.on ?? false };
  save({ ...load(), [monoId]: team });
  return team;
}

/**
 * Ash gives a Mono its own team, or takes it back (its menu in the Monos rail). On makes its folder if it has none yet,
 * so the team opens before its first worker; off keeps the folder and its workers' chats, which nest under the Mono in
 * the rail again. Never a Lead's: its work is its project's coding team's.
 */
export async function setMonoTeam(
  monoId: string,
  on: boolean,
  make: MakeTeamFolder = makeFolder,
  now = Date.now(),
): Promise<MonoTeam | undefined> {
  if (on && leadFor(monoId)) throw new Error("A project's Lead works in its project's coding team; it has no team of its own.");
  if (!on) {
    const known = load()[monoId];
    if (known?.on) save({ ...load(), [monoId]: { ...known, on: false } });
    return undefined;
  }
  const work = await ensureMonoWorkFolder(monoId, make, now);
  if (work.on) return work;
  const team = { ...work, on: true };
  save({ ...load(), [monoId]: team });
  return team;
}

/** A deleted Mono's own work is forgotten (its folder stays on disk, with whatever its workers made). */
export function forgetMonoTeam(monoId: string): void {
  if (!(monoId in load())) return;
  const next = { ...load() };
  delete next[monoId];
  save(next);
}

/** How the team is named where it opens ("Alfred's team"). */
export function monoTeamName(monoName: string | undefined): string {
  const name = monoName?.trim();
  return name ? `${name}'s team` : "Team";
}

/** The workspace names the team's folder after it ("Alfred's team"), as a coding team's is named after its project. */
export function nameMonoTeam(folder: string, monoName: string | undefined): void {
  const key = pathKey(folder);
  const name = monoTeamName(monoName);
  if (loadTabGroupLabels()[key] !== name) saveTabGroupLabel(key, name);
}

export function useMonoTeamsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}

/** Tests: forget every Mono's own work and team. */
export function resetMonoTeams(): void {
  teams = undefined;
  version++;
}

/** The team a Mono's "Open team" opens: its project's coding team (a Lead's), or its own. */
export type TeamTarget =
  | { kind: "coding"; projectId: string; name: string }
  | { kind: "mono"; monoId: string; folder: string; name: string };

/**
 * A Mono's team, if it has one: a project's Lead works in that project's coding team (when the project has a code
 * folder), any other Mono in its own team while Ash has it on. None otherwise: its work nests under it in the rail.
 */
export function teamFor(
  mono: { id: string; name?: string },
  projects: readonly HubProject[],
): TeamTarget | undefined {
  const lead = leadFor(mono.id);
  if (lead) {
    const project = projects.find((entry) => entry.id === lead.projectId && !!entry.folder);
    if (project && leadMono(leadSpecFor(project))?.id === mono.id)
      return { kind: "coding", projectId: project.id, name: codingTeamName(project) };
    return undefined;
  }
  const own = monoTeam(mono.id);
  return own ? { kind: "mono", monoId: mono.id, folder: own.folder, name: monoTeamName(mono.name) } : undefined;
}

/** A project's coding team as a Mono reaches it: the project, its Lead, and the team's name ("EXO coding team"). */
export type CodingTeamRef = { projectId: string; leadName: string; name: string };

/**
 * The coding team a project a Mono names is (its hub id, its name, its folder or the folder's name), when the project has
 * a code folder and a Lead working on it. That project's work goes to its coding team as a brief to the Lead, never to
 * a worker of the Mono's own (agentAppTasks.ts).
 */
export function codingTeamNamed(named: string, projects: readonly HubProject[]): CodingTeamRef | undefined {
  const want = named.trim();
  if (!want) return undefined;
  const key = pathKey(want);
  const lower = want.toLowerCase();
  const project = projects.find(
    (entry) =>
      !!entry.folder &&
      !isGlobalProject(entry.id) &&
      (entry.id === want ||
        pathKey(entry.folder) === key ||
        entry.name.toLowerCase() === lower ||
        entry.shortName?.toLowerCase() === lower ||
        pathKey(entry.folder).split("/").pop() === want),
  );
  if (!project?.folder) return undefined;
  const spec = leadSpecFor(project);
  const lead = leadMono(spec);
  if (!lead || !monoWorksOn(lead, project.folder)) return undefined;
  return { projectId: project.id, leadName: lead.name?.trim() || spec.name, name: codingTeamName(project) };
}
