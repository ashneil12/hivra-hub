// Soul refresh: when the app's soul template for a Mono changes, the Mono hears about it (decided 20 Oct).
//
// Souls used to be seeded once and never again (hubTeam.ts seedTeamFiles, hubLeads.ts leadSoul through
// ensureProjectLeads and monoFiles.ts readMonoFiles), so every copy froze at whatever template its branch had that day:
// on Ash's Mac the Hivra, Nibbii and EXO leads still ran on the 15 Oct soul, without the start-ack, Stuck and report-back
// rules. Now, on each pass:
// - A Mono whose SOUL.md already matches its template has that template recorded as `soul-template.md` in its home.
// - A Mono whose soul is behind gets a proposed Bot change (Settings → Changes → Bot changes, Apply or Dismiss). Nothing
//   is written until Apply, and once applied it has Undo like any other bot change.
// - Edits Ash made by hand are never overwritten silently. With a recorded template, the proposal changes only the
//   sections he left as they were, keeps the ones he rewrote, keeps sections he added and respects ones he deleted.
//   Without one (Monos seeded before this existed), it proposes the template section by section and says so, so he
//   (or CoS) checks the full text before applying, and Apply keeps the whole old soul as a topic note
//   (memory/soul-before-refresh.md) so a line he typed is never lost. Sections he added are kept either way, and so is
//   "## Skills" (the skills a Mono picked up), with any new template skills added.
// - Dismissed: never proposed again for that template; a later template change proposes again.
import { listMonos, type Mono } from "../../monos/model/mono";
import { defaultSoul, readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { isProposalDismissed, proposeBotChange } from "./botChanges";
import { teamSpecOf } from "./builtInMonos";
import { CHECKER_MONO_ID, CHECKER_NAME, CHECKER_SOUL } from "./hubChecker";
import { leadFor, leadSoul } from "./hubLeads";
import { TEAM_SOULS } from "./teamSouls";

export const SOUL_TEMPLATE_FILE: AgentFilePath = "soul-template.md";

/** Where Apply keeps the old soul when hand edits can't be told apart. */
export const OLD_SOUL_NOTE: AgentFilePath = "memory/soul-before-refresh.md";

export type SoulTemplate = { monoId: string; name: string; template: string };

/** The template each Mono on the roster follows today: the team's souls, each Lead's and the checker's. */
export function soulTemplates(monos: readonly Mono[] = listMonos()): SoulTemplate[] {
  return monos.flatMap((mono): SoulTemplate[] => {
    const name = mono.name?.trim() || mono.id;
    const spec = teamSpecOf(mono);
    if (spec && TEAM_SOULS[spec.id]) return [{ monoId: mono.id, name, template: defaultSoul(TEAM_SOULS[spec.id]) }];
    const lead = leadFor(mono.id);
    if (lead) return [{ monoId: mono.id, name, template: defaultSoul(leadSoul({ ...lead, id: mono.id }, mono.projects[0] ?? null)) }];
    if (mono.id === CHECKER_MONO_ID) return [{ monoId: mono.id, name: name || CHECKER_NAME, template: defaultSoul(CHECKER_SOUL) }];
    return [];
  });
}

type Section = { key: string; text: string };

/** A soul by its "## " sections; the text before the first heading is the "" section. */
export function soulSections(text: string): Section[] {
  const out: Section[] = [];
  let key = "";
  let lines: string[] = [];
  const push = () => {
    if (key || lines.some((l) => l.trim())) out.push({ key, text: lines.join("\n").replace(/\s+$/, "") });
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^## /.test(line)) {
      push();
      key = line.trim().replace(/\s+/g, " ");
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  push();
  return out;
}

const SKILLS = "## Skills";
const norm = (text: string | undefined) => (text ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");

function mergeSkills(current: string, template: string): string {
  const have = new Set(current.split("\n").filter((l) => /^\s*-\s+/.test(l)).map((l) => l.trim()));
  const extra = template.split("\n").filter((l) => /^\s*-\s+/.test(l) && !have.has(l.trim()));
  return extra.length ? `${current}\n${extra.join("\n")}` : current;
}

export type RefreshPlan =
  | { kind: "current" }
  | { kind: "nothing-to-change" }
  | {
      kind: "propose";
      after: string;
      /** Sections that take the template's text. */
      updated: string[];
      /** Sections Ash rewrote, kept as he wrote them. */
      kept: string[];
      added: string[];
      dropped: string[];
      /** Whether the last template this Mono took is known (so hand edits are known too). */
      knownBaseline: boolean;
    };

const label = (key: string) => (key ? key.replace(/^## /, "") : "opening");

/** What the soul would read on the new template, keeping what Ash wrote (see the file's notes). */
export function planSoulRefresh(current: string, template: string, lastTemplate?: string | null): RefreshPlan {
  if (norm(current) === norm(template)) return { kind: "current" };
  const cur = new Map(soulSections(current).map((s) => [s.key, s.text]));
  const seed = lastTemplate != null ? new Map(soulSections(lastTemplate).map((s) => [s.key, s.text])) : undefined;
  const next = soulSections(template);
  const nextKeys = new Set(next.map((s) => s.key));
  const out: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];
  const added: string[] = [];
  const dropped: string[] = [];
  for (const section of next) {
    const mine = cur.get(section.key);
    if (section.key === SKILLS && mine !== undefined) {
      out.push(mergeSkills(mine, section.text));
      continue;
    }
    if (mine === undefined) {
      // In the old template but not in the soul: Ash deleted it, and it stays deleted.
      if (seed?.has(section.key)) continue;
      out.push(section.text);
      added.push(label(section.key));
    } else if (!seed || norm(mine) === norm(seed.get(section.key))) {
      out.push(section.text);
      if (norm(mine) !== norm(section.text)) updated.push(label(section.key));
    } else {
      out.push(mine);
      if (norm(mine) !== norm(section.text)) kept.push(label(section.key));
    }
  }
  for (const [key, text] of cur) {
    if (nextKeys.has(key)) continue;
    // The template dropped a section Ash never touched: it goes. One he wrote or changed stays.
    if (seed && seed.has(key) && norm(seed.get(key)) === norm(text)) {
      dropped.push(label(key));
      continue;
    }
    out.push(text);
    kept.push(label(key));
  }
  const after = `${out.join("\n\n")}\n`;
  if (norm(after) === norm(current)) return { kind: "nothing-to-change" };
  return { kind: "propose", after, updated, kept, added, dropped, knownBaseline: !!seed };
}

/** A short, stable fingerprint of a template, so a proposal (and its dismissal) is per template. */
export function templateFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

type Files = {
  read(monoId: string, path: AgentFilePath): Promise<{ text: string | null; hash: string }>;
  write(monoId: string, path: AgentFilePath, text: string, expectedHash?: string): Promise<unknown>;
};

const list = (items: string[]) => items.join(", ");

/**
 * One pass over every Mono with a template. Writes nothing to a soul: it records the template for souls that match it
 * and proposes the rest. Returns the ids it proposed for and the ids whose template it recorded.
 */
export async function refreshSouls(
  files: Files = { read: readAgentFile, write: writeAgentFile },
  templates: SoulTemplate[] = soulTemplates(),
): Promise<{ proposed: string[]; recorded: string[] }> {
  const proposed: string[] = [];
  const recorded: string[] = [];
  for (const { monoId, name, template } of templates) {
    try {
      const soul = await files.read(monoId, "SOUL.md");
      // Not seeded yet: its creation writes the current template.
      if (soul.text == null) continue;
      const last = await files.read(monoId, SOUL_TEMPLATE_FILE);
      const plan = planSoulRefresh(soul.text, template, last.text);
      if (plan.kind === "current") {
        if (last.text !== template) {
          await files.write(monoId, SOUL_TEMPLATE_FILE, template, last.hash);
          recorded.push(monoId);
        }
        continue;
      }
      if (plan.kind !== "propose") continue;
      const id = `soul-refresh:${monoId}:${templateFingerprint(template)}`;
      if (isProposalDismissed(id)) continue;
      const changes = [
        plan.updated.length ? `updates ${list(plan.updated)}` : "",
        plan.added.length ? `adds ${list(plan.added)}` : "",
        plan.dropped.length ? `drops ${list(plan.dropped)}` : "",
      ].filter(Boolean);
      proposeBotChange({
        id,
        bot: name,
        day: "Proposed",
        line: plan.knownBaseline
          ? `${name}'s soul can move to the app's newer template`
          : `${name}'s soul can move to the app's newer template (check the text: hand edits can't be told apart)`,
        now: "Its soul as it is",
        after: [
          changes.length ? `New template: ${changes.join("; ")}.` : "New template.",
          plan.kept.length ? `Kept as written: ${list(plan.kept)}.` : "",
          plan.knownBaseline ? "" : `The old soul is kept as the note ${OLD_SOUL_NOTE}.`,
        ]
          .filter(Boolean)
          .join(" "),
        monoId,
        file: "SOUL.md",
        beforeText: soul.text,
        afterText: plan.after,
        alsoWrite: [
          { file: SOUL_TEMPLATE_FILE, text: template },
          ...(plan.knownBaseline ? [] : [{ file: OLD_SOUL_NOTE, text: soul.text }]),
        ],
      });
      proposed.push(monoId);
    } catch {
      /* this Mono's files can't be read now: the next pass tries again */
    }
  }
  return { proposed, recorded };
}

let running: Promise<unknown> | undefined;
let lastRun = 0;
const MIN_GAP_MS = 10 * 60_000;

/** hubData.ts calls this whenever it seeds: at most one pass at a time and one per ten minutes. */
export function refreshSoulsSoon(now = Date.now()): void {
  if (running || now - lastRun < MIN_GAP_MS) return;
  lastRun = now;
  running = refreshSouls().finally(() => {
    running = undefined;
  });
}
