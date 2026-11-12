// monoTree: a Mono's chat as an append-only log with a summary tree over it.
//
// A faithful port of UniiChat's Memory.ts (github.com/VictorTaelin/UniiChat @ 0500bf6,
// Apache-2.0, Copyright 2026 Higher Order Company). Same sizes, same files, same
// view and merge order, same compaction tasks, same zoom. See NOTICE-uniichat.md.
//
// What it does, in UniiChat's own terms:
// - Every message is logged forever, one JSON line per page in main/YYYY-MM-DD.jsonl,
//   as `kind: text` (the speaker tag), never edited. A text over CAP characters is
//   logged as several pages in a row (`more`).
// - Node (0,i) is message i in at most NODE bytes; node (l,i) merges (l-1,2i) and
//   (l-1,2i+1). A source that fits is its own node with no model call (so a short
//   message stays word for word); else a compaction writes it, asked again (with
//   the ruler and the cut) up to TRIES times, the shortest kept. Nodes are logged in
//   tree/YYYY-MM-DD.jsonl and never rebuilt.
// - A view lists nodes covering the chat to its end, oldest first. Past HIGH bytes
//   one batch merges the most due sibling pairs (age from the pair's LAST message,
//   in its own size) down to half. The compactions' own view does the same at SEEN.
//   view.json keeps both views; a load never rebuilds them.
// - zoom(id, n) opens a line into its two halves, zoom(id, 1) gives the message whole.
//
// Left out (not used by a Mono): images, imports (UniiChat's side 1), billing, a chat
// moving between processes (give/take), acts, goals, agents' logs. One deviation: a
// compactor that throws (a CLI that failed) leaves its node ready but does not
// restart it until the next push (UniiChat's calls are patient and retry inside
// AskAI; ours are not). Storage goes through a TreeDisk: node:fs in tests (monoTreeDisk.test-util.ts), the app's
// mono_tree_* commands in MonoCode Hub (monoTreeStore.ts). The disk changes where bytes go, never which.
//
// In the hub: only a Mono with "Keep one long chat" on has a tree (memory/tree/ in its folder); MEMORY.md and
// memory.add are unchanged for every Mono. Kept byte-identical to the original by monoTree.parity.test.ts.

// Types
// =====

// user: Ash's words; mono: this Mono's replies; tool: its tool calls; echo: their
// results; work: an agent's report, starting "[Name]"; seat: another Mono's post in a
// room, starting "[Name]"; note: memories from before the chat. (UniiChat: unii for
// mono; seat is the hub's, so a seat's words are never logged as Ash's.)
export type Kind = "user" | "mono" | "tool" | "echo" | "work" | "seat" | "note";

export type Msg = { kind: Kind; text: string; date?: string; line?: string; more?: boolean };
type Root = Msg & { i: number; size: number; date: string };
type Part = { l: number; i: number };
type View = { parts: Part[]; size: number; batch: boolean; high: number };
type Kept = { parts: Array<[number, number]>; batch: boolean };
type Saved = Kept & { seen?: Kept };
export type Block = { text: string; mark: boolean };
export type End = { ok: boolean; text: string; stop?: "fail" | "lost" | "down" };
export type Compactor = (system: string, blocks: Block[]) => Promise<End>;

/** Where a tree's files live. Synchronous, as UniiChat's node:fs calls are; the app's disk writes behind, in order. */
export type TreeDisk = {
  /** A file's text, or null when it doesn't exist. */
  read(path: string): string | null;
  /** The names of the files in a folder (none when it doesn't exist). */
  list(dir: string): string[];
  mkdir(dir: string): void;
  /** Adds to the end of a file, made if missing. */
  append(path: string, text: string): void;
  /** Replaces a file whole (UniiChat: write `.new`, then rename). */
  write(path: string, text: string): void;
};

export type Tree = {
  dir: string;
  files: TreeDisk;
  system: string;
  compactor: Compactor;
  msgs: Root[]; // every page logged, by id
  count: number; // pages logged whole
  open: number; // pages after, not whole yet
  disk: Map<number, string>; // every node on disk, by slot
  nodes: Map<number, string>; // nodes held (UniiChat's mem.nodes): built = held
  view: View;
  seen: View;
  ready: number[][]; // by level, sorted
  busy: Set<number>;
  failed: Set<number>;
  done: boolean;
  wait: Set<() => void>;
  made?: (l: number, i: number) => void;
};

