// A learn run never reads everything. With tens of thousands of transcripts it reads a small,
// spread-out sample: one chat from each project in turn, newest first inside a project, so no
// single busy project crowds out the rest and the run still sees recent work.
// Pure. The listing comes from the app; nothing here reads a file.

import { estimateTokensFromBytes } from "./tokens";

/** About this many chats a run reads, unless the caller asks for another number. */
export const DEFAULT_BUDGET = 60;
/** A chat needs at least this many things the person said to be worth a read. */
export const MIN_USER_MESSAGES = 2;
/** A file this small cannot hold two messages from the person, so it is skipped without a read. */
export const MIN_CHAT_BYTES = 400;
/** The app reads up to 32 MB. A run does not: one huge chat is skipped and counted instead. */
export const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
/** Characters of chat text one run sends in all. Each chat gets an even share of it. */
export const TOTAL_CHAT_CHARS = 300_000;
const MIN_CHAT_CHARS = 2_500;
const MAX_CHAT_CHARS = 8_000;

/** Sources that keep one chat in one file, so the file size says how much was said. */
const FILE_SOURCES = new Set(["claude", "codex", "hermes", "pi", "grok"]);

export type SampleChat = {
  id: string;
  source: string;
  root: string;
  rel: string;
  bytes: number;
  mtimeMs: number;
  /** The folder the chat ran in, when the store says. */
  cwd?: string | null;
  /** Set when a caller already knows how many messages the person wrote. */
  userMessages?: number;
};

export type SampleOptions = {
  /** Only chats changed at or after this time (unix milliseconds). */
  fromMs?: number;
  /** Only chats from these project folders (a folder holds the chats of its sub-folders too). */
  projects?: readonly string[];
  /** Only these chat files, each the store folder joined to the chat's path in it. Nothing else is taken. */
  files?: readonly string[];
  /** Only chats from these stores ("claude", "codex"). */
  sources?: readonly string[];
  budget?: number;
  minUserMessages?: number;
};

function slashes(path: string): string {
  const flat = path.replace(/\\/g, "/");
  return flat.length > 1 ? flat.replace(/\/+$/, "") : flat;
}

/** The way Claude Code names a project's folder: every character that is not a letter or digit becomes a dash. */
function dashed(path: string): string {
  return slashes(path).replace(/[^A-Za-z0-9]/g, "-");
}

function firstSegment(rel: string): string {
  const flat = rel.replace(/\\/g, "/");
  const at = flat.indexOf("/");
  return at > 0 ? flat.slice(0, at) : "";
}

/**
 * Which project a chat belongs to. The folder it ran in when the store says; Claude Code files
 * sit in a folder named for the project; any other store is one project per store.
 */
export function projectOf(chat: Pick<SampleChat, "source" | "cwd" | "rel">): string {
  const cwd = typeof chat.cwd === "string" ? chat.cwd.trim() : "";
  if (cwd) return slashes(cwd);
  if (chat.source === "claude") {
    const folder = firstSegment(chat.rel);
    if (folder) return `claude:${folder}`;
  }
  return `store:${chat.source}`;
}

function inProjects(chat: SampleChat, projects: readonly string[]): boolean {
  const cwd = typeof chat.cwd === "string" ? slashes(chat.cwd.trim()) : "";
  const folder = chat.source === "claude" ? firstSegment(chat.rel) : "";
  for (const wanted of projects) {
    const path = slashes(wanted.trim());
    if (!path) continue;
    if (cwd && (cwd === path || cwd.startsWith(`${path}/`))) return true;
    if (folder) {
      const dash = dashed(path);
      if (folder === dash || folder.startsWith(`${dash}-`)) return true;
    }
  }
  return false;
}

