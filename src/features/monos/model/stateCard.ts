// The state card: what a first mate's fresh engine session is told about where things stand, beside the conversation
// brief (monoRotation.ts) and the summary tree. Built from the app's own records, never by a model, so it costs
// nothing and cannot drift: the ask ledger (asks/model/asks.ts) and the tool calls of the stretch of chat that just
// closed. Open asks are not repeated here; they travel in their own note (asks/model/askNotes.ts openAsksNote).

import type { Ask } from "../../asks/model/asks";
import type { Block } from "../../sessions/model/session";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FILES_MAX = 20;
const DONE_MAX = 12;
const RULES_MAX = 12;
const LINE_MAX = 240;

function flat(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= LINE_MAX ? one : `${one.slice(0, LINE_MAX - 1).trimEnd()}…`;
}

/** Files the tool calls after `afterBlockId` named, most recent first. */
export function filesTouched(blocks: readonly Block[], afterBlockId?: string): string[] {
  const start = afterBlockId ? blocks.findIndex((block) => block.id === afterBlockId) + 1 : 0;
  const seen = new Set<string>();
  for (let index = blocks.length - 1; index >= start && seen.size < FILES_MAX; index--) {
    const tool = blocks[index].tool;
    if (!tool) continue;
    for (const path of [tool.preview?.path, ...(tool.paths ?? [])]) {
      if (path && seen.size < FILES_MAX) seen.add(path);
    }
  }
  return [...seen];
}

export type StateCardInput = {
  /** This first mate's asks, open and closed. */
  asks: readonly Ask[];
  /** The chat as it stood before the turn that starts the fresh session. */
  blocks: readonly Block[];
  /** Where the stretch that just closed began (the previous rotation's last block). */
  afterBlockId?: string;
  now: number;
};

/** Undefined when the records hold nothing worth a card. */
export function stateCard(input: StateCardInput): string | undefined {
  const recent = (ask: Ask) => input.now - ask.updatedAt <= WEEK_MS;
  const done = input.asks
    .filter((ask) => ask.status === "done" && recent(ask))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, DONE_MAX);
  const rules = input.asks
    .filter((ask) => (ask.kind === "rule" || ask.kind === "decide") && ask.status !== "dropped" && ask.status !== "maybe" && recent(ask))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RULES_MAX);
  const files = filesTouched(input.blocks, input.afterBlockId);
  if (!done.length && !rules.length && !files.length) return undefined;
  const parts: string[] = ["<where_things_stand>", "From the app's own records, not a summary. Use it to pick up without asking Ash to repeat himself."];
  if (rules.length) {
    parts.push("Rules and decisions Ash gave in the last week, in his words:");
    for (const ask of rules) parts.push(`- "${flat(ask.quote)}"`);
  }
  if (done.length) {
    parts.push("Finished in the last week:");
    for (const ask of done) parts.push(`- ask ${ask.n}: ${flat(ask.summary)}${ask.proof ? ` (${flat(ask.proof)})` : ""}`);
  }
  if (files.length) {
    parts.push("Files you last worked with, most recent first:");
    for (const path of files) parts.push(`- ${path}`);
  }
  parts.push("</where_things_stand>");
  return parts.join("\n");
}
