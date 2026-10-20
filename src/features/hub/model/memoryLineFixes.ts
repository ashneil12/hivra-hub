// One-time fixes to lines already in a Mono's MEMORY.md, when a decision changes what it should know. Each fix rewrites
// only the matching line, leaves everything else as it is, and is logged as a Bot change with Undo (an undone fix is
// never made again).
//
// The first: Chief of Staff's 19 Oct line "The team runs on Claude Code in MonoCode Hub; Grok Bot is no longer used"
// contradicts the 20 Oct handover to the Grok Bot leadership team. It becomes teamSouls.ts GROK_BOT_LINE.
import { listMonos } from "../../monos/model/mono";
import { readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { findBotChange, recordBotChange } from "./botChanges";
import { GROK_BOT_LINE } from "./teamSouls";

type Files = {
  read(monoId: string, path: AgentFilePath): Promise<{ text: string | null; hash: string }>;
  write(monoId: string, path: AgentFilePath, text: string, expectedHash?: string): Promise<unknown>;
};

/** `remembers`: what the Mono will now know, to follow "will now remember that" in one sentence. */
export type LineFix = { id: string; matches: RegExp; line: string; remembers: string };

export const LINE_FIXES: readonly LineFix[] = [
  {
    id: "grok-bot-not-required",
    matches: /Grok Bot is no longer used/i,
    line: `- 2026-10-20 · ${GROK_BOT_LINE}`,
    remembers: "Grok Bot isn't required, but may oversee and set tasks",
  },
];

/** "Chief of Staff will now remember that Grok Bot isn't required, but may oversee and set tasks." */
export function memoryFixLine(name: string, fix: Pick<LineFix, "remembers">): string {
  return `${name} will now remember that ${fix.remembers.replace(/[.\s]+$/, "")}.`;
}

/** Rewrites each matching line in every Mono's MEMORY.md. Returns "<mono>:<fix>" for each rewrite. */
export async function applyMemoryLineFixes(
  files: Files = { read: readAgentFile, write: writeAgentFile },
  monos: readonly { id: string; name?: string }[] = listMonos(),
  fixes: readonly LineFix[] = LINE_FIXES,
): Promise<string[]> {
  const done: string[] = [];
  for (const mono of monos) {
    try {
      const memory = await files.read(mono.id, "MEMORY.md");
      if (!memory.text) continue;
      let text = memory.text;
      const applied: LineFix[] = [];
      for (const fix of fixes) {
        // Undone by Ash: it stays undone.
        if (findBotChange(`memory-fix:${mono.id}:${fix.id}`)?.undone) continue;
        const lines = text.split("\n");
        if (!lines.some((l) => fix.matches.test(l))) continue;
        text = lines.map((l) => (fix.matches.test(l) ? fix.line : l)).join("\n");
        applied.push(fix);
      }
      if (!applied.length) continue;
      await files.write(mono.id, "MEMORY.md", text, memory.hash);
      const name = mono.name?.trim() || mono.id;
      for (const fix of applied) {
        recordBotChange({
          id: `memory-fix:${mono.id}:${fix.id}`,
          bot: name,
          day: "Today",
          line: memoryFixLine(name, fix),
          undoneText: `Undone: ${name}'s memory is back to how it was.`,
          now: "Grok Bot is no longer used",
          after: fix.line.replace(/^- [\d-]+ · /, ""),
          monoId: mono.id,
          file: "MEMORY.md",
          beforeText: memory.text,
          afterText: text,
        });
        done.push(`${mono.id}:${fix.id}`);
      }
    } catch {
      /* this Mono's memory can't be read or moved since: the next launch tries again */
    }
  }
  return done;
}
