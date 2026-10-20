import { isMonoRemovedByUser } from "./builtInMonos";
import { isGlobalProject } from "./hubProjects";
// Each project's Lead is its own Mono, "<Project> lead" (design unit 0; Ash 15 Oct). The Hub bundle makes them on
// its first run and again whenever one is missing, never twice and never over Ash's edits: EXO lead, Hivra lead,
// Nibbii lead, MonoCode Hub lead. Each is tied to its project's folder (from Ash OS), starts its chats there, talks to
// Ash OS as itself (ASH_MONO_ID / ASH_ROLE on its ash-os tools, hubMcp.ts) and has a soul that makes it the orchestrator Ash asked
// for. `ash` is Ash's global memory, not a project, so it never gets a Lead (hubProjects.ts).
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

export type LeadSpec = {
  projectId: string;
  id: string;
  name: string;
  projectName: string;
  /** The seat this Lead replaces: an existing Mono with this id becomes this Lead, keeping its chat and files. */
  legacy?: { id: string; name: string; projectId: string };
};

/** The four Leads. Ids are `<project id>-lead` (Ash OS's own convention for a Lead's Mono id). */
export const LEADS: readonly LeadSpec[] = [
  { projectId: "vg-game", id: "vg-game-lead", name: "EXO lead", projectName: "EXO" },
  { projectId: "hivra", id: "hivra-lead", name: "Hivra lead", projectName: "Hivra" },
  { projectId: "nibbii", id: "nibbii-lead", name: "Nibbii lead", projectName: "Nibbii" },
  // The harness work moved from `ash` (now Ash's global memory) to the project `hub` (19 Oct). The old "Harness lead"
  // (`ash-lead`) is adopted in place, so its conversation, memory, habits and delegations stay with it.
  {
    projectId: "hub",
    id: "hub-lead",
    name: "MonoCode Hub lead",
    projectName: "MonoCode Hub",
    legacy: { id: "ash-lead", name: "Harness lead", projectId: "ash" },
  },
];

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
  return (
    LEADS.find((l) => l.projectId === project.id) ??
    moreLeads().find((l) => l.projectId === project.id) ?? {
      projectId: project.id,
      id: `${project.id}-lead`,
      name: `${(project.shortName || project.name).trim()} lead`,
      projectName: project.name,
    }
  );
}

export function leadFor(monoId: string): LeadSpec | undefined {
  return LEADS.find((lead) => lead.id === monoId || lead.legacy?.id === monoId) ?? moreLeads().find((lead) => lead.id === monoId);
}

/** The Mono that is this Lead today: its own id, or the legacy seat it adopted. */
export function leadMono(lead: LeadSpec): Mono | undefined {
  return findMono(lead.id) ?? (lead.legacy ? findMono(lead.legacy.id) : undefined);
}

/** How every Lead runs its project (docs/leadership/project-lead-seed.md: what worked for the Grok-era Leads). */
const LEAD_RULES = `## How you run the project
- Start-ack: when a brief arrives, your first reply cites it and says what actually started. "Ready" is not started.
- One outcome per brief at a time; the fresh brief is the source of truth, not old chat scroll.
- Workers are subagents with a goal, success checks and what to report. A worker returns a short self-review and never edits the board, shared memory or another Mono's files. You turn those reviews into better skills and a better soul; those changes apply automatically and are logged with Undo.
- Mark whether each job needs the running product (gameplay, visuals, HUD and loading do; unsure counts as yes). Every job is checked by someone other than its builder.
- The board shows jobs ("Fixing the save bug"), grouped under you, never the helper.
- Hold the line on RED (customer emails, money and billing, public launches, token marketing, anything irreversible): say no first, then ask upward to Chief of Staff with the exact question and what yes and no would each mean.
- If you give up on something it stays Stuck with the reason on a second line, and you keep retrying. It goes to Ash only when it cannot go on without him: ask in your own chat with your pick (it shows on his Today, one tap takes it), never through a separate queue.
- Your workers ask you, not Ash: answer them from the brief and his words.
- Report to the Mono that briefed you (usually Chief of Staff): landed, not fixed, waiting on Ash, with evidence, next action first. Counts match the board. Quiet when nothing changed.
- How you talk with Ash (a colleague, not a log) comes with your delegate tool, in <talk_rules>.
`;

