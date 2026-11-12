import { defaultClaudeModelId } from "../../sessions/model/defaultClaudeModel";
import { isMonoRemovedByUser } from "./builtInMonos";
import { isGlobalProject } from "./hubProjects";
// Each project's lead is its own Mono, made on the first run and again when one is missing, never twice and never
// over an edited soul. It is tied to the project's folder, starts its chats there, and its soul is the first mate
// contract plus who it is. The global memory project never gets a lead (hubProjects.ts).
import { projectKey } from "../../../shared/lib/paths";
import {
  addMono,
  addMonoProject,
  findMono,
  listMonos,
  monoWorksOn,
  nextMonoLook,
  updateMono,
  type Mono,
} from "../../monos/model/mono";
import type { HubProject } from "./types";
import { FIRST_MATE_CONTRACT } from "../../firstmate/model/contract";

export type LeadSpec = {
  projectId: string;
  id: string;
  name: string;
  projectName: string;
  /** The seat this Lead replaces: an existing Mono with this id becomes this Lead, keeping its chat and files. */
  legacy?: { id: string; name: string; projectId: string };
  /** The creature and colour this Lead first wears (Ash's look before 15 Oct); a Lead without one takes the next free look. */
  look?: { mascot: string; color: string };
};

/**
 * The Leads the hub seeds with a look of their own. Every other project's Lead (Recall Check lead, Bark Desk lead, any
 * project Ash adds) is `<project id>-lead`, made by `ensureProjectLeads` and remembered in `moreLeads`; each is on
 * MONOS.json like any Mono. Ids are `<project id>-lead` (Ash OS's convention); `ash-lead` is only the old id that
 * `hub-lead` replaced.
 */
/** No project is special. A project's lead is `<project id>-lead`, named from the project (leadSpecFor). */
export const LEADS: readonly LeadSpec[] = [];