// Constants (UniiChat Memory.ts and Clip.ts)
// =========

export const NODE = 512;
export const JOBS = 64;
export const TRIES = 5;
export const HIGH = 128000;
export const SEEN = 32000;
export const BLOCK = 4;
export const CAP = 30000;
const SCALE = "-".repeat(NODE);
export const WAIT = "(not summarized yet: zoom it)";

const LEAF = `Compaction: compress message {id} into one line of at most ${NODE} bytes
(about 70 words), the length of this ruler:
${SCALE}
<input>
`;

const MERGE = `Compaction: merge lines {a} and {b}, adjacent, into one line of at most
${NODE} bytes (about 70 words), the length of this ruler:
${SCALE}
<chat> may hold their messages, {id} to {end}, in more detail: take details
of them from there too.
<input>
`;

// Pages (Clip.ts)
// =====

export function clip_end(str: string, at: number): number {
  if (str.length - at <= CAP) return str.length;
  const nl = str.lastIndexOf("\n", at + CAP - 1);
  const low = str.charCodeAt(at + CAP) >> 10 === 0x37;
  return nl >= at ? nl + 1 : at + CAP - (low ? 1 : 0);
}

export function clip_pages(str: string): string[] {
  const pages: string[] = [];
  let at = 0;
  do {
    const end = clip_end(str, at);
    pages.push(str.slice(at, end));
    at = end;
  } while (at < str.length);
  return pages;
}

export function clip_page(str: string, at: number): string {
  const end = clip_end(str, at);
  const on = "\n[characters " + (at + 1) + "-" + end + " of " + str.length + "; go on with at " + end + "]";
  return str.slice(at, end) + (end < str.length ? on : "");
}

// Load and save
// =============

export function load(dir: string, system: string, compactor: Compactor, disk: TreeDisk): Tree {
  const t: Tree = {
    dir, files: disk, system, compactor, msgs: [], count: 0, open: 0, disk: new Map(), nodes: new Map(),
    view: { parts: [], size: 0, batch: false, high: HIGH }, seen: { parts: [], size: 0, batch: false, high: SEEN },
    ready: [], busy: new Set(), failed: new Set(), done: false, wait: new Set(),
  };
  const saved = savedView(disk, dir);
  for (const rec of readStream(disk, dir, "main")) if (rec.i !== undefined) t.msgs[rec.i] = rec;
  for (const rec of readStream(disk, dir, "tree")) if (rec.i !== undefined) t.disk.set(slot(rec.l, rec.i), rec.text);
  t.count = t.msgs.length;
  while (message(t, t.count - 1)?.more) t.count -= 1;
  t.open = t.msgs.length - t.count;
  openView(t, t.view, saved);
  openView(t, t.seen, saved?.seen ?? saved);
  roots(t.count).flatMap((part) => todo(t, part)).forEach((part) => ready(t, part, true));
  fit(t);
  save(t);
  return t;
}

function savedView(disk: TreeDisk, dir: string): Saved | null {
  try {
    return JSON.parse(disk.read(dir + "/view.json") ?? "");
  } catch {
    return null;
  }
}

function openView(t: Tree, view: View, kept: Kept | null): void {
  const keys = kept === null ? null : new Set(kept.parts.map(([l, i]) => slot(l, i)));
  view.parts = roots(t.count).flatMap((part) => down(t, part, keys));
  view.size = view.parts.reduce((n, part) => n + size(t, part), 0);
  view.batch = kept?.batch ?? false;
}

export function save(t: Tree): void {
  const file = t.dir + "/view.json";
  const [chat, seen] = [t.view, t.seen].map((view): Kept => ({ parts: view.parts.map((p) => [p.l, p.i]), batch: view.batch }));
  t.files.write(file, JSON.stringify({ ...chat, seen }));
}

// a log's records, its days in order; a line a crash cut short is skipped and
// ended, so the next record starts on a line of its own (UniiChat Memory.scan)
function readStream(disk: TreeDisk, dir: string, stream: "main" | "tree"): any[] {
  disk.mkdir(dir + "/" + stream);
  const out: any[] = [];
  for (const f of disk.list(dir + "/" + stream).filter((f) => f.endsWith(".jsonl")).sort()) {
    const file = dir + "/" + stream + "/" + f;
    const data = disk.read(file) ?? "";
    const lines = data.split("\n");
    const last = lines.pop()!;
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        if (line !== "") console.error("skipped a line of " + file + ": not JSON");
      }
    }
    if (last !== "") {
      console.error("skipped the last line of " + file + ": cut short");
      disk.append(file, "\n");
    }
  }
  return out;
}

