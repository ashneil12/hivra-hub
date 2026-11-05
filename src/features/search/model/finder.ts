// WP-74: one search across every kind. Tasks and docs come from the FTS index.
// Chats, files and projects come from the search the app already has.

import { fuzzyMatch } from "../../../shared/lib/fuzzy";
import { sameProjectPath } from "../../projects/model/recents";
import type { Mono } from "../../monos/model/mono";
import type { AppSearchHit } from "./appSearch";

export type FinderKind =
  | "task"
  | "doc"
  | "mono"
  | "conversation"
  | "message"
  | "file"
  | "content"
  | "project"
  | "command";

export type FinderScope = "project" | "all";

export type FinderHit = {
  id: string;
  kind: FinderKind;
  title: string;
  subtitle: string;
  /** A project path or a task's project key. Empty when the hit has no project. */
  project: string;
  /** Mono hits: every project folder the Mono works on. */
  projects?: string[];
  score: number;
  sessionId?: string;
  blockId?: string | null;
  path?: string;
  line?: number;
  column?: number;
  commandId?: string;
  monoId?: string;
};

export type FinderGroup = {
  kind: FinderKind;
  label: string;
  hits: FinderHit[];
};

const PREFIX: Record<string, FinderKind> = {
  t: "task",
  d: "doc",
  o: "mono",
  c: "conversation",
  m: "message",
  f: "file",
  p: "project",
};

const LABELS: Record<FinderKind, string> = {
  task: "Tasks",
  doc: "Docs",
  mono: "Monos",
  conversation: "Chats",
  message: "Messages",
  file: "Files",
  content: "File text",
  project: "Projects",
  command: "Commands",
};

const KINDS = new Set<string>(Object.keys(LABELS));

export type ParsedFinderQuery = {
  mode: "search" | "commands";
  kind: FinderKind | null;
  text: string;
};

/** `>` lists commands. A known prefix (`t:`) narrows to one kind. `z:` does not. */
export function parseFinderQuery(raw: string): ParsedFinderQuery {
  const trimmed = raw.replace(/\r\n/g, "\n").trim();
  if (trimmed.startsWith(">")) {
    return { mode: "commands", kind: null, text: trimmed.slice(1).trim() };
  }
  const prefix = /^([A-Za-z]):([\s\S]*)$/.exec(trimmed);
  if (prefix) {
    const kind = PREFIX[prefix[1].toLowerCase()];
    if (kind) return { mode: "search", kind, text: prefix[2].trim() };
  }
  return { mode: "search", kind: null, text: trimmed };
}

export function toggleFinderScope(scope: FinderScope): FinderScope {
  return scope === "project" ? "all" : "project";
}

export function finderKindLabel(kind: FinderKind): string {
  return LABELS[kind];
}

export function trustedKind(value: unknown): FinderKind | null {
  return typeof value === "string" && KINDS.has(value) ? (value as FinderKind) : null;
}

/**
 * Enter opens. ⌘Enter and Ctrl+Enter open beside. Alt+Enter does not.
 * Tab switches between this project and all projects. Arrows move.
 */
export function finderKeyAction(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}):
  | { type: "move"; delta: 1 | -1 }
  | { type: "open"; beside: boolean }
  | { type: "scope" }
  | null {
  if (event.key === "ArrowDown") return { type: "move", delta: 1 };
  if (event.key === "ArrowUp") return { type: "move", delta: -1 };
  if (event.key === "Tab") return { type: "scope" };
  if (event.key === "Enter") {
    const beside = (event.metaKey || event.ctrlKey) && !event.altKey;
    return { type: "open", beside };
  }
  return null;
}

/** A failed or timed-out search keeps the hits already on screen. */
export function settle<T>(previous: T, result: { ok: true; value: T } | { ok: false }): T {
  return result.ok ? result.value : previous;
}

/** A late response from an older search is ignored. */
export function acceptGeneration(latest: number, received: number): boolean {
  return received === latest;
}

function keysMatch(project: string, current: string, keys: readonly string[]): boolean {
  if (!project) return false;
  if (sameProjectPath(project, current)) return true;
  return keys.some((key) => key === project || sameProjectPath(key, project));
}

export function hitInProject(hit: FinderHit, current: string, keys: readonly string[]): boolean {
  if (hit.kind === "file" || hit.kind === "content" || hit.kind === "command") return true;
  if (hit.kind === "mono") {
    return (hit.projects ?? []).some((path) => keysMatch(path, current, keys));
  }
  return keysMatch(hit.project, current, keys);
}

function allows(kind: FinderKind, only: FinderKind | null): boolean {
  if (!only) return true;
  if (only === "file") return kind === "file" || kind === "content";
  if (only === "conversation") return kind === "conversation";
  return kind === only;
}

