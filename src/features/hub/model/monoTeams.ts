// Teams, not sub-chats (Ash, 20 Oct: "monos shouldn't really have sub chats, if its stuff to fix it should either do it
// itself or pick it up with the coding team. IF they do need to do work ... then something like coding team should be
// created for that mono i think and somehow linked"). Sub-chats only ever live in a team: a workspace with a Sessions
// list, where the chat that owns the team is pinned on top and its workers nest under it.
// - A project's work goes to that project's coding team (codingTeam.ts): a Mono briefs its Lead
//   (leadershipDelegation.ts), and the Lead's workers nest under the Lead there.
// - A small fix the Mono does itself, in its own chat.
// - Work of the Mono's own, outside any project (a marketing Mono's research or drafts): its own team, made the first
//   time it hands such work to a worker. Its folder is `<app data>/mono-teams/<mono id>` (src-tauri/src/mono.rs
//   mono_team_dir): every copy of the app has its own (the daily app, each dev slot, the bench's throwaway HOME, so a
//   dev copy's workers never write where the daily app's do), it sits beside the Mono's files rather than in them (a
//   ship backs up monos/, and a team's output can be large), and the team's own Explorer shows what is in it.
// The Monos rail shows people, not work: each Mono's row says what it has out and opens its team (teamFor).
//
// Which folder is a Mono's team is kept on this Mac by Mono id, so the delegate tool knows it before a worker starts and
// the Sessions list knows it before the folder is read.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "../../../shared/lib/paths";
import { monoWorksOn } from "../../monos/model/mono";
import { codingTeamName } from "./codingTeam";
import { leadFor, leadMono, leadSpecFor } from "./hubLeads";
import { isGlobalProject } from "./hubProjects";
import type { HubProject } from "./types";

const KEY = "monocode:mono-teams";

/** A Mono's own team: its workers' folder, and when it was made. */
export type MonoTeam = { monoId: string; folder: string; createdAt: number };

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
                ? [[monoId, { monoId, folder: team.folder, createdAt: typeof team.createdAt === "number" ? team.createdAt : 0 }]]
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

/** The Mono's own team, once it has one. */
export function monoTeam(monoId: string): MonoTeam | undefined {
  return load()[monoId];
}

/** The Mono whose own team works in this folder. */
export function monoTeamOfFolder(folder: string | null | undefined): MonoTeam | undefined {
  if (!folder) return undefined;
  const key = pathKey(folder);
  return Object.values(load()).find((team) => pathKey(team.folder) === key);
}

export function isMonoTeamFolder(folder: string | null | undefined): boolean {
  return !!monoTeamOfFolder(folder);
}

/** The app's folder for a Mono's team, made if it isn't there (src-tauri/src/mono.rs mono_team_dir). */
export type MakeTeamFolder = (monoId: string) => Promise<string>;
const makeFolder: MakeTeamFolder = (monoId) => invoke<string>("mono_team_dir", { mono: monoId });

/**
 * The Mono's own team, made the first time it is needed: the folder is asked for (and made) every time, so a folder
 * removed by hand comes back, and remembered by the Mono's id.
 */
export async function ensureMonoTeam(monoId: string, make: MakeTeamFolder = makeFolder, now = Date.now()): Promise<MonoTeam> {
  const folder = await make(monoId);
  if (typeof folder !== "string" || !folder.trim()) throw new Error("The app couldn't make a folder for this Mono's team.");
  const known = load()[monoId];
  if (known && pathKey(known.folder) === pathKey(folder)) return known;
  const team: MonoTeam = { monoId, folder, createdAt: known?.createdAt ?? now };
  save({ ...load(), [monoId]: team });
  return team;
}

/** A deleted Mono's team is forgotten (its folder stays on disk, with whatever its workers made). */
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

/** Tests: forget every team. */
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
 * folder), any other Mono in its own team once it has made one. None for a Mono that only talks and briefs.
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