function log(t: Tree, stream: "main" | "tree", recs: object[]): void {
  const day = new Date().toLocaleDateString("sv-SE");
  const file = t.dir + "/" + stream + "/" + day + ".jsonl";
  t.files.append(file, recs.map((rec) => JSON.stringify(rec) + "\n").join(""));
}

const UTF8 = new TextEncoder();
const FROM_UTF8 = new TextDecoder();

export function bytes(text: string): number {
  return UTF8.encode(text).length;
}

// String.prototype.toWellFormed (ES2024): each lone surrogate becomes U+FFFD
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function findLastIndex<T>(list: T[], test: (item: T) => boolean): number {
  for (let k = list.length - 1; k >= 0; k--) if (test(list[k])) return k;
  return -1;
}

// Messages
// ========

function root(i: number, msg: Msg): Root {
  const date = msg.date ?? new Date().toISOString();
  const r: Root = { ...msg, text: wellFormed(msg.text), i, size: 0, date };
  r.size = bytes(show(r));
  return r;
}

// a message as models read it: its speaker first
export function show(r: Msg): string {
  return r.kind + ": " + r.text;
}

export function message(t: Tree, i: number): Root | null {
  return Number.isInteger(i) && i >= 0 && i < t.count ? t.msgs[i] ?? null : null;
}

export function push(t: Tree, msgs: Msg[]): Root[] {
  t.failed.clear();
  const rs = msgs.flatMap(pages).map((msg, k) => root(t.count + t.open + k, msg));
  const done = findLastIndex(rs, (r) => !r.more) + 1;
  const ids = Array.from({ length: done === 0 ? 0 : t.open + done }, (_, k) => t.count + k);
  log(t, "main", rs);
  for (const r of rs) t.msgs[r.i] = r;
  t.open += rs.length - ids.length;
  t.count += ids.length;
  ids.forEach((i) => ready(t, { l: 0, i }, true));
  fit(t, true);
  pump(t);
  return rs;
}

function pages(msg: Msg): Msg[] {
  const texts = clip_pages(msg.text);
  const n = texts.length;
  return Array.from({ length: n }, (_, k) => {
    const more = k < n - 1 || msg.more === true ? true : undefined;
    const page: Msg = { ...msg, text: texts[k] ?? "", line: k === 0 ? msg.line : undefined, more };
    if (page.line === undefined) delete page.line;
    if (page.more === undefined) delete page.more;
    return page;
  });
}

// the first message from `from` on from which those to the end go whole in a call
export function whole(t: Tree, from: number): number {
  let [k, sz] = [t.count, 0];
  for (; k > from; k--) {
    sz += message(t, k - 1)!.size;
    if (k < t.count && sz > HIGH) return k;
  }
  return k;
}

// Tree
// ====

export function slot(l: number, i: number): number {
  return (2 * i + 1) * 2 ** l - 1;
}

export function built(t: Tree, l: number, i: number): boolean {
  return t.nodes.has(slot(l, i));
}

export function node(t: Tree, part: Part): string | null {
  const s = slot(part.l, part.i);
  return t.nodes.get(s) ?? t.disk.get(s) ?? null;
}

export function roots(count: number): Part[] {
  const out: Part[] = [];
  for (let l = 30, id = 0; l >= 0; l--) {
    if (id + 2 ** l <= count) {
      out.push({ l, i: id / 2 ** l });
      id += 2 ** l;
    }
  }
  return out;
}

function down(t: Tree, part: Part, keys: Set<number> | null): Part[] {
  const key = slot(part.l, part.i);
  const text = node(t, part);
  if (text !== null) t.nodes.set(key, text);
  if (part.l === 0 || (text !== null && (keys === null || keys.has(key)))) return [part];
  return halves(part).flatMap((half) => down(t, half, keys));
}

export function halves(part: Part): Part[] {
  return part.l === 0 ? [] : [{ l: part.l - 1, i: 2 * part.i }, { l: part.l - 1, i: 2 * part.i + 1 }];
}

export function source(t: Tree, l: number, i: number): string | null {
  if (l === 0) {
    const r = message(t, i);
    return r === null ? null : r.line ?? show(r);
  }
  const [a, b] = halves({ l, i }).map((half) => node(t, half));
  return a === null || b === null ? null : flat(a) + "\n" + flat(b);
}