/**
 * Current project first, then score. In project scope, other projects are
 * hidden. Files and file text are already this project's. Duplicate ids keep
 * the better row.
 */
export function rankFinderHits(
  hits: readonly FinderHit[],
  current: string,
  keys: readonly string[],
  scope: FinderScope,
  only: FinderKind | null,
): FinderHit[] {
  const ranked = hits
    .filter((hit) => trustedKind(hit.kind) !== null && allows(hit.kind, only))
    .map((hit) => ({ hit, here: hitInProject(hit, current, keys) }))
    .filter((row) => scope === "all" || row.here);
  ranked.sort((a, b) => {
    if (a.here !== b.here) return a.here ? -1 : 1;
    if (a.hit.score !== b.hit.score) return b.hit.score - a.hit.score;
    return a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0;
  });
  const seen = new Set<string>();
  const out: FinderHit[] = [];
  for (const row of ranked) {
    if (!row.hit.id || seen.has(row.hit.id)) continue;
    seen.add(row.hit.id);
    out.push(row.hit);
  }
  return out;
}

export function groupFinderHits(hits: readonly FinderHit[]): FinderGroup[] {
  const groups: FinderGroup[] = [];
  for (const hit of hits) {
    const last = groups[groups.length - 1];
    if (last && last.kind === hit.kind) last.hits.push(hit);
    else groups.push({ kind: hit.kind, label: LABELS[hit.kind], hits: [hit] });
  }
  return groups;
}

export type FinderCommand = { id: string; label: string };

