// Soul refresh: when the app's soul template for a Mono changes, the Mono takes it on its own (decided 20 Oct; applied
// automatically per Ash's 14 Oct rule: bigger bot changes apply themselves, land in Bot changes with Undo, and never wait
// for a click).
//
// Souls used to be seeded once and never again (hubTeam.ts seedTeamFiles, hubLeads.ts leadSoul through
// ensureProjectLeads and monoFiles.ts readMonoFiles), so every copy froze at whatever template its branch had that day:
// on Ash's Mac the Hivra, Nibbii and EXO leads still ran on the 15 Oct soul, without the start-ack, Stuck and report-back
// rules. Now, on each pass:
// - A Mono whose SOUL.md already matches its template has that template recorded as `soul-template.md` in its home.
// - A Mono whose soul is behind takes the new template there and then. The whole old soul is saved first as a topic note
//   (memory/soul-before-refresh-<day>.md), and the change is a Bot changes row (Settings → Changes → Bot changes) with
//   Undo, which puts the old soul back. An undone refresh is never made again for that template.
// - Ash's hand edits win. With a recorded template, only the sections he left as they were take the new text; ones he
//   rewrote stay as he wrote them, ones he deleted stay deleted, ones he added stay, and the row says in plain words
//   which parts of the app's update were skipped because of that. Without one (Monos seeded before this existed, such
//   as the 15 Oct leads), the soul is swapped only when it is exactly a soul the app itself once seeded
//   (knownSouls.generated.ts, built from git history by scripts/known-souls.mjs); if it differs at all, Ash may have
//   edited it, so it is left alone and a plain row says so ("Hivra lead's soul has your own changes, so the app's update
//   was skipped. Ask Alfred to merge it if you want it."). "## Skills" (the skills a Mono picked up) keeps every skill and
//   adds any new template ones.
// - The row reads as what changes for that Mono, one plain sentence per section ("Hivra lead will now ask before
//   handing work to Ash"), from SECTION_SENTENCES. Never a diff, an id or a file path (design brief rule 14).
import { invoke } from "@tauri-apps/api/core";
import { listMonos, type Mono } from "../../monos/model/mono";
import { defaultSoul, readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { findBotChange, recordBotChange, recordBotNote } from "./botChanges";
import { teamSpecOf } from "./builtInMonos";
import { CHECKER_MONO_ID, CHECKER_NAME, CHECKER_SOUL } from "./hubChecker";
import { leadFor, leadSoul } from "./hubLeads";
import { KNOWN_LEAD_SHAPES, KNOWN_SOUL_HASHES } from "./knownSouls.generated";
import { TEAM_SOULS } from "./teamSouls";

export const SOUL_TEMPLATE_FILE: AgentFilePath = "soul-template.md";

/** Where the whole old soul is saved before a refresh: a topic note in that Mono's memory, one per day. */
export function oldSoulNote(day: string, fingerprint?: string): AgentFilePath {
  return `memory/soul-before-refresh-${day}${fingerprint ? `-${fingerprint}` : ""}.md`;
}

/** A Lead's own values in its soul, as the tokens scripts/known-souls.mjs hashed them with (keep the two in step). */
export const SOUL_TOKENS = {
  id: "\u27e6id\u27e7",
  name: "\u27e6name\u27e7",
  projectName: "\u27e6projectName\u27e7",
  projectId: "\u27e6projectId\u27e7",
  folder: "\u27e6folder\u27e7",
} as const;

export type SoulValues = Partial<Record<keyof typeof SOUL_TOKENS, string | null>>;

export type SoulTemplate = {
  monoId: string;
  name: string;
  template: string;
  /** A Lead's: the values its soul was seeded with, so a past seed can be recognised. */
  values?: SoulValues;
  /** A Lead's: its template for another folder (the roster had none, so the folder its soul names is kept). */
  render?(folder: string | null): string;
};

/** The template each Mono on the roster follows today: the team's souls, each Lead's and the checker's. */
export function soulTemplates(monos: readonly Mono[] = listMonos()): SoulTemplate[] {
  return monos.flatMap((mono): SoulTemplate[] => {
    const name = mono.name?.trim() || mono.id;
    const spec = teamSpecOf(mono);
    if (spec && TEAM_SOULS[spec.id]) return [{ monoId: mono.id, name, template: defaultSoul(TEAM_SOULS[spec.id]) }];
    const lead = leadFor(mono.id);
    if (lead) {
      const folder = mono.projects[0] ?? null;
      const values = { id: mono.id, name: lead.name, projectName: lead.projectName, projectId: lead.projectId, folder };
      const render = (f: string | null) => defaultSoul(leadSoul({ ...lead, id: mono.id }, f));
      return [{ monoId: mono.id, name, template: render(folder), values, render }];
    }
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
      kind: "apply";
      after: string;
      /** Sections (their headings, "" for the opening) that take the template's new text. */
      updated: string[];
      /** New sections from the template. */
      added: string[];
      /** Sections the template no longer has, which Ash never touched: they go. */
      dropped: string[];
      /** Sections the template changed that Ash had rewritten or deleted: his version wins, the update is skipped. */
      skipped: string[];
      /** Sections the template dropped that Ash had rewritten: they stay. */
      keptDropped: string[];
      /** Whether the last template this Mono took is known (so hand edits are known too). */
      knownBaseline: boolean;
    };

/** What the soul reads on the new template, keeping what Ash wrote (see the file's notes). */
export function planSoulRefresh(current: string, template: string, lastTemplate?: string | null): RefreshPlan {
  if (norm(current) === norm(template)) return { kind: "current" };
  const cur = new Map(soulSections(current).map((s) => [s.key, s.text]));
  const seed = lastTemplate != null ? new Map(soulSections(lastTemplate).map((s) => [s.key, s.text])) : undefined;
  const next = soulSections(template);
  const nextKeys = new Set(next.map((s) => s.key));
  const out: string[] = [];
  const updated: string[] = [];
  const added: string[] = [];
  const dropped: string[] = [];
  const skipped: string[] = [];
  const keptDropped: string[] = [];
  const templateChanged = (key: string, text: string) => !seed || norm(seed.get(key)) !== norm(text);
  for (const section of next) {
    const mine = cur.get(section.key);
    if (section.key === SKILLS && mine !== undefined) {
      const merged = mergeSkills(mine, section.text);
      out.push(merged);
      if (merged !== mine) updated.push(section.key);
      continue;
    }
    if (mine === undefined) {
      // In the old template but not in the soul: Ash deleted it, and it stays deleted.
      if (seed?.has(section.key)) {
        if (templateChanged(section.key, section.text)) skipped.push(section.key);
        continue;
      }
      out.push(section.text);
      added.push(section.key);
    } else if (!seed || norm(mine) === norm(seed.get(section.key))) {
      out.push(section.text);
      if (norm(mine) !== norm(section.text)) updated.push(section.key);
    } else {
      out.push(mine);
      if (norm(mine) !== norm(section.text) && templateChanged(section.key, section.text)) skipped.push(section.key);
    }
  }
  for (const [key, text] of cur) {
    if (nextKeys.has(key)) continue;
    if (seed && seed.has(key)) {
      // The template dropped a section Ash never touched: it goes. One he changed stays.
      if (norm(seed.get(key)) === norm(text)) {
        dropped.push(key);
        continue;
      }
      keptDropped.push(key);
    }
    out.push(text);
  }
  const after = `${out.join("\n\n")}\n`;
  // Nothing of the app's changes lands (only Ash's own parts would move around): leave the soul as it is.
  if (norm(after) === norm(current) || (!updated.length && !added.length && !dropped.length)) return { kind: "nothing-to-change" };
  return { kind: "apply", after, updated, added, dropped, skipped, keptDropped, knownBaseline: !!seed };
}

/**
 * What each part of a soul makes its Mono do, in Ash's words-level English: "{name} will now ...". One sentence per
 * section heading in the app's templates (teamSouls.ts, hubLeads.ts leadSoul, the checker's). When you change what a
 * section says, check its sentence still describes it; a new heading needs a sentence (soulRefresh.test.ts checks).
 */
export const SECTION_SENTENCES: Readonly<Record<string, string>> = {
  "": "{name}'s opening line is updated.",
  "Standing instructions": "{name}'s main instructions are updated to the app's newer wording.",
  // Leads
  "Your job": "{name} will now act as an orchestrator: small things itself, bigger pieces to workers with Ash's own words, and it talks to Chief of Staff rather than Ash unless the work is routed to him.",
  "Before you act": "{name} will now check its project's memory before acting, and answer a long message fast with every ask listed in Ash's order before it starts.",
  "How you run the project": "{name} will now confirm when work has really started, keep anything stuck visible with the reason, and ask Ash only from its own chat when it can't go on without him.",
  "Finishing": "{name} will now prove its own work before calling it done, and ask Ash to look only at very critical work.",
  "Who you are to Ash OS": "{name} will now show up in Ash OS under its own name, and leave development to Claude Code.",
  "Developing the hub from inside the hub": "{name} will now build every hub change in its own copy, try it in a dev copy, and reach the daily app only through a ship.",
  // The leadership team
  "Role": "{name}'s one-line role is updated.",
  "Who I am": "{name} describes who it is in the app's newer words.",
  "How I talk to Ash": "{name} will now talk to Ash the newer way: outcome first, plain words, one question at a time.",
  "How I talk": "{name} will now talk the newer way: plain words, short, and saying what's real before anyone asks.",
  "What I own": "{name}'s list of what it owns is updated.",
  "How I hand work to a project Lead and get the report back": "{name} will now brief a Lead with the outcome, what's already done and what not to touch, and expect a start confirmation and proof back.",
  "How I hand work to Leads and read the report back": "{name} will now brief Leads the newer way and check their reports against the board.",
  "RED (Ash's call, never mine)": "{name} will now leave money, customer emails, launches and anything that can't be undone to Ash.",
  "Capacity rules I enforce": "{name} will now apply the newer capacity rules before any work is given out.",
  "Job one: memory that stays true": "{name} will now keep memory true the newer way.",
  "Job two: the owner's-words check": "{name} will now check each build against Ash's own words the newer way.",
  "Job three: the dump check": "{name} will now keep Ash's rants word for word and account for every idea in them.",
  "How I work": "{name}'s review steps are updated.",
  "The look I defend (hub design rules)": "{name} will now judge screens against the newer hub design rules.",
  "How I work with the others": "{name} will now work with the other Monos the newer way.",
  "Merging a Mono's soul update": "{name} will now merge a Mono's soul update when Ash asks, keeping his own changes, and tell him in plain words what changed.",
  "How a delegated job comes back": "{name} will now report delegated jobs from the board and wait for a yes instead of acting itself.",
  "In the room": "{name} will now follow the room's newer rules: speak only with something new, keep posts short, and hand off by name.",
  "What I never do": "{name}'s list of things it never does is updated.",
  Skills: "{name} picks up the app's newer skills and keeps the ones it learned.",
  "Voice (real lines)": "{name}'s example lines are updated.",
};

const heading = (key: string) => key.replace(/^## /, "");
const fill = (sentence: string, name: string) => sentence.replace(/\{name\}/g, name);

/** One plain sentence for a section that changes: from SECTION_SENTENCES, else a plain fallback. */
export function sectionSentence(key: string, name: string): string {
  const known = SECTION_SENTENCES[heading(key)];
  return fill(known ?? `{name}'s “${heading(key)}” part is updated to the app's newer wording.`, name);
}

/** The Bot changes row's sentences: what changes, then what was skipped for Ash's own edits. */
export function refreshSentences(plan: Extract<RefreshPlan, { kind: "apply" }>, name: string): string[] {
  const part = (key: string) => (key ? `“${heading(key)}”` : "opening");
  return [
    ...[...plan.updated, ...plan.added].map((key) => sectionSentence(key, name)),
    ...plan.dropped.map((key) => `${name} no longer has the ${part(key)} part; the app dropped it.`),
    ...plan.skipped.map((key) => `You had changed ${name}'s ${part(key)} part yourself, so your version stays and the app's update to it was skipped.`),
    ...plan.keptDropped.map((key) => `You had changed ${name}'s ${part(key)} part yourself, so it stays even though the app dropped it.`),
  ];
}

/** A short, stable fingerprint of a template, so a refresh (and its Undo) is per template. */
export function templateFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** "Hivra lead's soul has your own changes, ...": the row for a soul left alone, naming the Mono by its display name and pointing to Alfred, who looks after souls. */
/** The skipped row's button: Alfred's chat, with the ask typed in for Ash to send. */
export function askAlfred(name: string): { monoId: string; label: string; text: string } {
  return { monoId: "alfred", label: "Ask Alfred", text: `merge ${name}'s update` };
}

/** A soul row once undone. */
export function undoneSoulLine(name: string): string {
  return `Undone: ${name}'s soul is back to how it was.`;
}

export function skippedLine(name: string): string {
  return `${name}'s soul has your own changes, so the app's update was skipped. Ask Alfred to merge it if you want it.`;
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The folder a Lead's soul names in its "You are ..." line (", working in <folder>."), if any. */
export function folderInSoul(soul: string): string | null {
  const who = norm(soul).match(/^You are .*$/m)?.[0];
  return who?.match(/, working in (.+)\.$/)?.[1]?.trim() || null;
}

/** soul with a Lead's values put back as tokens, longest first (the hub's own Lead keeps "hub": it is plain text too). */
function tokenized(soul: string, values: SoulValues, folder: string | null): string {
  let text = norm(soul);
  const swaps = (Object.keys(SOUL_TOKENS) as (keyof typeof SOUL_TOKENS)[])
    .filter((k) => !(k === "projectId" && values.projectId === "hub"))
    .map((k) => [(k === "folder" ? folder : values[k])?.trim() ?? "", SOUL_TOKENS[k]] as const)
    .filter(([value]) => value.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [value, token] of swaps) text = text.split(value).join(token);
  return text;
}

/** Must match scripts/known-souls.mjs withoutWho. */
const WHO = "\u27e6who\u27e7";
const withoutWho = (text: string) => norm(text).replace(/^You are .*$/m, WHO);

export type SeedMatch =
  /** Exactly a soul the app seeded, with this folder in it (null: none). */
  | { kind: "exact"; folder: string | null }
  /** The app's own text apart from its "You are ..." line (name, project, folder), which the template writes afresh. */
  | { kind: "who-line"; folder: string | null };

/**
 * Whether `soul` is a soul the app once seeded (any version in git history; knownSouls.generated.ts), whatever the
 * roster says its folder is: the roster's folder, the folder the soul names itself, or none are all tried, and a Lead
 * whose only difference is its "You are ..." line still counts (that line is the app's: name, project and folder).
 * Anything else, even one character, may be Ash's edit.
 */
export async function matchSeededSoul(soul: string, values: SoulValues = {}): Promise<SeedMatch | null> {
  const own = folderInSoul(soul);
  const folders = [...new Set([values.folder?.trim() || null, own, null])];
  for (const folder of folders) if (KNOWN_SOUL_HASHES.has(await sha256(tokenized(soul, values, folder)))) return { kind: "exact", folder };
  if (values.id && KNOWN_LEAD_SHAPES.has(await sha256(withoutWho(tokenized(soul, values, null))))) return { kind: "who-line", folder: own };
  return null;
}

/** matchSeededSoul as a yes or no. */
export async function isKnownSeededSoul(soul: string, values: SoulValues = {}): Promise<boolean> {
  return (await matchSeededSoul(soul, values)) !== null;
}

export type SoulFiles = {
  read(monoId: string, path: AgentFilePath): Promise<{ text: string | null; hash: string }>;
  write(monoId: string, path: AgentFilePath, text: string, expectedHash?: string): Promise<unknown>;
};

const today = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Save `text` and read it back; false when it didn't go in. */
async function saveChecked(files: SoulFiles, monoId: string, path: AgentFilePath, text: string, hash: string): Promise<boolean> {
  await files.write(monoId, path, text, hash);
  return (await files.read(monoId, path)).text === text;
}

/**
 * Save the whole old soul as a topic note in that Mono's memory before it changes: today's note, or, when today's
 * already holds a different soul, one named with `tag` as well. Read back; false when it didn't go in.
 */
export async function saveOldSoul(files: SoulFiles, monoId: string, soul: string, now: Date, tag: string): Promise<boolean> {
  let note = oldSoulNote(today(now));
  let existing = await files.read(monoId, note);
  if (existing.text != null && existing.text !== soul) {
    note = oldSoulNote(today(now), tag);
    existing = await files.read(monoId, note);
  }
  return existing.text === soul || saveChecked(files, monoId, note, soul, existing.hash);
}

/** Plain row line: a Lead whose project's folder isn't on this Mac keeps the folder its old soul named. */
export function keptOldFolderLine(name: string): string {
  return `${name} kept its old folder because its project's folder wasn't found on this Mac.`;
}

/**
 * Whether a folder is on this Mac. When it can't be told (no app to ask), it counts as there, so the roster's folder
 * is used as before.
 */
export async function folderOnDisk(path: string): Promise<boolean> {
  try {
    const [info] = await invoke<{ isDir: boolean }[]>("inspect_paths", { paths: [path] });
    return !!info?.isDir;
  } catch {
    return true;
  }
}

/**
 * One pass over every Mono with a template: records the template for souls that match it and refreshes the rest, each
 * as a Bot changes row with Undo; a soul with no recorded template that isn't a known seed is left alone, with a note
 * row. Returns the ids it refreshed, recorded the template for, and skipped.
 */
export async function refreshSouls(
  files: SoulFiles = { read: readAgentFile, write: writeAgentFile },
  templates: SoulTemplate[] = soulTemplates(),
  now: Date = new Date(),
  folderExists: (path: string) => Promise<boolean> = folderOnDisk,
): Promise<{ refreshed: string[]; recorded: string[]; skipped: string[] }> {
  const refreshed: string[] = [];
  const recorded: string[] = [];
  const skipped: string[] = [];
  for (const entry of templates) {
    const { monoId, name, values } = entry;
    let { template } = entry;
    try {
      const soul = await files.read(monoId, "SOUL.md");
      // Not seeded yet: its creation writes the current template.
      if (soul.text == null) continue;
      const last = await files.read(monoId, SOUL_TEMPLATE_FILE);
      let baseline = last.text;
      const notes: string[] = [];
      // The roster names no folder for this Lead: keep the one its soul names rather than writing a soul without one.
      const own = values && !values.folder?.trim() ? folderInSoul(soul.text) : null;
      if (own && entry.render) {
        template = entry.render(own);
        notes.push(`The app had no project folder for ${name}, so the folder its soul already named is kept.`);
      }
      // The roster names a folder other than the soul's, and it isn't on this Mac (Mac round 2: the stand-in hub's
      // /Users/example/... folders were adopted): keep the folder the old soul named.
      const rosterFolder = values?.folder?.trim();
      const named = rosterFolder && entry.render ? folderInSoul(soul.text) : null;
      const keptOld = !!named && named !== rosterFolder && !(await folderExists(rosterFolder!));
      if (keptOld && entry.render) {
        template = entry.render(named);
        notes.push(keptOldFolderLine(name));
      }
      if (baseline == null && norm(soul.text) !== norm(template)) {
        // No recorded template: only a soul the app itself seeded, untouched, is swapped (then it is its own baseline).
        const match = await matchSeededSoul(soul.text, values);
        if (match && !keptOld && values?.folder?.trim() && match.folder !== values.folder.trim())
          notes.push(`${name}'s old soul named a different folder from the one its project is set to now; the new soul uses its project's folder.`);
        if (!match) {
          const id = `soul-skip:${monoId}:${templateFingerprint(template)}`;
          if (!findBotChange(id)) {
            recordBotNote({ id, bot: name, monoId, line: skippedLine(name), now: "Your own version", after: "Left as it is", ask: askAlfred(name) });
            skipped.push(monoId);
          }
          continue;
        }
        baseline = soul.text;
      }
      const plan = planSoulRefresh(soul.text, template, baseline);
      if (plan.kind === "current") {
        if (last.text !== template) {
          await files.write(monoId, SOUL_TEMPLATE_FILE, template, last.hash);
          recorded.push(monoId);
        }
        continue;
      }
      if (plan.kind !== "apply") continue;
      const fp = templateFingerprint(template);
      const id = `soul-refresh:${monoId}:${fp}`;
      // Made once per template: one Ash undid stays undone.
      if (findBotChange(id)) continue;
      // 1. The whole old soul, saved first (a second refresh the same day gets its own note).
      if (!(await saveOldSoul(files, monoId, soul.text, now, fp))) continue;
      // 2. The soul itself, over the hash it was read at (a soul Ash saved meanwhile is left alone until the next pass).
      if (!(await saveChecked(files, monoId, "SOUL.md", plan.after, soul.hash))) continue;
      // 3. The template it now follows, so his later edits are known.
      await files.write(monoId, SOUL_TEMPLATE_FILE, template, last.hash);
      const sentences = [...refreshSentences(plan, name), ...notes];
      const changes = plan.updated.length + plan.added.length + plan.dropped.length;
      recordBotChange({
        id,
        bot: name,
        day: "Today",
        line: changes > 1 ? `${sentences[0]} (and ${changes - 1} more)` : sentences[0],
        now: "Its soul as it was",
        after: "Its soul on the app's newer version",
        undoneText: undoneSoulLine(name),
        details: sentences,
        monoId,
        file: "SOUL.md",
        beforeText: soul.text,
        afterText: plan.after,
      });
      refreshed.push(monoId);
    } catch {
      /* this Mono's files can't be read or saved now: the next pass tries again */
    }
  }
  return { refreshed, recorded, skipped };
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