/** One spelling for a chat file's path: the store folder and the path in it, forward slashes. */
export function chatFileKey(root: string, rel: string): string {
  return `${slashes(root)}/${rel.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function worthReading(chat: SampleChat, minUser: number): boolean {
  if (typeof chat.userMessages === "number") return chat.userMessages >= minUser;
  if (FILE_SOURCES.has(chat.source) && chat.bytes > 0 && chat.bytes < MIN_CHAT_BYTES) return false;
  return true;
}

export type SamplePlan = {
  /** Every chat the sample may take, in the order to take them. */
  order: SampleChat[];
  /** Chats skipped for being over the size a run reads. */
  tooBig: number;
  /** Projects the eligible chats came from. */
  projects: number;
};

/**
 * Every eligible chat in sampling order: project by project in turn (the project with the newest
 * chat first), newest first inside each. A caller that finds a chat unusable after reading it
 * walks on down this list; a caller that only needs a count takes `sampleChats`.
 */
export function sampleOrder(chats: readonly SampleChat[], options: SampleOptions = {}): SamplePlan {
  const minUser = options.minUserMessages ?? MIN_USER_MESSAGES;
  const from = typeof options.fromMs === "number" && Number.isFinite(options.fromMs) ? options.fromMs : null;
  const projects = options.projects?.filter((path) => typeof path === "string" && path.trim()) ?? [];
  const files = options.files ? new Set(options.files.map((file) => slashes(file))) : null;
  const sources = options.sources ? new Set(options.sources) : null;
  let tooBig = 0;
  const groups = new Map<string, SampleChat[]>();
  const seen = new Set<string>();
  for (const chat of chats) {
    if (!chat || typeof chat.id !== "string" || typeof chat.root !== "string" || typeof chat.rel !== "string") continue;
    const mtime = Number.isFinite(chat.mtimeMs) ? chat.mtimeMs : 0;
    if (from !== null && mtime < from) continue;
    if (sources && !sources.has(chat.source)) continue;
    if (files && !files.has(chatFileKey(chat.root, chat.rel))) continue;
    if (projects.length > 0 && !inProjects(chat, projects)) continue;
    if (!worthReading(chat, minUser)) continue;
    // Rows that share one database (OpenCode) are told apart by id, files by their path.
    const key = `${chat.source}\0${chat.root}\0${chat.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (chat.bytes > MAX_SAMPLE_BYTES && FILE_SOURCES.has(chat.source)) {
      tooBig += 1;
      continue;
    }
    const project = projectOf(chat);
    const group = groups.get(project);
    if (group) group.push({ ...chat, mtimeMs: mtime });
    else groups.set(project, [{ ...chat, mtimeMs: mtime }]);
  }
  const lists = [...groups.entries()].map(([project, list]) => {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { project, list };
  });
  lists.sort((a, b) => b.list[0].mtimeMs - a.list[0].mtimeMs || (a.project < b.project ? -1 : 1));
  const order: SampleChat[] = [];
  for (let round = 0; ; round += 1) {
    let took = false;
    for (const { list } of lists) {
      if (round < list.length) {
        order.push(list[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  return { order, tooBig, projects: lists.length };
}

/** The chats a run reads: the front of the sampling order, up to the budget. */
export function sampleChats(chats: readonly SampleChat[], options: SampleOptions = {}): SampleChat[] {
  const budget = Math.max(0, Math.floor(options.budget ?? DEFAULT_BUDGET));
  return sampleOrder(chats, options).order.slice(0, budget);
}

/** Characters one chat is cut to so a whole run stays a size a cheap model takes in one go. */
export function charsPerChat(count: number): number {
  const share = Math.floor(TOTAL_CHAT_CHARS / Math.max(1, count));
  return Math.min(MAX_CHAT_CHARS, Math.max(MIN_CHAT_CHARS, share));
}

export type RunEstimate = { chats: number; tokens: number };

/** A ceiling, not a bill: a chat counts for its size or its cut-down share, whichever is less. */
export function estimateRun(picked: readonly Pick<SampleChat, "bytes">[], count = picked.length): RunEstimate {
  const cap = Math.ceil(charsPerChat(count) / 4);
  let tokens = 0;
  for (const chat of picked) {
    const size = Number.isFinite(chat.bytes) && chat.bytes > 0 ? estimateTokensFromBytes(chat.bytes) : cap;
    tokens += Math.min(size, cap);
  }
  return { chats: picked.length, tokens };
}
