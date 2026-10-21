import { useSyncExternalStore } from "react";
import { examples } from "./examples";
import { readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { restoreRetiredMono, retireMono, type RetiredMono } from "../../monos/model/monoArchive";

/**
 * Changes bots made to themselves (skills, how they work). Shown only under
 * Settings → Changes → Bot changes. No badge or count anywhere, and these
 * never create Needs. Small fixes are bundled per bot per day.
 */
export type BotChange = {
  id: string;
  bot: string;
  day: string;
  /** Plain line, e.g. "Lead changed how it reviews code". */
  line: string;
  now: string;
  after: string;
  small?: boolean;
  undone?: boolean;
  /** A real change: which Mono's file it rewrote, and the whole file before and after. Undo writes `beforeText` back. */
  monoId?: string;
  file?: AgentFilePath;
  beforeText?: string;
  afterText?: string;
  /** Why the last Undo did nothing (the file moved on since), in plain words. */
  problem?: string;
  /** A Lead retired with its project: Undo restores its folder and roster entry. */
  retired?: RetiredMono;
  /** A Page kept from a Mono's preview: Undo takes it off the Pages list, Redo puts it back. */
  pageId?: string;
  /** An applied Change the hub / Edit Today / Connect data preview: Undo asks the backend to put it back. */
  hubChangeId?: string;
  /** A Mono pinned or unpinned a page: Undo flips it back, Redo flips it again. */
  pin?: { pageId: string; pinned: boolean };
  /**
   * What changes for that Mono, one plain sentence each (soul refresh: one per part of its soul), shown when the row is
   * opened. Never a diff or a file path.
   */
  details?: string[];
  /** Only a note of something a bot left alone on purpose: nothing changed, so there is no Undo. */
  note?: boolean;
  /** What the row reads once undone, as one natural sentence (e.g. "Undone: Hivra lead's soul is back to how it was."). */
  undoneText?: string;
  /** What the Undo button says when "Undo" isn't the plain word for it (a put-back soul's "Keep that change"). */
  undoLabel?: string;
  /** A button that opens a Mono's chat with `text` typed in, not sent (a skipped soul's "Ask Alfred"). */
  ask?: { monoId: string; label: string; text: string };
  /** When it was made (epoch ms), for Today's "Since …" paragraph. Rows from before this was kept have none. */
  at?: number;
  /** A Mono put on a theme (F3): Undo puts `before` back, Redo puts `after` on again. */
  theme?: { before: ThemeLook; after: ThemeLook };
};

/** How the app looks: the active scheme and the tokens it set. */
export type ThemeLook = { schemeId: string; hue: number; saturation: number; lightness: number; opacity: number; accent: string | null };
/** Settings registers how a look is put back, so Undo here doesn't import Settings. */
let themeHook: ((look: ThemeLook) => void) | undefined;
export function setThemeHook(next: (look: ThemeLook) => void): void {
  themeHook = next;
}
/** A Mono applied a theme: a Bot changes row under that Mono. */
export function recordThemeChange(by: string, name: string, before: ThemeLook, after: ThemeLook): void {
  const id = `theme:${after.schemeId}:${Date.now().toString(36)}`;
  list = [{ id, bot: by, day: "Today", line: `${by} changed the theme to “${name}”`, now: "Your theme before", after: `The “${name}” theme`, theme: { before, after }, at: Date.now() }, ...list];
  saveReal();
  changed();
}

type HubChangeHooks = { undo(id: string): Promise<void>; redo(id: string): Promise<void> };
let hubChangeHooks: HubChangeHooks | undefined;
export function setHubChangeHooks(next: HubChangeHooks): void {
  hubChangeHooks = next;
}
/**
 * Change the hub / Edit Today rows come from Ash OS's history when the hub reads it (undefined: no history to read,
 * then the rows kept here are shown). Undo and Redo on them go through the hooks; the next read shows the new state.
 */
let hubChangeSource: (() => BotChange[] | undefined) | undefined;
export function setHubChangeSource(next: () => BotChange[] | undefined): void {
  hubChangeSource = next;
}
/** Why the last Undo or Redo of a record row did nothing, by row id (the record itself has no "problem" field). */
const recordProblems = new Map<string, string>();
function fromRecord(): BotChange[] {
  const rows = hubChangeSource?.();
  return rows ? rows.map((r) => (recordProblems.has(r.id) ? { ...r, problem: recordProblems.get(r.id) } : r)) : [];
}
/** Every row: the record's changes first, then the ones kept here (a kept copy of a record row is left out). */
function all(): BotChange[] {
  const record = fromRecord();
  const ids = new Set(record.map((r) => r.id));
  return [...record, ...list.filter((c) => !ids.has(c.id))];
}
/** An applied hub change: a Bot changes row whose Undo reverts it through the backend. */
export function recordHubChange(id: string, by: string, line: string, after: string): void {
  list = [{ id: `hub:${id}`, bot: by, day: "Today", line, now: "As it was", after, hubChangeId: id, at: Date.now() }, ...list.filter((c) => c.id !== `hub:${id}`)];
  saveReal();
  changed();
}

/**
 * Pages registers how its kept pages come and go, so Undo here doesn't import the Pages store. Each resolves to Ash
 * OS's refusal in plain words, if it refused.
 */
type PageHooks = { remove(pageId: string): Promise<string | undefined>; restore(pageId: string): Promise<string | undefined> };
let pageHooks: PageHooks | undefined;
export function setPageHooks(next: PageHooks): void {
  pageHooks = next;
}
/** A kept Page: a Bot changes row whose Undo takes it away again. */
export function recordPageChange(pageId: string, by: string, title: string): void {
  list = [{ id: `page:${pageId}`, bot: by, day: "Today", line: `${by} added the page “${title}”`, now: "No page", after: `Page “${title}” on your Pages list`, pageId, at: Date.now() }, ...list.filter((c) => c.id !== `page:${pageId}`)];
  saveReal();
  changed();
}

/** Pages registers how a page's pin is set, for Undo and Redo of a Mono's pin (resolving to a refusal, if any). */
type PinHook = (pageId: string, pinned: boolean) => Promise<string | undefined>;
let pinHook: PinHook | undefined;
export function setPinHook(next: PinHook): void {
  pinHook = next;
}
/** A Mono pinned or unpinned a page: a Bot changes row under that Mono. */
export function recordPinChange(pageId: string, by: string, title: string, pinned: boolean): void {
  const id = `pin:${pageId}:${Date.now().toString(36)}`;
  list = [{ id, bot: by, day: "Today", line: `${by} ${pinned ? "pinned" : "unpinned"} the page “${title}”`, now: pinned ? "Not pinned" : "Pinned", after: pinned ? "Pinned in the sidebar" : "Not pinned", pin: { pageId, pinned }, at: Date.now() }, ...list];
  saveReal();
  changed();
}

/** Undo all from one Mono: every change of theirs that isn't undone yet. */
export async function undoAllFrom(bot: string): Promise<void> {
  await undoBotChange(all().filter((c) => c.bot === bot && !c.undone && !c.note).map((c) => c.id));
}

/** The door to a Mono's own files (SOUL.md = its rules). Tests and proofs swap it. */
export type BotFiles = {
  read(monoId: string, file: AgentFilePath): Promise<{ text: string | null; hash: string }>;
  write(monoId: string, file: AgentFilePath, text: string, expectedHash: string): Promise<string>;
};
let files: BotFiles = { read: readAgentFile, write: writeAgentFile };
export function setBotFiles(next: BotFiles): void {
  files = next;
}

const KEY = "monocode:hub-bot-changes";
function loadReal(): BotChange[] {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as BotChange[]).filter((c) => c && ((c.monoId && c.file) || c.retired || c.pageId || c.hubChangeId || c.pin || c.theme || (c.note && c.monoId)));
  } catch {
    return [];
  }
}
function saveReal(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.filter((c) => (c.monoId && c.file) || c.retired || c.pageId || c.hubChangeId || c.pin || c.theme || (c.note && c.monoId))));
  } catch {
    /* best effort */
  }
}

