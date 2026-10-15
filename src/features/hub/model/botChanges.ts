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
};

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
    return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as BotChange[]).filter((c) => c && ((c.monoId && c.file) || c.retired));
  } catch {
    return [];
  }
}
function saveReal(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.filter((c) => (c.monoId && c.file) || c.retired)));
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
  for (const c of list) {
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
  list = [change, ...list.filter((c) => c.id !== change.id)];
  saveReal();
  changed();
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
  for (const id of ids) {
    const c = list.find((x) => x.id === id);
    if (!c || c.undone) continue;
    let next: BotChange = { ...c, undone: true, problem: undefined };
    if (c.retired) {
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

/** "Back to 12 steps (was 8 steps)": what an undone change reads like. */
export function undoneLine(c: Pick<BotChange, "now" | "after">): string {
  return `Back to ${c.now} (was ${c.after})`;
}

/**
 * Redo puts the change back, for real: only when the file still reads what Undo left (the old rules), saved over the
 * hash it was read at, then read back. The row is no longer undone.
 */
export async function redoBotChange(ids: string[]): Promise<void> {
  for (const id of ids) {
    const c = list.find((x) => x.id === id);
    if (!c || !c.undone) continue;
    let next: BotChange = { ...c, undone: false, problem: undefined };
    if (c.retired) {
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
