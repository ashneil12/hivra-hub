// Crew rules: what every worker of one first mate works by, beside the app's own worker rules (agentAppTasks.ts
// workerRules). Capy's Captain Drive splits the Captain's own rules (AGENTS.md, which crew never read) from CREW.md, which
// every crew thread rereads every turn; here the first mate's soul is its own rules and this note is the crew's.
//
// The note is the Mono's memory topic `memory/crew-rules.md`, so the Mono keeps it with the memory tools it already has,
// in Ash's words ("from now on every worker opens PRs as drafts"), and no new file kind is needed. It travels in every
// brief and with every message the first mate sends a running worker, so a rule added mid-run reaches it.

import { readAgentFile } from "./monoFiles";

export const CREW_RULES_TOPIC = "crew-rules";
export const CREW_RULES_PATH = `memory/${CREW_RULES_TOPIC}.md` as const;
/** A crew rules note past this many characters is cut, with a line saying so: it rides on every brief and message. */
export const CREW_RULES_MAX = 2_000;

/** The block a worker gets, or undefined when the note is missing or empty. */
export function crewRulesBlock(text: string | null | undefined, from: string): string | undefined {
  const body = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return undefined;
  const cut = body.length > CREW_RULES_MAX;
  const kept = cut ? `${body.slice(0, CREW_RULES_MAX).trimEnd()}\n(cut: the rest is in ${from}'s crew rules note)` : body;
  return `<crew_rules from="${from.replace(/["<>]/g, "")}">\nRules your first mate set for every worker. They hold for this whole task, and a newer copy replaces this one.\n${kept}\n</crew_rules>`;
}

/** The first mate's crew rules, read fresh. Unreadable reads as none, never as a failure of the brief. */
export async function readCrewRules(monoId: string, from: string): Promise<string | undefined> {
  try {
    const file = await readAgentFile(monoId, CREW_RULES_PATH);
    return crewRulesBlock(file.text, from);
  } catch {
    return undefined;
  }
}