function ctx(l: number, i: number): number {
  return l === 0 ? i : (i + 1) * 2 ** l;
}

// the message of the view's (k+1)th line not built, else the count
export function first(t: Tree, k = 0): number {
  return (t.ready[0] ?? [])[k] ?? t.count;
}

function ready(t: Tree, { l, i }: Part, on: boolean): void {
  const queue = (t.ready[l] ??= []);
  let [a, z] = [0, queue.length];
  while (a < z) {
    const m = (a + z) >> 1;
    [a, z] = queue[m] < i ? [m + 1, z] : [a, m];
  }
  if (on !== (queue[a] === i)) queue.splice(a, on ? 0 : 1, ...(on ? [i] : []));
}

function pump(t: Tree): void {
  let any = false;
  for (let free = starts(t); free.length > 0 && !t.done; free = starts(t)) {
    store(t, free);
    any = true;
  }
  if (any) fit(t);
}

function starts(t: Tree): Array<Part & { text: string }> {
  const free: Array<Part & { text: string }> = [];
  const end = first(t, JOBS - 1);
  const next: Part[] = [];
  t.ready.forEach((queue, l) => {
    for (let k = 0; k < queue.length && ctx(l, queue[k]) <= end; k++) next.push({ l, i: queue[k] });
  });
  next.sort((a, b) => ctx(a.l, a.i) - ctx(b.l, b.i) || b.l - a.l);
  for (const { l, i } of next) {
    if (t.done || t.busy.size >= JOBS) break;
    const s = slot(l, i);
    const text = t.busy.has(s) || t.failed.has(s) ? null : source(t, l, i);
    if (text !== null && bytes(text) <= NODE) free.push({ l, i, text });
    else if (text !== null) job(t, l, i, text);
  }
  return free;
}

// nodes under `part` not built whose sources are
function todo(t: Tree, part: Part): Part[] {
  if (built(t, part.l, part.i)) return [];
  const hs = halves(part);
  const here = hs.every((h) => built(t, h.l, h.i)) ? [part] : [];
  return [...here, ...hs.flatMap((h) => todo(t, h))];
}

function job(t: Tree, l: number, i: number, text: string): void {
  const key = slot(l, i);
  t.busy.add(key);
  build(t, l, i, text)
    .catch((err) => {
      t.failed.add(key);
      console.error("compactor: node " + l + "/" + i + ": " + (err?.message ?? err));
    })
    .finally(() => {
      t.busy.delete(key);
      pump(t);
      fit(t);
    });
}

async function build(t: Tree, l: number, i: number, text: string): Promise<void> {
  const taskBlock = { text: task(l, i) + text + "\n</input>", mark: false };
  const upto = Math.min(ctx(l, i), first(t, 0));
  const blocks = [...view(t, upto, t.seen.parts), taskBlock];
  const lines: string[] = [];
  let end = await t.compactor(t.system, blocks);
  while (end.ok && end.text.trim() !== "") {
    const line = end.text.trim();
    lines.push(line);
    if (bytes(line) <= NODE || lines.length === TRIES || t.done) break;
    end = await t.compactor(t.system, [...blocks, { text: over(line), mark: false }]);
  }
  if (lines.length === 0 && !end.ok && end.stop !== "fail") throw new Error(end.text);
  if (lines.length === 0) console.error("compactor: node " + l + "/" + i + ": " + (end.ok ? "an empty line" : end.text) + "; clipped");
  const line = lines.length === 0 ? cut(flat(text)) : lines.reduce((a, b) => (bytes(b) < bytes(a) ? b : a));
  store(t, [{ l, i, text: line }]);
}

function store(t: Tree, parts: Array<Part & { text: string }>): void {
  log(t, "tree", parts.map(({ l, i, text }) => ({ l, i, text, size: bytes(text) })));
  for (const { l, i, text } of parts) {
    ready(t, { l, i }, false);
    t.nodes.set(slot(l, i), text);
    t.disk.set(slot(l, i), text);
    [t.view, t.seen].forEach((v) => (v.size += l === 0 && i < endOf(v) ? bytes(text) : 0));
  }
  for (const { l, i } of parts) {
    const up = { l: l + 1, i: i >> 1 };
    if (built(t, l, i ^ 1) && !built(t, up.l, up.i)) ready(t, up, true);
  }
  parts.forEach(({ l, i }) => t.made?.(l, i));
}