/** Leads of projects beyond the four (one Ash made with New project, or a project Ash OS added to the strip). */
const MORE_KEY = "monocode:hub-project-leads";
function moreLeads(): LeadSpec[] {
  try {
    const v = JSON.parse(localStorage.getItem(MORE_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is LeadSpec => !!x && typeof x.id === "string" && typeof x.projectId === "string" && typeof x.name === "string") : [];
  } catch {
    return [];
  }
}
function rememberLead(spec: LeadSpec): void {
  if (LEADS.some((l) => l.id === spec.id)) return;
  const list = moreLeads();
  if (list.some((l) => l.id === spec.id)) return;
  try {
    localStorage.setItem(MORE_KEY, JSON.stringify([...list, spec]));
  } catch {
    /* storage unavailable: the Lead still works this session as a Mono, only its rank and identity wait */
  }
}

/**
 * The Lead a project has: one of the four, else `<project id>-lead` named "<Project> lead" (Ash OS's own convention for
 * a Lead's Mono id).
 */
export function leadSpecFor(project: Pick<HubProject, "id" | "name" | "shortName">): LeadSpec {
  const saved = LEADS.find((l) => l.projectId === project.id) ?? moreLeads().find((l) => l.projectId === project.id);
  if (saved) return saved;
  const spec: LeadSpec = {
    projectId: project.id,
    id: `${project.id}-lead`,
    name: `${(project.shortName || project.name).trim()} lead`,
    projectName: project.name,
  };
  // The hub's previous lead id. While it is still on the roster, it is this lead: no second hub-lead is made.
  if (project.id === "hub") spec.legacy = { id: "ash-lead", name: "Harness lead", projectId: "ash" };
  return spec;
}

/** The Lead a project already has (seeded or remembered), if any. Never makes one. */
export function projectLeadOf(projectId: string): LeadSpec | undefined {
  return LEADS.find((l) => l.projectId === projectId) ?? moreLeads().find((l) => l.projectId === projectId);
}

export function leadFor(monoId: string): LeadSpec | undefined {
  const match = (lead: LeadSpec) => lead.id === monoId || lead.legacy?.id === monoId;
  return LEADS.find(match) ?? moreLeads().find(match);
}

/** The Mono that is this Lead today: its own id, or the legacy seat it adopted. */
export function leadMono(lead: LeadSpec): Mono | undefined {
  return findMono(lead.id) ?? (lead.legacy ? findMono(lead.legacy.id) : undefined);
}

/** A new lead's soul: the first mate contract, plus who this lead is. An existing soul is not rewritten. */
export function leadSoul(lead: LeadSpec, folder: string | null): string {
  const where = folder ? `, working in ${folder}` : "";
  return `# Soul

## Role
You are ${lead.name}, the lead for ${lead.projectName} (project \`${lead.projectId}\`)${where}.

## Who I am
You lead this project's coding team. You take a goal, brief the work, and report what actually happened.

${FIRST_MATE_CONTRACT}
`;
}

export type EnsureResult = { created: string[]; tied: string[]; adopted: string[] };

const ADOPTED_KEY = "monocode:hub-lead-adopted";
function adoptedOnce(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(ADOPTED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** How long to wait before each further try of an adopted Lead's soul reseed. */
const RESEED_RETRY_MS = [5_000, 30_000, 120_000] as const;

/**
 * After `ensureProjectLeads` adopted a legacy seat: reseed its soul (`reseed`, reseedAdoptedLeadSoul), then record the
 * adoption, so it happens once. A failed reseed is logged and tried again a few times; one that never works leaves the
 * adoption unrecorded, so the next pass (or launch) adopts it again, which changes nothing twice, and reseeds again.
 * Resolves whether it was recorded.
 */
export async function completeLeadAdoption(
  monoId: string,
  reseed: () => Promise<unknown>,
  options: { wait?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await reseed();
    } catch (error) {
      console.error(`Could not write the adopted Lead's soul (${monoId})`, error);
      if (attempt >= RESEED_RETRY_MS.length) return false;
      await wait(RESEED_RETRY_MS[attempt]);
      continue;
    }
    try {
      localStorage.setItem(ADOPTED_KEY, JSON.stringify([...new Set([...adoptedOnce(), monoId])]));
    } catch {
      /* storage unavailable: adopting again changes nothing */
    }
    return true;
  }
}

type Register = (monoId: string, projectId: string) => Promise<unknown>;
/** Which Leads each `register` already recorded, so a list that changes doesn't send them all again. */
const registered = new WeakMap<Register, Set<string>>();

/**
 * Every project on the strip has its own Lead Mono. Make the ones that are missing (with their project folder and
 * soul) and tie an existing Lead to its project's folder if it lost it. Never renames, re-souls or removes a Lead Ash
 * has already, and never brings back one he removed, with one exception made once: a legacy seat (the old "Harness
 * lead") becomes the new Lead in place, keeping its id, conversation and files. It takes the new name only if it still
 * has the old default one, and its new project's folder goes first so its chats start there. `register` records in the app's own store (localHub.ts)
 * which Mono leads which project (`mono-project-add`, role lead), once per Lead, and `unregister` drops the
 * legacy seat's old project (`mono-project-remove`); their failures are ignored. `ash` (the global memory)
 * never gets one.
 */
export function ensureProjectLeads(projects: readonly HubProject[], register?: Register, unregister?: Register): EnsureResult {
  const created: string[] = [];
  const tied: string[] = [];
  const adopted: string[] = [];
  for (const project of projects) {
    if (isGlobalProject(project.id)) continue;
    const lead = leadSpecFor(project);
    if (isMonoRemovedByUser(lead.id)) continue;
    rememberLead(lead);
    const existing = leadMono(lead);
    // Ash removed the seat this Lead replaces: it stays gone.
    if (!existing && lead.legacy && isMonoRemovedByUser(lead.legacy.id)) continue;
    if (!existing) {
      const look = lead.look ?? nextMonoLook(listMonos());
      if (
        addMono({
          id: lead.id,
          name: lead.name,
          ...look,
          projects: project.folder ? [project.folder] : [],
          // Claude Code on the app's default Claude model.
          engine: "claude",
          engineModel: defaultClaudeModelId(),
          instructions: leadSoul(lead, project.folder),
        })
      )
        created.push(lead.id);
    } else if (lead.legacy && existing.id === lead.legacy.id && !adoptedOnce().has(existing.id)) {
      const legacy = lead.legacy;
      const folder = project.folder;
      updateMono(existing.id, (mono) => ({
        ...mono,
        name: !mono.name || mono.name === legacy.name ? lead.name : mono.name,
        projects: folder ? [folder, ...mono.projects.filter((p) => projectKey(p) !== projectKey(folder))] : mono.projects,
      }));
      // Recorded once its soul is reseeded (completeLeadAdoption); until then adopting again changes nothing.
      void unregister?.(existing.id, legacy.projectId)?.catch(() => undefined);
      adopted.push(existing.id);
    } else if (project.folder && !monoWorksOn(existing, project.folder)) {
      addMonoProject(existing.id, project.folder);
      tied.push(existing.id);
    }
    if (register) {
      const monoId = existing?.id ?? lead.id;
      const told = registered.get(register) ?? new Set<string>();
      registered.set(register, told);
      if (!told.has(monoId)) {
        told.add(monoId);
        void register(monoId, lead.projectId)?.catch(() => told.delete(monoId));
      }
    }
  }
  return { created, tied, adopted };
}

/** The generated opening of the old Harness lead's soul: a SOUL.md that still has it was never rewritten by Ash. */
const LEGACY_SOUL_MARK = "You are Harness lead, the lead for the harness";

type SoulPath = "SOUL.md" | `memory/${string}.md`;
type FileReader = (monoId: string, path: SoulPath) => Promise<{ text: string | null; hash: string }>;
type FileWriter = (monoId: string, path: SoulPath, text: string, expectedHash?: string) => Promise<unknown>;

/**
 * An adopted Lead's soul: the generated Harness-lead soul (or none) is replaced with the new Lead's, and the old text is
 * kept first as a topic note (memory/harness-lead-soul.md). A soul Ash rewrote is left alone. Returns whether it wrote.
 */
export async function reseedAdoptedLeadSoul(
  monoId: string,
  folder: string | null,
  wrap: (instructions: string) => string,
  read: FileReader,
  write: FileWriter,
): Promise<boolean> {
  const lead = leadFor(monoId);
  if (!lead?.legacy || lead.legacy.id !== monoId) return false;
  const current = await read(monoId, "SOUL.md");
  if (current.text != null && !current.text.includes(LEGACY_SOUL_MARK)) return false;
  if (current.text != null) {
    const note = await read(monoId, "memory/harness-lead-soul.md");
    if (note.text == null) await write(monoId, "memory/harness-lead-soul.md", current.text, note.hash);
  }
  await write(monoId, "SOUL.md", wrap(leadSoul({ ...lead, id: monoId }, folder)), current.hash);
  return true;
}

/** Where a Lead's chats start: its project's folder (the first one it was given). Other Monos start at home. */
export function leadWorkingFolder(monoId: string): string | undefined {
  if (!leadFor(monoId)) return undefined;
  return findMono(monoId)?.projects[0];
}

