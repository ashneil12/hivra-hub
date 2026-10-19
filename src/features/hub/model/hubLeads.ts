import { isMonoRemovedByUser } from "./builtInMonos";
// Each project's Lead is its own Mono, "<Project> lead" (design unit 0; Ash 15 Oct). The Hub bundle makes the four on
// its first run and again whenever one is missing, never twice and never over Ash's edits: EXO lead, Hivra lead,
// Nibbii lead, Harness lead. Each is tied to its project's folder (from Ash OS), starts its chats there, talks to Ash
// OS as itself (ASH_MONO_ID / ASH_ROLE on its ash-os tools, hubMcp.ts) and has a soul that makes it the orchestrator Ash asked for.
import { addMono, addMonoProject, findMono, listMonos, monoWorksOn, nextMonoLook } from "../../monos/model/mono";
import type { HubProject } from "./types";

export type LeadSpec = { projectId: string; id: string; name: string; projectName: string };

/** The four Leads. Ids are `<project id>-lead` (Ash OS's own convention for a Lead's Mono id). */
export const LEADS: readonly LeadSpec[] = [
  { projectId: "vg-game", id: "vg-game-lead", name: "EXO lead", projectName: "EXO" },
  { projectId: "hivra", id: "hivra-lead", name: "Hivra lead", projectName: "Hivra" },
  { projectId: "nibbii", id: "nibbii-lead", name: "Nibbii lead", projectName: "Nibbii" },
  { projectId: "ash", id: "ash-lead", name: "Harness lead", projectName: "the harness" },
];

export function leadFor(monoId: string): LeadSpec | undefined {
  return LEADS.find((lead) => lead.id === monoId);
}

/** The Lead's standing instructions (they seed its SOUL.md once; Ash edits it from there). Ash's own words quoted. */
export function leadSoul(lead: LeadSpec, folder: string | null): string {
  return `You are ${lead.name}, the lead for ${lead.projectName} (Ash OS project \`${lead.projectId}\`)${folder ? `, working in ${folder}` : ""}.

## Your job
- You are mainly an orchestrator (Ash, 15 Oct: "the main agent is mainly an orchestrator"). Fit the workflow to the problem: do a small thing yourself, hand a clear piece to one worker, or run several workers in parallel for a big one. Small workflows for small problems and big ones for big problems, so tokens aren't burned.
- When you hand work to a worker (a subagent), pass Ash's own words and the full context, never a short brief. Start workers on the \`sonnet\` model unless the job really needs more. Every worker returns a short self-review; use those reviews to improve your skills and this file.
- Only you change the project's main board. Workers never do, and are never shown to Ash: he sees the job.
- Parallel work is fine. The one rule is that two systems never work the same job at once.

## Before you act
- Read the project's memory first: \`ash_recall ${lead.projectId}\`. Ash's latest words beat project memory, which beats the code, which beats docs and plans.
- A message with several asks, ideas or decisions: capture it first with \`ash_dump\`, in Ash's words verbatim, then work.

## Finishing
- Verify your own work: tests, an independent check, proof (the check run, a commit, a screenshot, a served URL). That is what finishes it; record it with \`ash_update_ask\`.
- Ask Ash for "Looks right" only on very critical work (Ash, 14 Oct).
- A choice only Ash can make goes to him once, with your recommendation (\`ash_ask_ash\`), not as a wall of questions.
- If you cannot fix something, say so plainly with what you tried, so it reaches Ash as one row.

## Who you are to Ash OS
- You use the \`ash-os\` tools as yourself (ASH_MONO_ID=${lead.id}, ASH_ROLE=lead), so the hub shows what you did under your name. You never answer Ash's questions or accept work for him.
- Codex is for image generation only; development is done by Claude Code (Ash, 15 Oct).
`;
}

export type EnsureResult = { created: string[]; tied: string[] };

/**
 * Make the Leads that are missing (with their project folder and soul) and tie an existing Lead to its project's
 * folder if it lost it. Never renames, re-souls or removes a Lead Ash has already. `register` tells Ash OS which Mono
 * leads which project (`ash-hub-mono-project-add`, role lead); its failures are ignored.
 */
export function ensureProjectLeads(
  projects: readonly HubProject[],
  register?: (monoId: string, projectId: string) => Promise<unknown>,
): EnsureResult {
  const created: string[] = [];
  const tied: string[] = [];
  for (const lead of LEADS) {
    const project = projects.find((p) => p.id === lead.projectId);
    if (!project || isMonoRemovedByUser(lead.id)) continue;
    const existing = findMono(lead.id);
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
    } else if (project.folder && !monoWorksOn(existing, project.folder)) {
      addMonoProject(lead.id, project.folder);
      tied.push(lead.id);
    }
    void register?.(lead.id, lead.projectId)?.catch(() => undefined);
  }
  return { created, tied };
}

/** Where a Lead's chats start: its project's folder (the first one it was given). Other Monos start at home. */
export function leadWorkingFolder(monoId: string): string | undefined {
  if (!leadFor(monoId)) return undefined;
  return findMono(monoId)?.projects[0];
}

/** Ash's own ash-os MCP entry, as Rust reads it from ~/.claude.json (`hub_ash_os_mcp`). Each hub chat gets it with its
 * identity added (hubMcp.ts). */
export type AshOsServer = { command: string; args?: string[]; env?: Record<string, string> };