let list: BotChange[] = [...loadReal(), ...examples<BotChange>([
  { id: "bc1", bot: "Projects Manager", day: "Today", line: "Example: Projects Manager changed how it reviews code",
    now: "Reviews every change line by line before it merges.", after: "Reviews the risky files closely; skims renames and formatting." },
  { id: "bc2", bot: "Chief of Staff", day: "Today", line: "Example: Chief of Staff changed when it writes the daily summary",
    now: "Writes the summary at 6pm.", after: "Writes the summary when the last job of the day finishes." },
  { id: "bc3", bot: "frank", day: "Today", small: true, line: "fixed a typo in the release-notes skill", now: "“relase notes”", after: "“release notes”" },
  { id: "bc4", bot: "frank", day: "Today", small: true, line: "shortened the bug-report skill", now: "12 steps", after: "8 steps" },
  { id: "bc5", bot: "frank", day: "Today", small: true, line: "renamed a skill to ‘tidy-imports’", now: "cleanup-2", after: "tidy-imports" },
  { id: "bc6", bot: "frank", day: "Today", small: true, line: "updated a link in the setup skill", now: "old docs link", after: "new docs link" },
  { id: "bc7", bot: "Alfred", day: "Yesterday", line: "Example: Alfred changed how it files your receipts",
    now: "One folder per month.", after: "One folder per project, then per month." },
])];