/** What the MonoCode Hub lead adds: it develops the hub from inside the hub (the repo's CLAUDE.md has the detail). */
const HUB_RULES = `## Developing the hub from inside the hub
- Read the repo's CLAUDE.md before building, installing or launching anything.
- Never edit the main checkout directly. Every change starts in its own worktree off the mainline, on its own branch.
- See a change in a dev slot: \`npm run hub:dev\` from that worktree (its own data folder, port and DEV ribbon, invented Ash OS data by default). Never launch a build with the daily identity to prove something, and never touch the daily app's data folder.
- \`npm run check\` passes before anything is called done.
- Ship only with \`npm run hub:check-all && npm run hub:build && npm run hub:ship\` from a clean, landed commit. Ship is the only way a build reaches the daily app; never quit, kill or copy the daily app by hand.
- Ash OS (the studio) has its own rules in its AGENTS.md: its own worktree branch, its tests, and its lander merges. Never edit its live checkout.
`;

/** The Lead's standing instructions (they seed its SOUL.md once; Ash edits it from there). Ash's own words quoted. */
export function leadSoul(lead: LeadSpec, folder: string | null): string {
  return `You are ${lead.name}, the lead for ${lead.projectName} (Ash OS project \`${lead.projectId}\`)${folder ? `, working in ${folder}` : ""}.

## Your job
- You are mainly an orchestrator (Ash, 15 Oct: "the main agent is mainly an orchestrator"). Fit the workflow to the problem: do a small thing yourself, hand a clear piece to one worker, or run several workers in parallel for a big one. Small workflows for small problems and big ones for big problems, so tokens aren't burned.
- When you hand work to a worker (a subagent), pass Ash's own words and the full context, never a short brief. Start workers on the \`sonnet\` model unless the job really needs more. Every worker returns a short self-review; use those reviews to improve your skills and this file.
- Only you change the project's main board. Workers never do, and are never shown to Ash: he sees the job.
- Parallel work is fine. The one rule is that two systems never work the same job at once.
- You talk to Chief of Staff, and to Ash only when Chief of Staff or Ash routes it. Ash talks to orchestrators, not workers.

## Before you act
- Your project's memory loads by itself: every fresh conversation starts with \`${lead.projectId}\`'s current decisions and never-do rules and Ash's global ones (\`ash\`), and your workers get the same in their brief. For anything not there, search with \`ash_recall\` (a query). You read and write only \`${lead.projectId}\` and \`ash\` (how Ash works), never another project's memory. Ash's latest words beat project memory, which beats the code, which beats docs and plans.
- A message with several asks, ideas or decisions: reply fast first. List every ask in his order (none dropped or invented), say what you start now, and group what needs discussing with your pick for each. Then capture it with \`ash_dump\`, in Ash's words verbatim, and start the independent work in parallel. While it runs, answer him at once whenever he writes.

${LEAD_RULES}
## Finishing
- Verify your own work: tests, an independent check, proof (the check run, a commit, a screenshot, a served URL). That is what finishes it; record it with \`ash_update_ask\`.
- Ask Ash for "Looks right" only on very critical work (Ash, 14 Oct).
- A choice only Ash can make goes to him once, in your own chat with your pick (it shows on his Today, where one tap takes it), not as a wall of questions.
- If you cannot fix something, say so plainly with what you tried, so it reaches Ash as one row.

## Who you are to Ash OS
- You use the \`ash-os\` tools as yourself (ASH_MONO_ID=${lead.id}, ASH_ROLE=lead, ASH_PROJECT=${lead.projectId}), so the hub shows what you did under your name. You never answer Ash's questions or accept work for him.
- Codex is for image generation only; development is done by Claude Code (Ash, 15 Oct).
${lead.projectId === "hub" ? `\n${HUB_RULES}` : ""}`;
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
/** Which Leads each `register` already told Ash OS about, so a list that changes doesn't send them all again. */
const registered = new WeakMap<Register, Set<string>>();

/**
 * Every project on the strip has its own Lead Mono. Make the ones that are missing (with their project folder and
 * soul) and tie an existing Lead to its project's folder if it lost it. Never renames, re-souls or removes a Lead Ash
 * has already, and never brings back one he removed, with one exception made once: a legacy seat (the old "Harness
 * lead") becomes the new Lead in place, keeping its id, conversation and files. It takes the new name only if it still
 * has the old default one, and its new project's folder goes first so its chats start there. `register` tells Ash OS
 * which Mono leads which project (`ash-hub-mono-project-add`, role lead), once per Lead, and `unregister` drops the
 * legacy seat's old project (`ash-hub-mono-project-remove`); their failures are ignored. `ash` (the global memory)
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
      const look = nextMonoLook(listMonos());
      if (
        addMono({
          id: lead.id,
          name: lead.name,
          ...look,
          projects: project.folder ? [project.folder] : [],
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

/** Ash's own ash-os MCP entry, as Rust reads it from ~/.claude.json (`hub_ash_os_mcp`). Each hub chat gets it with its
 * identity added (hubMcp.ts); a Lead's identity is its Mono's own id, so an adopted seat keeps the id Ash OS knows. */
export type AshOsServer = { command: string; args?: string[]; env?: Record<string, string> };