export function task(l: number, i: number): string {
  const [a, z] = span({ l, i });
  const n = 2 ** l / 2;
  const fill: Array<[string, string]> = [["{a}", a + "+" + n], ["{b}", a + n + "+" + n], ["{id}", String(a)], ["{end}", String(z)]];
  return fill.reduce((s, [k, v]) => s.replace(k, v), l === 0 ? LEAF : MERGE);
}

export function cut(text: string): string {
  return FROM_UTF8.decode(UTF8.encode(text).subarray(0, NODE)).replace(/\uFFFD+$/, "");
}

export function over(line: string): string {
  return `Too long: your last line for this <input> was ${bytes(line)} bytes,
over the ${NODE}-byte limit. Write the whole line again, cutting just
enough of the least valuable items to fit before this cut:
${cut(line)}| ← LIMIT`;
}

// View
// ====

function text(t: Tree, part: Part): string {
  return t.nodes.get(slot(part.l, part.i)) ?? WAIT;
}

function size(t: Tree, part: Part): number {
  return built(t, part.l, part.i) ? bytes(text(t, part)) : 0;
}

export function fit(t: Tree, next = false): void {
  const gone: Part[] = [];
  let changed = false;
  reach(t, t.view, t.count);
  reach(t, t.seen, Math.min(t.count, first(t, 0)));
  for (const v of [t.view, t.seen]) {
    const [n, batch] = [v.parts.length, v.batch];
    if (v.size > v.high || (next && v.batch)) {
      const merged = merge(t, v);
      if (next || merged.size <= Math.max(v.high / 2, v.size - v.high)) {
        [v.parts, v.size] = [merged.parts, merged.size];
        gone.push(...merged.gone);
      }
      v.batch = v.size > v.high / 2;
    }
    changed ||= v.parts.length !== n || v.batch !== batch;
  }
  gone.filter((part) => !held(t, part)).forEach((part) => t.nodes.delete(slot(part.l, part.i)));
  if (changed) save(t);
  t.wait.forEach((check) => check());
}

function reach(t: Tree, v: View, end: number): void {
  for (const part of v.parts.splice(cover(v, end))) v.size -= size(t, part);
  for (let i = endOf(v); i < end; i++) {
    v.parts.push({ l: 0, i });
    v.size += size(t, { l: 0, i });
  }
}

function endOf({ parts }: View): number {
  return parts.length === 0 ? 0 : span(parts[parts.length - 1])[1] + 1;
}

function cover({ parts }: View, id: number): number {
  let [a, z] = [0, parts.length];
  while (a < z) {
    const m = (a + z) >> 1;
    [a, z] = span(parts[m])[1] < id ? [m + 1, z] : [a, m];
  }
  return a;
}

function held(t: Tree, part: Part): boolean {
  return [t.view, t.seen].some((v) => {
    const k = cover(v, span(part)[0]);
    return k === v.parts.length || v.parts[k].l <= part.l;
  });
}

function merge(t: Tree, from: View): { parts: Part[]; size: number; gone: Part[] } {
  const [T, low] = [endOf(from), from.high / 2];
  const v: Array<Part | null> = [...from.parts];
  const gone: Part[] = [];
  const next = v.map((_, k) => k + 1);
  const prev = v.map((_, k) => k - 1);
  const heap: Array<{ d: number; k: number; a: Part; b: Part }> = [];
  const over = (x: (typeof heap)[0], y: (typeof heap)[0]) => x.d > y.d || (x.d === y.d && x.k < y.k);
  const swap = (x: number, y: number) => ([heap[x], heap[y]] = [heap[y], heap[x]]);
  const offer = (k: number) => {
    const [a, b] = [v[k], v[next[k]]];
    if (k < 0 || !a || !b || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1 || !built(t, a.l + 1, a.i / 2)) return;
    heap.push({ d: (T + 1) / 2 ** a.l - a.i, k, a, b });
    for (let x = heap.length - 1; x > 0 && over(heap[x], heap[(x - 1) >> 1]); x = (x - 1) >> 1) swap(x, (x - 1) >> 1);
  };
  const take = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let x = 0; ; ) {
        const m = [x, 2 * x + 1, 2 * x + 2].reduce((m, c) => (c < heap.length && over(heap[c], heap[m]) ? c : m));
        if (m === x) break;
        swap(x, m);
        x = m;
      }
    }
    return top;
  };
  let sz = from.size;
  v.forEach((_, k) => offer(k));
  while (heap.length > 0 && sz > low) {
    const { k, a, b } = take();
    const j = next[k];
    if (v[k] !== a || v[j] !== b) continue;
    const up = { l: a.l + 1, i: a.i / 2 };
    sz += size(t, up) - size(t, a) - size(t, b);
    [v[k], v[j]] = [up, null];
    next[k] = next[j];
    prev[next[j]] = k;
    gone.push(a, b);
    offer(prev[k]);
    offer(k);
  }
  return { parts: v.filter((p): p is Part => p !== null), size: sz, gone };
}