let version = 0;
const subs = new Set<() => void>();
const changed = () => { version++; subs.forEach((f) => f()); };
/** The changes made since `ms` that still stand (not undone, not a note): Today's "Since …" paragraph names them. */
export function botChangesSince(ms: number): BotChange[] {
  return all().filter((c) => !c.undone && !c.note && typeof c.at === "number" && c.at >= ms);
}

export function useBotChangesVersion(): number {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
}

export type BotChangeRow =
  | { kind: "one"; change: BotChange }
  | { kind: "bundle"; id: string; bot: string; day: string; line: string; items: BotChange[] };

/** Rows to show: big changes one by one, small ones bundled per bot per day. */
export function botChangeRows(): BotChangeRow[] {
  const rows: BotChangeRow[] = [];
  const bundles = new Map<string, BotChange[]>();
  for (const c of all()) {
    if (!c.small) { rows.push({ kind: "one", change: c }); continue; }
    const k = `${c.bot}|${c.day}`;
    if (!bundles.has(k)) {
      bundles.set(k, []);
      rows.push({ kind: "bundle", id: k, bot: c.bot, day: c.day, line: "", items: [] });
    }
    bundles.get(k)!.push(c);
  }
  return rows.map((r) => {
    if (r.kind !== "bundle") return r;
    const items = bundles.get(r.id)!;
    return { ...r, items, line: `Example: ${r.bot} tidied ${items.length} skill${items.length === 1 ? "" : "s"}` };
  });
}

/** A bot rewrote one of its own files: the row Ash sees, with what it can put back. Kept across restarts. */
export function recordBotChange(change: Omit<BotChange, "undone" | "problem"> & Required<Pick<BotChange, "monoId" | "file" | "beforeText" | "afterText">>): void {
  list = [{ ...change, at: change.at ?? Date.now() }, ...list.filter((c) => c.id !== change.id)];
  saveReal();
  changed();
}

/** Something a bot left alone on purpose, said in plain words: a row with no Undo (there is nothing to put back). */
export function recordBotNote(note: Pick<BotChange, "id" | "bot" | "line" | "now" | "after" | "details" | "monoId" | "ask">): void {
  list = [{ ...note, day: "Today", note: true }, ...list.filter((c) => c.id !== note.id)];
  saveReal();
  changed();
}

/** A change kept here, by id (a fix checks whether Ash undid it, so it isn't made again). */
export function findBotChange(id: string): BotChange | undefined {
  return list.find((c) => c.id === id);
}

/** A Lead was retired (with "Retire <Project> Lead too"): a Bot changes row whose Undo brings it back. */
export function recordRetirement(r: RetiredMono, projectName: string): string {
  const name = r.mono.name ?? r.mono.id;
  const id = `retire:${r.mono.id}:${r.at}`;
  list = [{ id, bot: name, day: "Today", line: `${name} was retired with ${projectName}`, now: "Active", after: "Retired, its chats and memory archived", monoId: r.mono.id, retired: r }, ...list];
  saveReal();
  changed();
  return id;
}

/**
 * Undo puts the bot's file back the way it was, for real: only when the file still reads what the change left
 * (otherwise nothing is touched and the row says why), saved over the hash it was read at, then read back. The row
 * stays, marked undone. Example rows (no file) only mark themselves undone.
 */
