import { useSyncExternalStore } from "react";
import { examples } from "./examples";
import { readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { restoreRetiredMono, retireMono, type RetiredMono } from "../../monos/model/monoArchive";
import { listMonos } from "../../monos/model/mono";
import { restoreTeam, retireTeam, type Team } from "./hubTeams";

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
   * A page changed something in the hub (today: a project's name): Undo runs the same action with `before`, Redo with
   * `after`, so the write goes through the hub's real store both ways.
   */
  write?: { action: string; payload: Record<string, unknown>; before: Record<string, unknown>; after: Record<string, unknown> };
  /** A page was connected to, or disconnected from, a web source: Undo flips it back, Redo flips it again. */
  source?: { pageId: string; url: string; connected: boolean };
  /** One applied part of an offered change (selfBuild/model/changeFlow.ts): its kind's code undoes and redoes it. */
  flow?: { kind: string; data: unknown; undone?: unknown };
  /** A Mono made from a chat with Ash (step 13): Undo retires it (archived, not deleted), Redo brings it back. */
  made?: { monoId: string; retired?: RetiredMono };
  /** A team made from a chat with Ash (A6): Undo takes the team and its room away, Redo brings them back. */
  madeTeam?: { team: Team };
  /**
   * What changes for that Mono, one plain sentence each (soul refresh: one per part of its soul), shown when the row is
   * opened. Never a diff or a file path.
   */
  details?: string[];
  /** Only a note of something a bot left alone on purpose: nothing changed, so there is no Undo. */
  note?: boolean;
  /** The app itself did this (harness self-repair): it belongs to no Mono, so it has no Ask and no Mono to name. */
  system?: boolean;
  /** What the row reads once undone, as one natural sentence (e.g. "Undone: Hivra lead's soul is back to how it was."). */
  undoneText?: string;
  /** What the Undo button says when "Undo" isn't the plain word for it (a put-back soul's "Keep that change"). */
  undoLabel?: string;
  /** A button that opens a Mono's chat with `text` typed in, not sent (a skipped soul's "Ask Alfred"). */
  ask?: { monoId: string; label: string; text: string };
  /** When it was made (epoch ms), for Today's "Since …" paragraph. Rows from before this was kept have none. */
  at?: number;
};

/**
 * How the app looks: the active scheme and the tokens it set. `themeId` is which of the scheme's themes was on, and
 * `mode` whether the app was showing its dark or light colours, so Undo can put both back.
 */
export type ThemeLook = {
  schemeId: string;
  hue: number;
  saturation: number;
  lightness: number;
  opacity: number;
  accent: string | null;
  themeId?: string;
  mode?: "dark" | "light";
};
/** A scheme a Mono's theme file added, so Undo can take it off the list again and Redo put it back. */
export type AddedThemeScheme = { id: string; name: string } & Record<string, unknown>;
/**
 * A Mono applied a theme: a Bot changes row under that Mono, naming the theme it replaced. It is a "theme" change kind
 * (themeImport.ts registers it with changeFlow.ts), so Undo puts `before` back and Redo puts `after` on again.
 */
export function recordThemeChange(
  by: string,
  name: string,
  before: ThemeLook,
  after: ThemeLook,
  beforeName: string,
  added?: AddedThemeScheme,
): string {
  return recordFlowChange({
    kind: "theme",
    by,
    title: `“${name}”`,
    data: { before, after, ...(added ? { added } : {}) },
    line: `${by} changed the theme from ${beforeName} to “${name}”`,
    now: beforeName,
    undoneText: `Undone: back to ${beforeName}.`,
  });
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
  list = [{ id: `page:${pageId}`, bot: by, day: "Today", line: `${by} added the hub “${title}”`, now: "No hub", after: `Hub “${title}” on your Hubs list`, pageId, at: Date.now() }, ...list.filter((c) => c.id !== `page:${pageId}`)];
  saveReal();
  changed();
}

/** How an offered change's part is undone and redone (changeFlow.ts registers it; no import back). */
type FlowHooks = { undo(kind: string, data: unknown): Promise<unknown>; redo(kind: string, data: unknown, undone: unknown): Promise<void> };
let flowHooks: FlowHooks | undefined;
export function setFlowHooks(next: FlowHooks): void {
  flowHooks = next;
}
/** One applied part of an offered change: a Bot changes row with its own Undo. Returns the row's id. */
export function recordFlowChange(part: {
  kind: string;
  by: string;
  title: string;
  data: unknown;
  /** The row's own words, when "<bot> changed the hub: <title>" / "As it was" aren't the plain ones. */
  line?: string;
  now?: string;
  undoneText?: string;
}): string {
  const id = `flow:${part.kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
  const row: BotChange = {
    id,
    bot: part.by,
    day: "Today",
    line: part.line ?? `${part.by} changed the app: ${part.title}`,
    now: part.now ?? "As it was",
    after: part.title,
    ...(part.undoneText ? { undoneText: part.undoneText } : {}),
    flow: { kind: part.kind, data: part.data },
    at: Date.now(),
  };
  list = [row, ...list];
  saveReal();
  changed();
  return id;
}
/** The applied parts of offered changes, newest first (a Mono undoes one by its title). */
export function flowChanges(kind?: string): BotChange[] {
  return list.filter((c) => c.flow && (!kind || c.flow.kind === kind));
}
/** A Mono made a new Mono from a chat with Ash: a plain row whose Undo retires it again. */
export function recordMadeMono(monoId: string, by: string, name: string, role?: string): string {
  const id = `made:${monoId}`;
  list = [{ id, bot: by, day: "Today", line: `${by} made a new Mono, ${name}${role ? ` (${role})` : ""}`, now: "Not there", after: `${name} in your Monos`, undoneText: `Undone: ${name} is retired, its soul and memory archived.`, made: { monoId }, at: Date.now() }, ...list.filter((c) => c.id !== id)];
  saveReal();
  changed();
  return id;
}

/** A Mono made a team from a chat with Ash (A6): a plain row whose Undo takes the team and its room away. */
export function recordMadeTeam(team: Team, by: string): string {
  const id = `made-team:${team.id}`;
  const n = team.memberIds.length;
  list = [{ id, bot: by, day: "Today", line: `${by} made a new team, ${team.name}${n ? ` (${n} Mono${n === 1 ? "" : "s"})` : ""}`, now: "Not there", after: `${team.name} in your teams, with its room`, undoneText: `Undone: the ${team.name} team and its room are gone. Its Monos stay.`, madeTeam: { team }, at: Date.now() }, ...list.filter((c) => c.id !== id)];
  saveReal();
  changed();
  return id;
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
  list = [{ id, bot: by, day: "Today", line: `${by} ${pinned ? "pinned" : "unpinned"} the hub “${title}”`, now: pinned ? "Not pinned" : "Pinned", after: pinned ? "Pinned in the sidebar" : "Not pinned", pin: { pageId, pinned }, at: Date.now() }, ...list];
  saveReal();
  changed();
}

/** Pages registers how a page writes to the hub, so Undo here doesn't import the Pages store. */
type WriteHook = (action: string, payload: Record<string, unknown>) => Promise<void>;
let writeHook: WriteHook | undefined;
export function setWriteHook(next: WriteHook): void {
  writeHook = next;
}
/**
 * A page wrote to the hub through its bridge (pageWrites.ts): a Bot changes row whose Undo runs the same action with
 * `before` and whose Redo runs it with `after`. It carries no `pageId`: that field means "a kept page", and Undo on it
 * takes the page away.
 */
export function recordPageWrite(part: {
  by: string;
  line: string;
  now: string;
  after: string;
  undoneText: string;
  write: NonNullable<BotChange["write"]>;
}): string {
  const id = `page-write:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
  list = [{ id, bot: part.by, day: "Today", line: part.line, now: part.now, after: part.after, undoneText: part.undoneText, write: part.write, at: Date.now() }, ...list];
  saveReal();
  changed();
  return id;
}

/** Pages registers how a source is connected and disconnected, for Undo and Redo (resolving to a refusal, if any). */
type SourceHook = (pageId: string, url: string, connected: boolean) => Promise<string | undefined>;
let sourceHook: SourceHook | undefined;
export function setSourceHook(next: SourceHook): void {
  sourceHook = next;
}
/** A page was connected to, or disconnected from, a web source: a Bot changes row under the page's title. */
export function recordPageSource(part: { by: string; pageId: string; url: string; connected: boolean }): string {
  let host = part.url;
  try {
    host = new URL(part.url).host;
  } catch {
    /* the caller already checked the address; a row still gets written */
  }
  const id = `page-source:${part.pageId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
  list = [{
    id,
    bot: part.by,
    day: "Today",
    line: `The hub “${part.by}” ${part.connected ? `can now read ${host}` : `can't read ${host} any more`}`,
    now: part.connected ? "Not connected" : `Connected to ${host}`,
    after: part.connected ? `Connected to ${host}` : "Not connected",
    undoneText: part.connected ? `Undone: the hub can't reach ${host} any more.` : `Undone: the hub can reach ${host} again.`,
    source: { pageId: part.pageId, url: part.url, connected: part.connected },
    at: Date.now(),
  }, ...list];
  saveReal();
  changed();
  return id;
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
    return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as BotChange[]).filter((c) => c && kept(c));
  } catch {
    return [];
  }
}
/** The rows worth keeping across restarts: a real change with something to put back, or a note's own words. */
const kept = (c: BotChange) =>
  !!((c.monoId && c.file) || c.retired || c.pageId || c.hubChangeId || c.pin || c.flow || c.made || c.madeTeam || c.write || c.source || (c.note && (c.monoId || c.system)));