export function commandHits(text: string, commands: readonly FinderCommand[]): FinderHit[] {
  const needle = text.trim();
  const hits: FinderHit[] = [];
  for (const command of commands) {
    if (!command.id || !command.label) continue;
    if (!needle) {
      hits.push(commandHit(command, 0));
      continue;
    }
    const match = fuzzyMatch(needle, command.label);
    if (match) hits.push(commandHit(command, match.score));
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function commandHit(command: FinderCommand, score: number): FinderHit {
  return {
    id: `command:${command.id}`,
    kind: "command",
    title: command.label,
    subtitle: "",
    project: "",
    score,
    commandId: command.id,
  };
}

export function monoHits(monos: readonly Mono[], text: string): FinderHit[] {
  const needle = text.trim();
  if (!needle) return [];
  const hits: FinderHit[] = [];
  const seen = new Set<string>();
  for (const mono of monos) {
    if (!mono || typeof mono.id !== "string" || !mono.id || seen.has(mono.id)) continue;
    seen.add(mono.id);
    const name = (mono.name ?? "").trim() || mono.id;
    const fields = [name, mono.role ?? "", mono.mascot ?? ""];
    let best: number | null = null;
    for (const field of fields) {
      if (!field.trim()) continue;
      const match = fuzzyMatch(needle, field);
      if (match && (best === null || match.score > best)) best = match.score;
    }
    if (best === null) continue;
    const projects = Array.isArray(mono.projects)
      ? mono.projects.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [];
    hits.push({
      id: `mono:${mono.id}`,
      kind: "mono",
      title: name,
      subtitle: (mono.role ?? "").trim(),
      project: projects[0] ?? "",
      projects,
      score: best,
      monoId: mono.id,
    });
  }
  return hits;
}

export type IndexedRow = {
  id?: unknown;
  project?: unknown;
  title?: unknown;
  snippet?: unknown;
  score?: unknown;
  blockId?: unknown;
};

function indexedHit(kind: "task" | "doc", row: IndexedRow): FinderHit | null {
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.title !== "string") return null;
  const score = typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0;
  const project = typeof row.project === "string" ? row.project : "";
  const snippet = typeof row.snippet === "string" ? row.snippet : "";
  const blockId = typeof row.blockId === "string" && row.blockId ? row.blockId : null;
  return {
    id: `${kind}:${row.id}`,
    kind,
    title: row.title,
    subtitle: snippet,
    project,
    score,
    blockId: kind === "doc" ? blockId : undefined,
  };
}

/** Rows from the index are untrusted. A bad row is dropped, not a failed search. */
export function hitsFromIndex(payload: unknown): FinderHit[] {
  if (!payload || typeof payload !== "object") return [];
  const body = payload as { tasks?: unknown; docs?: unknown };
  const out: FinderHit[] = [];
  if (Array.isArray(body.tasks)) {
    for (const row of body.tasks) {
      if (!row || typeof row !== "object") continue;
      const hit = indexedHit("task", row as IndexedRow);
      if (hit) out.push(hit);
    }
  }
  if (Array.isArray(body.docs)) {
    for (const row of body.docs) {
      if (!row || typeof row !== "object") continue;
      const hit = indexedHit("doc", row as IndexedRow);
      if (hit) out.push(hit);
    }
  }
  return out;
}

export function hitFromAppSearch(hit: AppSearchHit): FinderHit | null {
  if (hit.kind === "conversation") {
    return {
      id: hit.id,
      kind: "conversation",
      title: hit.title,
      subtitle: "",
      project: hit.cwd,
      score: hit.score,
      sessionId: hit.sessionId,
    };
  }
  if (hit.kind === "message") {
    return {
      id: hit.id,
      kind: "message",
      title: hit.title,
      subtitle: hit.preview,
      project: hit.cwd,
      score: hit.score,
      sessionId: hit.sessionId,
      blockId: hit.blockId,
    };
  }
  if (hit.kind === "file") {
    return {
      id: hit.id,
      kind: "file",
      title: hit.name,
      subtitle: hit.relative,
      project: "",
      score: hit.score,
      path: hit.path,
    };
  }
  if (hit.kind === "content") {
    return {
      id: hit.id,
      kind: "content",
      title: hit.name,
      subtitle: hit.preview,
      project: "",
      score: 1,
      path: hit.path,
      line: hit.line,
      column: hit.column,
    };
  }
  return {
    id: hit.id,
    kind: "project",
    title: hit.name,
    subtitle: hit.path,
    project: hit.path,
    score: hit.score,
    path: hit.path,
  };
}

export function assembleFinder(input: {
  query: string;
  scope: FinderScope;
  project: string;
  keys?: readonly string[];
  indexed?: readonly FinderHit[];
  app?: readonly AppSearchHit[];
  monos?: readonly Mono[];
  commands?: readonly FinderCommand[];
}): FinderHit[] {
  const parsed = parseFinderQuery(input.query);
  const keys = input.keys ?? [];
  if (parsed.mode === "commands") return commandHits(parsed.text, input.commands ?? []);
  if (!parsed.text) return [];
  const raw: FinderHit[] = [
    ...(input.indexed ?? []),
    ...(input.app ?? []).flatMap((hit) => {
      const next = hitFromAppSearch(hit);
      return next ? [next] : [];
    }),
    ...monoHits(input.monos ?? [], parsed.text),
  ];
  return rankFinderHits(raw, input.project, keys, input.scope, parsed.kind);
}

/**
 * ⌘K and Ctrl+K open the finder. Ctrl+K inside the terminal is left to the
 * terminal, because that chord is the terminal's own.
 */
export function finderShortcutAction(
  shortcut: string | null,
  inTerminal: boolean,
  ctrl: boolean,
  meta: boolean,
): "open" | "leave" | null {
  if (shortcut !== "App: Search") return null;
  if (inTerminal && ctrl && !meta) return "leave";
  return "open";
}

export type FinderOpener = {
  openTask: (id: string, project: string) => void;
  openDoc: (id: string, blockId: string | null) => void;
  openMessage: (sessionId: string, blockId: string, query: string) => void;
  openConversation: (sessionId: string) => void;
  openMono: (id: string) => void;
  openFile: (
    path: string,
    line: number | undefined,
    column: number | undefined,
    beside: boolean,
  ) => void;
  openProject: (path: string) => void;
  runCommand: (id: string) => void;
};

function storedId(hit: FinderHit): string {
  const prefix = `${hit.kind}:`;
  return hit.id.startsWith(prefix) ? hit.id.slice(prefix.length) : hit.id;
}

/**
 * Opens a hit in the screen that owns it. A doc and a message have no side
 * surface, so ⌘Enter still opens them in place.
 */
export function routeFinderHit(
  hit: FinderHit,
  beside: boolean,
  query: string,
  open: FinderOpener,
): void {
  if (!hit?.id || typeof hit.id !== "string") return;
  if (hit.kind === "task") {
    open.openTask(storedId(hit), typeof hit.project === "string" ? hit.project : "");
    return;
  }
  if (hit.kind === "doc") {
    open.openDoc(storedId(hit), typeof hit.blockId === "string" ? hit.blockId : null);
    return;
  }
  if (hit.kind === "message") {
    if (!hit.sessionId || !hit.blockId) return;
    open.openMessage(hit.sessionId, hit.blockId, query);
    return;
  }
  if (hit.kind === "conversation") {
    if (hit.sessionId) open.openConversation(hit.sessionId);
    return;
  }
  if (hit.kind === "mono") {
    if (hit.monoId) open.openMono(hit.monoId);
    return;
  }
  if (hit.kind === "file" || hit.kind === "content") {
    if (!hit.path) return;
    open.openFile(hit.path, hit.line, hit.column, beside);
    return;
  }
  if (hit.kind === "project") {
    if (hit.path) open.openProject(hit.path);
    return;
  }
  if (hit.kind === "command" && hit.commandId) open.runCommand(hit.commandId);
}