export async function undoBotChange(ids: string[]): Promise<void> {
  const record = new Map(fromRecord().map((r) => [r.id, r]));
  for (const id of ids) {
    const r = record.get(id);
    if (r) {
      if (!r.undone) await recordStep(r, "undo");
      continue;
    }
    const c = list.find((x) => x.id === id);
    if (!c || c.undone || c.note) continue;
    let next: BotChange = { ...c, undone: true, problem: undefined };
    if (c.hubChangeId) {
      try {
        if (!hubChangeHooks) throw new Error("Not connected yet, so nothing was undone.");
        await hubChangeHooks.undo(c.hubChangeId);
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Undo didn't go through." };
      }
    } else if (c.theme) {
      if (themeHook) themeHook(c.theme.before);
      else next = { ...c, problem: "Settings hasn't opened yet, so nothing changed. Try again in a moment." };
    } else if (c.pin) {
      const refused = pinHook ? await pinHook(c.pin.pageId, !c.pin.pinned) : "Pages isn't open yet, so nothing was undone.";
      if (refused) next = { ...c, problem: refused };
    } else if (c.pageId) {
      const refused = pageHooks ? await pageHooks.remove(c.pageId) : "Pages isn't open yet, so nothing was undone.";
      if (refused) next = { ...c, problem: refused };
    } else if (c.retired) {
      try {
        await restoreRetiredMono(c.retired);
      } catch (e) {
        next = { ...c, problem: typeof e === "string" ? e : e instanceof Error ? e.message : "That Undo didn't go through." };
      }
    } else if (c.monoId && c.file && c.beforeText !== undefined) {
      try {
        const now = await files.read(c.monoId, c.file);
        if ((now.text ?? "") !== (c.afterText ?? "")) {
          next = { ...c, problem: `${c.bot} changed this again since, so nothing was undone.` };
        } else {
          await files.write(c.monoId, c.file, c.beforeText, now.hash);
          const back = await files.read(c.monoId, c.file);
          if ((back.text ?? "") !== c.beforeText) next = { ...c, problem: "The file didn't go back. Nothing is marked undone." };
        }
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Undo didn't go through." };
      }
    }
    list = list.map((x) => (x.id === id ? next : x));
  }
  saveReal();
  changed();
}

/** Undo or Redo a change Ash OS keeps: through the hooks; the record's next read shows the new state. */
async function recordStep(r: BotChange, step: "undo" | "redo"): Promise<void> {
  try {
    if (!hubChangeHooks || !r.hubChangeId) throw new Error(`Not connected yet, so nothing was ${step === "undo" ? "undone" : "redone"}.`);
    await hubChangeHooks[step](r.hubChangeId);
    recordProblems.delete(r.id);
  } catch (e) {
    recordProblems.set(r.id, e instanceof Error ? e.message : `That ${step === "undo" ? "Undo" : "Redo"} didn't go through.`);
  }
  changed();
}

/** "Back to 12 steps (was 8 steps)": what an undone change reads like. */
export function undoneLine(c: Pick<BotChange, "now" | "after" | "undoneText">): string {
  if (c.undoneText) return c.undoneText;
  return /^as it was$/i.test(c.now.trim()) ? "Undone: back to how it was." : `Undone: back to \u201c${c.now.trim()}\u201d.`;
}

/**
 * Redo puts the change back, for real: only when the file still reads what Undo left (the old rules), saved over the
 * hash it was read at, then read back. The row is no longer undone.
 */
export async function redoBotChange(ids: string[]): Promise<void> {
  const record = new Map(fromRecord().map((r) => [r.id, r]));
  for (const id of ids) {
    const r = record.get(id);
    if (r) {
      if (r.undone) await recordStep(r, "redo");
      continue;
    }
    const c = list.find((x) => x.id === id);
    if (!c || !c.undone) continue;
    let next: BotChange = { ...c, undone: false, problem: undefined };
    if (c.hubChangeId) {
      try {
        if (!hubChangeHooks) throw new Error("Not connected yet, so nothing was redone.");
        await hubChangeHooks.redo(c.hubChangeId);
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Redo didn't go through." };
      }
    } else if (c.theme) {
      if (themeHook) themeHook(c.theme.after);
      else next = { ...c, problem: "Settings hasn't opened yet, so nothing changed. Try again in a moment." };
    } else if (c.pin) {
      const refused = pinHook ? await pinHook(c.pin.pageId, c.pin.pinned) : "Pages isn't open yet, so nothing was redone.";
      if (refused) next = { ...c, problem: refused };
    } else if (c.pageId) {
      const refused = pageHooks ? await pageHooks.restore(c.pageId) : "Pages isn't open yet, so nothing was redone.";
      if (refused) next = { ...c, problem: refused };
    } else if (c.retired) {
      try {
        const again = await retireMono(c.retired.mono.id);
        if (again) next = { ...next, retired: again };
      } catch (e) {
        next = { ...c, problem: typeof e === "string" ? e : e instanceof Error ? e.message : "That Redo didn't go through." };
      }
    } else if (c.monoId && c.file && c.afterText !== undefined) {
      try {
        const now = await files.read(c.monoId, c.file);
        if ((now.text ?? "") !== (c.beforeText ?? "")) {
          next = { ...c, problem: `${c.bot}'s file changed since the Undo, so nothing was redone.` };
        } else {
          await files.write(c.monoId, c.file, c.afterText, now.hash);
          const back = await files.read(c.monoId, c.file);
          if ((back.text ?? "") !== c.afterText) next = { ...c, problem: "The change didn't go back in. Nothing was redone." };
        }
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Redo didn't go through." };
      }
    }
    list = list.map((x) => (x.id === id ? next : x));
  }
  saveReal();
  changed();
}