function saveReal(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.filter(kept)));
  } catch {
    /* best effort */
  }
}

let list: BotChange[] = [...loadReal(), ...examples<BotChange>([
  { id: "bc1", bot: "Projects Manager", day: "Today", line: "Example: Projects Manager changed how it reviews code",
    now: "Reviews every change line by line before it merges.", after: "Reviews the risky files closely; skims renames and formatting." },
  { id: "bc2", bot: "Chief of Staff", day: "Today", line: "Example: Chief of Staff changed when it writes the daily summary",
    now: "Writes the summary at 6pm.", after: "Writes the summary when the last job of the day finishes." },
  { id: "bc3", bot: "ed", day: "Today", small: true, line: "Example: fixed a typo in the release-notes skill", now: "“relase notes”", after: "“release notes”" },
  { id: "bc4", bot: "ed", day: "Today", small: true, line: "Example: shortened the bug-report skill", now: "12 steps", after: "8 steps" },
  { id: "bc5", bot: "ed", day: "Today", small: true, line: "Example: renamed a skill to ‘tidy-imports’", now: "cleanup-2", after: "tidy-imports" },
  { id: "bc6", bot: "ed", day: "Today", small: true, line: "Example: updated a link in the setup skill", now: "old docs link", after: "new docs link" },
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

/**
 * r67 (Alfred's r66 rechecks: "Postie changed its soul" for a retired Mono): the Monos that are retired now, from the
 * rows that retired them (a retirement still standing, or an undone "made a new Mono") and from the roster itself.
 */
export function retiredMonoIds(changes: readonly BotChange[] = all(), roster: readonly string[] = listMonos().map((m) => m.id)): Set<string> {
  const out = new Set<string>();
  for (const c of changes) {
    if (c.retired && !c.undone) out.add(c.retired.mono.id);
    if (c.made && c.undone) out.add(c.made.monoId);
  }
  const live = new Set(roster);
  if (live.size) for (const c of changes) if (c.monoId && c.file && !live.has(c.monoId)) out.add(c.monoId);
  for (const id of live) if (!changes.some((c) => (c.retired?.mono.id === id && !c.undone) || (c.made?.monoId === id && c.undone))) out.delete(id);
  return out;
}

/** A change to a retired Mono's own files: nothing to show or put back while it is retired (its archive keeps them). */
const toRetired = (c: BotChange, retired: ReadonlySet<string>) => !!c.monoId && !!c.file && retired.has(c.monoId) && !c.retired && !c.made;

/** Rows to show: big changes one by one, small ones bundled per bot per day. */
export function botChangeRows(): BotChangeRow[] {
  const rows: BotChangeRow[] = [];
  const bundles = new Map<string, BotChange[]>();
  const retired = retiredMonoIds();
  for (const c of all()) {
    if (toRetired(c, retired)) continue;
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
export function recordBotNote(note: Pick<BotChange, "id" | "bot" | "line" | "now" | "after" | "details" | "monoId" | "ask" | "system">): void {
  list = [{ ...note, day: "Today", note: true }, ...list.filter((c) => c.id !== note.id)];
  saveReal();
  changed();
}

/**
 * A Mono wrote one of its own files during a run: its soul, its memory, one of its skills. It is a real change, so it
 * gets a row like any other, and Undo puts the file back (D1). One row per Mono, file and run: a run that edits the
 * same file again folds into the row it already has, which therefore holds the file as it was before that run touched
 * it. A fold needs the file to still read what that row left. A write from somewhere else in between (the Mono's own
 * shell command) leaves that row alone and records a new one beside it, so the state it holds is never lost; an Undo
 * puts the file back where the row began, so the run's next write can take the row over. A run that leaves a file where
 * it started (a fact added, then removed) leaves no row: nothing changed in the end, so there is nothing to undo.
 */
export function recordSelfWrite(write: {
  monoId: string;
  bot: string;
  file: AgentFilePath;
  line: string;
  details?: string[];
  before: string;
  after: string;
  run: string;
}): void {
  if (write.before === write.after) return;
  const base = `self-write:${write.monoId}:${write.file}:${write.run}`;
  // This run's rows for this file, newest first.
  const mine = list.filter((c) => c.id === base || c.id.startsWith(`${base}:`));
  const last = mine[0];
  const fold = !!last && !last.undone && !last.problem && last.afterText === write.before;
  const beforeText = fold ? (last.beforeText ?? write.before) : write.before;
  // The run's writes came back to where they started (a fact added and then removed): nothing changed in the end.
  if (beforeText === write.after) {
    if (fold && last) {
      list = list.filter((c) => c.id !== last.id);
      saveReal();
      changed();
    }
    return;
  }
  // The row may take the write only when it folds into it, or when an Undo already put the file back where the row
  // began (so nothing recorded is lost). Anything else takes a new id, beside the earlier row rather than over it.
  let id = base;
  if (!fold && last && !last.undone) {
    let n = 1;
    while (list.some((c) => c.id === `${base}:${n}`)) n++;
    id = `${base}:${n}`;
  }
  recordBotChange({
    id,
    bot: write.bot,
    day: "Today",
    line: write.line,
    now: "Its file as it was",
    after: "Its file as it is now",
    ...(write.details?.length ? { details: write.details } : {}),
    undoneText: `Undone: ${write.bot}'s file is back to how it was before it changed it.`,
    monoId: write.monoId,
    file: write.file,
    beforeText,
    afterText: write.after,
  });
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

/** r66: Chief of Staff retired a Mono from the chat, on Ash's yes: a Bot changes row whose Undo brings it back whole. */
export function recordChatRetirement(r: RetiredMono, by: string): string {
  const name = r.mono.name ?? r.mono.id;
  const id = `retire:${r.mono.id}:${r.at}`;
  list = [{ id, bot: by, day: "Today", line: `${by} retired ${name}`, now: "Active", after: "Retired, its chats and memory archived", undoneText: `Undone: ${name} is back in your Monos.`, monoId: r.mono.id, retired: r, at: Date.now() }, ...list];
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
    if (c.flow) {
      try {
        if (!flowHooks) throw new Error("Not connected yet, so nothing was undone.");
        next = { ...next, flow: { ...c.flow, undone: await flowHooks.undo(c.flow.kind, c.flow.data) } };
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Undo didn't go through." };
      }
    } else if (c.made) {
      try {
        const retired = await retireMono(c.made.monoId);
        if (!retired) throw new Error("That Mono is already gone.");
        next = { ...next, made: { ...c.made, retired } };
      } catch (e) {
        next = { ...c, problem: typeof e === "string" ? e : e instanceof Error ? e.message : "That Undo didn't go through." };
      }
    } else if (c.madeTeam) {
      try {
        const gone = retireTeam(c.madeTeam.team.id);
        if (!gone) throw new Error("That team is already gone.");
        next = { ...next, madeTeam: { team: gone } };
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Undo didn't go through." };
      }
    } else if (c.hubChangeId) {
      try {
        if (!hubChangeHooks) throw new Error("Not connected yet, so nothing was undone.");
        await hubChangeHooks.undo(c.hubChangeId);
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Undo didn't go through." };
      }
    } else if (c.write) {
      try {
        if (!writeHook) throw new Error("Not connected yet, so nothing was undone.");
        await writeHook(c.write.action, { ...c.write.payload, ...c.write.before });
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Undo didn't go through." };
      }
    } else if (c.source) {
      const refused = sourceHook ? await sourceHook(c.source.pageId, c.source.url, !c.source.connected) : "Hubs isn't open yet, so nothing was undone.";
      if (refused) next = { ...c, problem: refused };
    } else if (c.pin) {
      const refused = pinHook ? await pinHook(c.pin.pageId, !c.pin.pinned) : "Hubs isn't open yet, so nothing was undone.";
      if (refused) next = { ...c, problem: refused };
    } else if (c.pageId) {
      const refused = pageHooks ? await pageHooks.remove(c.pageId) : "Hubs isn't open yet, so nothing was undone.";
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
    if (c.flow) {
      try {
        if (!flowHooks) throw new Error("Not connected yet, so nothing was redone.");
        await flowHooks.redo(c.flow.kind, c.flow.data, c.flow.undone);
        next = { ...next, flow: { kind: c.flow.kind, data: c.flow.data } };
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Redo didn't go through." };
      }
    } else if (c.made) {
      try {
        if (!c.made.retired) throw new Error("Nothing to bring back.");
        await restoreRetiredMono(c.made.retired);
        next = { ...next, made: { monoId: c.made.monoId } };
      } catch (e) {
        next = { ...c, problem: typeof e === "string" ? e : e instanceof Error ? e.message : "That Redo didn't go through." };
      }
    } else if (c.madeTeam) {
      try {
        next = { ...next, madeTeam: { team: restoreTeam(c.madeTeam.team) } };
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Redo didn't go through." };
      }
    } else if (c.hubChangeId) {
      try {
        if (!hubChangeHooks) throw new Error("Not connected yet, so nothing was redone.");
        await hubChangeHooks.redo(c.hubChangeId);
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Redo didn't go through." };
      }
    } else if (c.write) {
      try {
        if (!writeHook) throw new Error("Not connected yet, so nothing was redone.");
        await writeHook(c.write.action, { ...c.write.payload, ...c.write.after });
      } catch (e) {
        next = { ...c, problem: e instanceof Error ? e.message : "That Redo didn't go through." };
      }
    } else if (c.source) {
      const refused = sourceHook ? await sourceHook(c.source.pageId, c.source.url, c.source.connected) : "Hubs isn't open yet, so nothing was redone.";
      if (refused) next = { ...c, problem: refused };
    } else if (c.pin) {
      const refused = pinHook ? await pinHook(c.pin.pageId, c.pin.pinned) : "Hubs isn't open yet, so nothing was redone.";
      if (refused) next = { ...c, problem: refused };
    } else if (c.pageId) {
      const refused = pageHooks ? await pageHooks.restore(c.pageId) : "Hubs isn't open yet, so nothing was redone.";
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