// once every message before `end` is summarized
export function settle(t: Tree, end: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (first(t) >= end) {
        t.wait.delete(check);
        resolve();
      }
    };
    t.wait.add(check);
    check();
  });
}

export function span(part: Part): [number, number] {
  const a = part.i * 2 ** part.l;
  return [a, a + 2 ** part.l - 1];
}

export function flat(s: string): string {
  return s.includes("\n") ? s.replace(/\s*\n\s*/g, " ") : s;
}

export function ref(part: Part): string {
  return part.i * 2 ** part.l + "+" + 2 ** part.l;
}

export function line(part: Part, s: string): string {
  return ref(part) + "|" + flat(s);
}

function before(v: Part[], end: number): Part[] {
  return v.filter((part) => span(part)[1] < end);
}

// the view's lines built before `end`, in BLOCK-line blocks, the last whole one marked
export function view(t: Tree, end = t.count, parts = t.view.parts): Block[] {
  const lines = before(parts, end).filter((p) => built(t, p.l, p.i)).map((p) => line(p, text(t, p)) + "\n");
  const whole = Math.floor(lines.length / BLOCK);
  const blocks: Block[] = [{ text: "<chat>\n", mark: whole === 0 }];
  for (let k = 0; k < whole; k++) blocks.push({ text: lines.slice(k * BLOCK, (k + 1) * BLOCK).join(""), mark: k === whole - 1 });
  blocks.push({ text: lines.slice(whole * BLOCK).join("") + "</chat>\n", mark: false });
  return blocks;
}

export function part(t: Tree, id: number, n: number): Part | null {
  const l = Math.log2(n);
  const ok = Number.isInteger(id) && Number.isInteger(l) && id >= 0 && id % n === 0 && id + n <= t.count;
  return ok ? { l, i: id / n } : null;
}

export function zoom(t: Tree, id: number, n: number, at = 0): string {
  const p = part(t, id, n);
  const r = n === 1 ? message(t, id) : null;
  if (p === null) {
    return "No line " + id + "+" + n + ": n is a power of 2, id a multiple of n. The tree's roots: " + roots(t.count).map(ref).join(", ") + ".";
  }
  if (r !== null) return id + "+0|" + show({ ...r, text: clip_page(r.text, at) });
  return halves(p).map((h) => line(h, node(t, h) ?? WAIT)).join("\n");
}

/**
 * Every stored message that has all the query's words, newest first, each as "id+0|kind: …snippet…  (date)", so the
 * Mono can zoom(id, 1) the one it needs. Exact search over the raw messages, never only the summaries (hermes-lcm's
 * lcm_grep, Ash 12 Nov: one chat that goes on for good without losing the plot).
 */
export function grep(t: Tree, query: string, max = 20): string {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return "Give a few words to look for.";
  const hits: string[] = [];
  for (let i = t.count + t.open - 1; i >= 0 && hits.length < max; i--) {
    const r = t.msgs[i];
    if (!r) continue;
    const lower = r.text.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const at = Math.max(0, lower.indexOf(words[0]!) - 60);
    const snippet = flat(r.text.slice(at, at + 200));
    hits.push(`${r.i}+0|${r.kind}: ${at > 0 ? "…" : ""}${snippet}${at + 200 < r.text.length ? "…" : ""}  (${new Date(r.date).toLocaleString("sv-SE")})`);
  }
  return hits.length ? hits.join("\n") : `Nothing in the long chat has all of: ${words.join(", ")}.`;
}

export function date(t: Tree, id: number): string {
  const r = message(t, id);
  return r === null ? "No message " + id + "." : new Date(r.date).toLocaleString("sv-SE");
}
