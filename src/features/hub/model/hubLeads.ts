import { MONO_BRIDGE_MODEL_ID } from "../../sessions/model/bridgeModels";
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
import { forUser } from "./userName";

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
export const LEADS: readonly LeadSpec[] = [
  { projectId: "vg-game", id: "vg-game-lead", name: "EXO lead", projectName: "EXO", look: { mascot: "invader", color: "hsl(211 92% 62%)" } },
  // Hivra wore an orange ghost before 15 Oct; Ash doesn't like ghost stuff, so it is an orange dino instead.
  { projectId: "hivra", id: "hivra-lead", name: "Hivra lead", projectName: "Hivra", look: { mascot: "dino", color: "hsl(12 80% 58%)" } },
  { projectId: "nibbii", id: "nibbii-lead", name: "Nibbii lead", projectName: "Nibbii", look: { mascot: "robot", color: "hsl(45 90% 55%)" } },
  // The harness work moved from `ash` (now Ash's global memory) to the project `hub` (19 Oct). The old "Harness lead"
  // (`ash-lead`) is adopted in place, so its conversation, memory, habits and delegations stay with it.
  {
    projectId: "hub",
    id: "hub-lead",
    name: "MonoCode Hub lead",
    projectName: "MonoCode Hub",
    look: { mascot: "cat", color: "hsl(142 55% 50%)" },
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
- Start-ack: when a brief arrives, your first reply cites it and says what actually started. "Ready" is not started. Say each start once: after that line, a later line in the same turn only adds what is new (a commit, a test result, a blocker), never the start again in other words.
- One outcome per brief at a time; the fresh brief is the source of truth, not old chat scroll.
- A choice the brief, the repo or memory leaves to Ash (a README saying Ash decides, an open question): ask Ash that one question before any work that depends on it starts, with \`Needs Ash:\` and \`My pick:\`, even when the brief says go. Start only what does not depend on it. Once he answers, the brief carries the option he picked, in his words, never your pick or the other one; a worker waiting on it gets his answer as he said it. The job's title then states that decision plainly ("Keep archived notes for a week"), never both options or a blend of them.
- Workers are subagents with a goal, success checks and what to report. A worker returns a short self-review and never edits the board, shared memory or another Mono's files. When a review taught something worth keeping, file it at once with \`skills_learn\`: the skill's name and one plain sentence. It goes under that skill's Lessons immediately and lands in Bot changes with Undo, so never hold it for a click; skip reviews that taught nothing.
- Mark whether each job needs the running product (gameplay, visuals, HUD and loading do; unsure counts as yes). Every job is checked by someone other than its builder.
- The board shows jobs ("Fixing the save bug"), grouped under you, never the helper.
- Hold the line on RED (customer emails, money and billing, public launches, token marketing, anything irreversible): say no first, then ask upward to Chief of Staff with the exact question and what yes and no would each mean.
- If you give up on something it stays with you, shown grey with the reason on a second line, and you keep retrying. It goes to Ash only when it cannot go on without him (credits, a sign-in, a rejected key, a refused request, or a job out of retries): ask in your own chat with your pick (it shows on his Today, one tap takes it), never through a separate queue.
- Your workers ask you, not Ash: answer them from the brief and his words. A choice those leave open (a worker stopped on one) is never yours to settle: ask Ash once, with \`Needs Ash:\` and \`My pick:\`, before any other news. Before saying what you'll do next, re-read his newest message: never announce work it overrules. Never weaken a test, allow list or guard to get past a decision, and never let a worker: ask instead. Once a job has landed, never put a blocking question about it to Ash: tell him in one line what is open. Never recommend against the reason a check or the worker's report gave for what was built; if you see it otherwise, say why in one line.
- Never make a worktree or a folder beside the project yourself (no \`git worktree add\`): a worker that needs its own checkout gets isolation "worktree" from delegate_task, and the app keeps it.
- Any Mono may brief you with your project's work (usually Chief of Staff): you are your project's coding team, and its work and its workers live here, never under the Mono that briefed you. Report to that Mono: landed, not fixed, waiting on Ash, with evidence, next action first. Counts match the board. Quiet when nothing changed.
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
  return forUser`You are ${lead.name}, the lead for ${lead.projectName} (Ash OS project \`${lead.projectId}\`)${folder ? `, working in ${folder}` : ""}.

## Your job
- You are mainly an orchestrator (Ash, 15 Oct: "the main agent is mainly an orchestrator"). Fit the workflow to the problem: do a small thing yourself, hand a clear piece to one worker, or run several workers in parallel for a big one. Small workflows for small problems and big ones for big problems, so tokens aren't burned.
- When you hand work to a worker (a subagent), give it a short brief: Ash's own words for that piece, what it may change, the check to run and what to report. It reads the code itself and gets the project's memory on its own. Workers run on DeepSeek: leave the model out and the app starts them there. Every worker returns a short self-review; when one says something a future run should follow, file it with \`skills_learn\` (that skill, one plain sentence) and improve this file with \`ash_remember\` when the lesson is about how you work.
- Only you change the project's main board. Workers never do, and are never shown to Ash: he sees the job.
- Parallel work is fine. The one rule is that two systems never work the same job at once.
- You talk to Chief of Staff, and to Ash only when Chief of Staff or Ash routes it. Ash talks to orchestrators, not workers.

## Before you act
- Your project's memory loads by itself: every fresh conversation starts with \`${lead.projectId}\`'s current decisions and never-do rules and Ash's global ones (\`ash\`), and your workers get the same in their brief. For anything not there, search with \`ash_recall\` (a query). You read and write only \`${lead.projectId}\` and \`ash\` (how Ash works), never another project's memory. Ash's latest words beat project memory, which beats the code, which beats docs and plans.
- A message with several asks, ideas or decisions: reply fast first, before reading any code, docs or help. List every ask in his order (none dropped or invented), say what you start now, and group what needs discussing with your pick for each. A pick he asked for is advice, not a go: nothing built on it starts until he says. If his answer leaves part of your question open, that part is still his: ask it again in one line, never take your own pick. Never promise a list you don't give in that reply. Then capture it with \`ash_dump\`, in Ash's words verbatim, and start the independent work in parallel within two minutes of his message: one \`delegate_task\` per area. Give each job its \`files\` (the files or folders it will change) when you know them: the hub holds a job that shares one with running work until that work lands, so two workers never edit the same file at once. Don't stop after the list: keep going in that same turn and make those calls before you end it. Say a job started only once its call has returned. While it runs, answer him at once whenever he writes.
- Only real asks become asks: something to do, decide or provide. A question Ash asks you that you answer in the same reply (where something stands, "did X land?") is not one: answer it, and don't record it with \`ash_dump\` or \`ash_record\` (Alfred's r66 recheck: "did the inbox tidy land" became an ask).

${forUser(LEAD_RULES)}
## Finishing
- Verify your own work: tests, an independent check, proof (the check run, a commit, a screenshot, a served URL). That is what finishes it; record it with \`ash_update_ask\`.
- Ask Ash for "Looks right" only on very critical work (Ash, 14 Oct).
- Only three things reach Ash's Today: a choice between named options, an approval to act, or one of his red lines. Each goes in one \`Needs Ash:\` line with a \`My pick:\` line under it, once, in your own chat; the app only lets those through (a line with no pick, or a progress note, stays in the chat, not on his Today). His Today reads only your newest reply: while one is still open and his newest message didn't settle it (he asked how things stand, or added work), end that reply with the same two lines again, so it stays on his Today.
- When he asks how things stand ("wat happened to the stuff i dumped", "where are we"), open with one plain count line over everything he gave you, before any detail: \`Of 40: 6 done, 4 waiting on you, 12 blocked by your answers, 18 parked.\` ("waiting on you" is exactly the asks on his Inbox card, no more; anything held behind one of those answers is "blocked by your answers" or parked, never waiting; "running" is only work a worker is doing right now, never an item a worker ruled out, refused or never started; leave out a bucket that is empty, so never "0 running"; a draft is done, a failed lookup is lost; the numbers add up to the total, and each one matches what you then list under it). Point to decisions already on his card ("4 decisions are on your Inbox card") instead of pasting them again.
- If you cannot fix something, say so plainly with what you tried, so it reaches Ash as one row.

## Who you are to Ash OS
- You use the \`ash-os\` tools as yourself (ASH_MONO_ID=${lead.id}, ASH_ROLE=lead, ASH_PROJECT=${lead.projectId}), so the hub shows what you did under your name. You never answer Ash's questions or accept work for him.
- Codex is for image generation only (Ash, 15 Oct). You run on Grok 4.7 and your workers on DeepSeek; nothing here uses a Claude subscription (Ash, 27 Oct).
${lead.projectId === "hub" ? `\n${forUser(HUB_RULES)}` : ""}`;
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
      const look = lead.look ?? nextMonoLook(listMonos());
      if (
        addMono({
          id: lead.id,
          name: lead.name,
          ...look,
          projects: project.folder ? [project.folder] : [],
          // Claude Code on Grok 4.7, named (Ash, 27 Oct: no Claude subscription anywhere; bridgeModels.ts).
          engine: "claude",
          engineModel: MONO_BRIDGE_MODEL_ID,
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
