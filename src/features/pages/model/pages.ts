import { useSyncExternalStore } from "react";
import { recordPageChange, setPageHooks } from "../../hub/model/botChanges";

/**
 * Pages: a Mono builds a page for you from ready-made blocks. For now the request is matched locally to a block
 * layout (no model call), and every block shows Example data. Kept pages are saved; Undo lives in Bot changes.
 */
export type BlockKind = "status" | "list" | "chart" | "note" | "calendar";
export type PageBlock =
  | { kind: "status"; title: string; state: "ok" | "warn" | "bad"; line: string; detail: string }
  | { kind: "list"; title: string; rows: { text: string; state: "ok" | "warn" | "bad"; label: string }[] }
  | { kind: "chart"; title: string; bars: { label: string; value: number }[] }
  | { kind: "note"; title: string; text: string }
  | { kind: "calendar"; title: string; month: string; firstWeekday: number; days: number; marked: { day: number; text: string }[] };

export type Page = { id: string; title: string; request: string; by: string; blocks: PageBlock[]; keptAt?: number; removed?: boolean };

type Topic = { words: RegExp; title: string; list: string; rows: [string, "ok" | "warn" | "bad", string][]; chart: string; status: [string, string]; note: string; order: BlockKind[] };
const TOPICS: Topic[] = [
  { words: /bug|issue|crash|fix/i, title: "Bugs and fixes", list: "Open bugs",
    rows: [["Shader step fails on Intel Macs", "bad", "Open"], ["Jump clips through the ledge", "bad", "Open"], ["Sound drops after pause", "ok", "Fixed"], ["Save slot shows wrong date", "ok", "Fixed"]],
    chart: "Bugs fixed per day", status: ["2 bugs still open", "Oldest opened 3 days ago"], note: "Fix the shader step first: it blocks the playtest build.", order: ["status", "list", "chart", "calendar", "note"] },
  { words: /calendar|schedule|meeting|week|plan/i, title: "This week", list: "Coming up",
    rows: [["Playtest with five kids", "warn", "Thursday"], ["Pricing review", "ok", "Friday"], ["Ship build 0.14", "warn", "Monday"]],
    chart: "Hours booked per day", status: ["Week on track", "3 things booked, nothing overdue"], note: "Keep Friday afternoon clear for the release check.", order: ["calendar", "list", "status", "chart", "note"] },
  { words: /sale|revenue|money|sign ?up|growth|user/i, title: "Sign-ups and sales", list: "Latest sign-ups",
    rows: [["Waitlist: 42 new", "ok", "Today"], ["Trial to paid: 3", "ok", "This week"], ["Refund asked: 1", "warn", "Open"]],
    chart: "Sign-ups per day", status: ["Sign-ups up this week", "212 so far, 38 more than last week"], note: "The new headline is doing better. Keep it for another week.", order: ["status", "chart", "list", "note", "calendar"] },
];
const GENERAL: Topic = { words: /.*/, title: "Overview", list: "Things to watch",
  rows: [["Nightly backup", "ok", "Done"], ["Build 0.14", "warn", "Waiting"], ["Shader step", "bad", "Stuck"]],
  chart: "Builds per day", status: ["Mostly on track", "One thing is stuck"], note: "Ask the Mono to change any block: add, remove, or reorder.", order: ["status", "list", "chart", "note", "calendar"] };

/** "dashboard for EXO bugs" → a page title. */
function titleFor(request: string, topic: Topic): string {
  const proj = request.match(/\b(EXO|Hivra|Nibbii|Hub)\b/i)?.[1];
  return proj ? `${proj[0].toUpperCase()}${proj.slice(1)} · ${topic.title}` : topic.title;
}

/** Match a request to a block layout, locally. Every page gets all five blocks, ordered by what was asked. */
export function buildPreview(request: string, by: string, now = Date.now()): Page {
  const topic = TOPICS.find((t) => t.words.test(request)) ?? GENERAL;
  const blocks: Record<BlockKind, PageBlock> = {
    status: { kind: "status", title: "Status", state: topic.rows.some((r) => r[1] === "bad") ? "bad" : topic.rows.some((r) => r[1] === "warn") ? "warn" : "ok", line: topic.status[0], detail: topic.status[1] },
    list: { kind: "list", title: topic.list, rows: topic.rows.map(([text, state, label]) => ({ text, state, label })) },
    chart: { kind: "chart", title: topic.chart, bars: [["Mon", 2], ["Tue", 4], ["Wed", 3], ["Thu", 5], ["Fri", 1]].map(([label, value]) => ({ label: label as string, value: value as number })) },
    note: { kind: "note", title: "Note", text: topic.note },
    calendar: { kind: "calendar", title: "Calendar", month: "October 2026", firstWeekday: 3, days: 31, marked: [{ day: 15, text: "Today" }, { day: 16, text: "Playtest" }, { day: 19, text: "Ship" }] },
  };
  return { id: `page-${now.toString(36)}`, title: titleFor(request, topic), request, by, blocks: topic.order.map((k) => blocks[k]) };
}

// ---- kept pages -------------------------------------------------------------------------------------------------------
const KEY = "monocode:pages";
function load(): Page[] {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as Page[]).filter((p) => p && p.id && Array.isArray(p.blocks));
  } catch {
    return [];
  }
}
let pages: Page[] = load();
let version = 0;
const subs = new Set<() => void>();
function changed() {
  try {
    localStorage.setItem(KEY, JSON.stringify(pages));
  } catch {
    /* best effort */
  }
  version++;
  subs.forEach((f) => f());
}
export function usePagesVersion(): number {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
}
export function keptPages(): Page[] {
  return pages.filter((p) => !p.removed).sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0));
}
export function keepPage(page: Page, now = Date.now()): void {
  pages = [{ ...page, keptAt: now, removed: false }, ...pages.filter((p) => p.id !== page.id)];
  changed();
  recordPageChange(page.id, page.by, page.title);
}
function setRemoved(id: string, removed: boolean) {
  pages = pages.map((p) => (p.id === id ? { ...p, removed } : p));
  changed();
}
setPageHooks({ remove: (id) => setRemoved(id, true), restore: (id) => setRemoved(id, false) });
/** Tests only. */
export function resetPagesForTest(): void {
  pages = [];
  changed();
}
