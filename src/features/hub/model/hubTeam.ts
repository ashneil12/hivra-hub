// The leadership team made real (HUB-PLAN phase 3): each team Mono gets its soul and starting memory once, and is a
// member of every one of Ash's projects, so it can see and reach that project's sessions and its Lead (the app CLI
// only lets a Mono work in its own projects). Critiquito is an add-on: it arrives only when Ash ticks it.
import { MONO_BRIDGE_MODEL_ID } from "../../sessions/model/bridgeModels";
import { projectKey } from "../../../shared/lib/paths";
import { addMono, addMonoProject, findMono, listMonos, monoWorksOn, updateMono } from "../../monos/model/mono";
import { defaultSoul, readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { clearMonoRemovedByUser, teamRosterEntry, teamSpecOf, TEAM_ADDONS } from "./builtInMonos";
import { addMember, ensureLeadership, seatDefaultTeam } from "./hubChats";
import { isGlobalProject } from "./hubProjects";
import { startingMemory, teamSouls } from "./teamPack";
import type { HubProject } from "./types";

type Read = (monoId: string, path: AgentFilePath) => Promise<{ text: string | null; hash: string }>;
type Write = (monoId: string, path: AgentFilePath, text: string, expectedHash?: string) => Promise<unknown>;

const SEEDED_KEY = "monocode:hub-team-souls-seeded";
const TIED_KEY = "monocode:hub-team-tied";

function readSet(key: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function addTo(key: string, value: string): void {
  try {
    localStorage.setItem(key, JSON.stringify([...readSet(key), value]));
  } catch {
    /* storage unavailable: the next launch checks again, and never overwrites Ash's edits */
  }
}

/** The team Monos on the roster now (the default four, and Critiquito once Ash added it). */
export function seatedTeam(): { id: string; specId: string }[] {
  return listMonos().flatMap((m) => {
    const spec = teamSpecOf(m);
    return spec && teamSouls()[spec.id] ? [{ id: m.id, specId: spec.id }] : [];
  });
}

/**
 * Once per team Mono: write its soul when SOUL.md is missing or still the empty default (the stub the team had before
 * it had souls), and its starting memory when MEMORY.md is empty. A soul or memory Ash wrote is never replaced. A
 * Mono whose files can't be reached is tried again next launch. Returns the ids whose soul it wrote.
 */
export async function seedTeamFiles(read: Read = readAgentFile, write: Write = writeAgentFile): Promise<string[]> {
  const done = readSet(SEEDED_KEY);
  const wrote: string[] = [];
  for (const { id, specId } of seatedTeam()) {
    if (done.has(id)) continue;
    try {
      const soul = await read(id, "SOUL.md");
      if (soul.text == null || soul.text.trim() === defaultSoul().trim()) {
        await write(id, "SOUL.md", defaultSoul(teamSouls()[specId]), soul.hash);
        // The soul is in SOUL.md now; the roster's copy (kept only to seed it) goes.
        updateMono(id, (mono) => ({ ...mono, instructions: "" }));
        wrote.push(id);
      }
      const memory = await read(id, "MEMORY.md");
      const seed = startingMemory(specId);
      if (!memory.text?.trim() && seed) await write(id, "MEMORY.md", seed, memory.hash);
      addTo(SEEDED_KEY, id);
    } catch {
      /* no backend, or a concurrent save: leave it for the next launch */
    }
  }
  return wrote;
}

const ASH_ASKS_KEY = "monocode:hub-frank-ash-asks-seeded";
/** frank's soul names it as his master list of Ash's own words (teamSouls.ts). */
export const ASH_ASKS_PATH = "memory/ash-asks.md";
/**
 * r61 (A4): frank's soul checks work against "memory/ash-asks.md", but no install ever made the file, so his first
 * owner's-words check had nothing to read. It starts as the list's shape with no quotes in it: frank adds Ash's words
 * as Ash says them, and never invents one.
 */
export const ASH_ASKS_SEED = `# What Ash asked for, in his words

The owner's-words check reads this list. One line each: the date, Ash's exact words in quotes, and what they're about.
Only Ash's own words go here, never a Mono's summary of them. A newer line on the same thing says which line it replaces.

<!-- e.g. - 2026-10-14 · "..." · reasoning level -->
`;

/**
 * Once per install, for frank (the Mono whose spec is frank): write memory/ash-asks.md when it doesn't exist yet. An
 * existing list is never touched. A frank whose files can't be reached is tried again next launch.
 */
export async function seedFrankAshAsks(read: Read = readAgentFile, write: Write = writeAgentFile): Promise<boolean> {
  if (readSet(ASH_ASKS_KEY).has("frank")) return false;
  const frank = seatedTeam().find((m) => m.specId === "frank");
  if (!frank) return false;
  try {
    const file = await read(frank.id, ASH_ASKS_PATH);
    const wrote = file.text == null || !file.text.trim();
    if (wrote) await write(frank.id, ASH_ASKS_PATH, ASH_ASKS_SEED, file.hash);
    addTo(ASH_ASKS_KEY, "frank");
    return wrote;
  } catch {
    return false;
  }
}

/**
 * Every team Mono becomes a member of every one of Ash's projects that has a folder (never the global `ash` memory),
 * once per Mono and project: a project Ash later takes off a Mono stays off. `register` tells Ash OS
 * (`mono-project-add`, role member); its failures are ignored. Returns "<mono>|<project>" for each new tie.
 */
export function tieTeamToProjects(
  projects: readonly HubProject[],
  register?: (monoId: string, projectId: string) => Promise<unknown>,
): string[] {
  const tied: string[] = [];
  const done = readSet(TIED_KEY);
  for (const { id } of seatedTeam()) {
    for (const project of projects) {
      if (isGlobalProject(project.id)) continue;
      void register?.(id, project.id)?.catch(() => undefined);
      if (!project.folder) continue;
      const key = `${id}|${projectKey(project.folder)}`;
      if (done.has(key)) continue;
      const mono = findMono(id);
      if (mono && !monoWorksOn(mono, project.folder)) {
        addMonoProject(id, project.folder);
        tied.push(`${id}|${project.id}`);
      }
      addTo(TIED_KEY, key);
    }
  }
  return tied;
}

/** Each project's Leadership team gets the default team, once per chat (hubChats.seatDefaultTeam). */
export function seatLeadershipTeams(projects: readonly HubProject[]): void {
  for (const project of projects) if (!isGlobalProject(project.id)) seatDefaultTeam(project.id);
}

/**
 * Ash ticked an add-on (Critiquito): it joins the roster with its soul, works on the given projects and sits in their
 * Leadership teams. Undoes an earlier removal, since ticking it is his yes. Returns its id, or undefined if unknown.
 */
export function addTeamAddon(addonId: string, projects: readonly HubProject[] = []): string | undefined {
  const spec = TEAM_ADDONS.find((a) => a.id === addonId);
  if (!spec) return undefined;
  const folders = projects.filter((p) => !isGlobalProject(p.id)).flatMap((p) => (p.folder ? [p.folder] : []));
  const existing = listMonos().find((m) => teamSpecOf(m)?.id === spec.id);
  const id = existing?.id ?? spec.id;
  if (!existing) {
    clearMonoRemovedByUser(spec.id, spec.name);
    addMono(teamRosterEntry(spec, folders));
  } else {
    for (const folder of folders) if (!monoWorksOn(existing, folder)) addMonoProject(id, folder);
  }
  for (const project of projects) if (!isGlobalProject(project.id)) addMember(ensureLeadership(project.id).id, id);
  return id;
}

/** Team Monos made before engines were noted get theirs (Claude Code), once; a later change by Ash stays. */
export function noteTeamEngines(): string[] {
  const noted: string[] = [];
  for (const mono of listMonos()) {
    const spec = teamSpecOf(mono);
    if (!spec || mono.engine) continue;
    updateMono(mono.id, (m) => ({ ...m, engine: spec.engine, engineModel: MONO_BRIDGE_MODEL_ID }));
    noted.push(mono.id);
  }
  return noted;
}
