// A Mono's long chat (Mono.longChat, "Keep one long chat"; off by default): its summary tree (monoTree.ts) in
// `memory/tree/` of its folder, made by the app (mono.rs mono_tree_load), fed with each finished turn's messages from
// the chat's own blocks (the ones mono_session_upsert keeps in mono_blocks): Ash's words, its replies, its tool calls
// and their results, and room or Mono posts (`seat`). MEMORY.md and memory.add are untouched; a Mono without the
// setting has no tree at all, and New conversation still starts a fresh conversation (which then opens on the view).
//
// The tree's engine is synchronous, as UniiChat's is: the files are read once, then every write goes behind, in order,
// through mono_tree_write. The summariser runs in the background on the hub's cheap isolated call (setTreeCompactor,
// two at a time); a turn never waits on it.
import { invoke } from "@tauri-apps/api/core";
import type { Block } from "../../sessions/model/session";
import { findMono, monoLook } from "./mono";
import * as T from "./monoTree";
import PROMPT from "./monoTreePrompt.txt?raw";

const ROOT = "tree";
/** One page of a tool result is kept in the tree; the chat's own transcript keeps the rest. */
const ECHO_MAX = T.CAP;
/** Compactions at once, whatever the engine has ready (UniiChat runs JOBS = 64 on its API; ours are processes). */
const RUNNING_MAX = 2;

type FileOp = { path: string; text: string; append: boolean };
export type TreeIo = {
  load(monoId: string): Promise<Array<{ path: string; text: string }>>;
  write(monoId: string, ops: FileOp[]): Promise<void>;
};

const tauriIo: TreeIo = {
  load: (monoId) =>
    invoke("mono_tree_load", { mono: monoId, legacyProject: findMono(monoId)?.legacyProject ?? null }),
  write: (monoId, ops) =>
    invoke("mono_tree_write", { mono: monoId, legacyProject: findMono(monoId)?.legacyProject ?? null, ops }),
};

let io: TreeIo = tauriIo;
/** Tests hand in their own files. */
export function setTreeIo(next: TreeIo | undefined): void {
  io = next ?? tauriIo;
}

/** The cheap call a compaction makes: the prompt in, the line out. Set by the app (App.tsx). */
type Ask = (prompt: string) => Promise<string>;
let ask: Ask | undefined;
export function setTreeCompactor(next: Ask | undefined): void {
  ask = next;
}

let running = 0;
const queued: Array<() => void> = [];
async function slot<R>(work: () => Promise<R>): Promise<R> {
  if (running >= RUNNING_MAX) await new Promise<void>((go) => queued.push(go));
  running++;
  try {
    return await work();
  } finally {
    running--;
    queued.shift()?.();
  }
}

/**
 * The engine's compactor on a text-only call: the compaction rules, then the blocks as one prompt. A failed call
 * throws, so the node waits for the next message instead of being cut (monoTree.ts: failed until the next push).
 */
const compactor: T.Compactor = (system, blocks) =>
  slot(async () => {
    if (!ask) throw new Error("No engine for the long chat's summaries");
    const text = await ask(`${system}\n\n${blocks.map((block) => block.text).join("")}`);
    return { ok: true, text };
  });

/** A disk over the files read at open: reads from memory, writes behind in order. */
function memoryDisk(monoId: string, files: Array<{ path: string; text: string }>, failed: (error: unknown) => void): T.TreeDisk {
  const held = new Map<string, string>(files.map((file) => [`${ROOT}/${file.path}`, file.text]));
  let ops: FileOp[] = [];
  let writing = Promise.resolve();
  const flush = () => {
    const batch = ops;
    ops = [];
    writing = writing.then(() => io.write(monoId, batch)).catch(failed);
  };
  const queue = (op: FileOp) => {
    if (ops.length === 0) queueMicrotask(flush);
    ops.push(op);
  };
  const relative = (path: string) => path.slice(ROOT.length + 1);
  return {
    read: (path) => held.get(path) ?? null,
    list: (dir) =>
      [...held.keys()].filter((path) => path.startsWith(dir + "/") && !path.slice(dir.length + 1).includes("/")).map((path) => path.slice(dir.length + 1)),
    mkdir: () => {},
    append: (path, text) => {
      held.set(path, (held.get(path) ?? "") + text);
      queue({ path: relative(path), text, append: true });
    },
    write: (path, text) => {
      held.set(path, text);
      queue({ path: relative(path), text, append: false });
    },
  };
}

type Held = { tree: T.Tree; fed: Set<string> };
const trees = new Map<string, Promise<Held>>();

/** The compaction rules for this Mono (monoTreePrompt.txt, UniiChat's prompt.txt with the Mono's name). */
export function treeSystem(name: string): string {
  return PROMPT.split("{mono}").join(name);
}

function monoName(monoId: string): string {
  const mono = findMono(monoId);
  return mono ? monoLook(mono).name : monoId;
}

/** The Mono's tree, opened once per run of the app. Only for a Mono with the long chat on. */
export function openTree(monoId: string): Promise<Held> {
  let held = trees.get(monoId);
  if (!held) {
    held = io.load(monoId).then((files) => {
      const disk = memoryDisk(monoId, files, (error) => console.error(`long chat ${monoId}: a write failed`, error));
      const tree = T.load(ROOT, treeSystem(monoName(monoId)), compactor, disk);
      const fed = new Set<string>();
      for (const msg of tree.msgs) {
        const ref = (msg as { ref?: string } | undefined)?.ref;
        if (ref) fed.add(ref);
      }
      return { tree, fed };
    });
    held.catch(() => trees.delete(monoId));
    trees.set(monoId, held);
  }
  return held;
}

/** Forget an open tree (the setting went off, or a test). */
export function closeTree(monoId: string): void {
  const held = trees.get(monoId);
  trees.delete(monoId);
  void held?.then(({ tree }) => void (tree.done = true)).catch(() => undefined);
}

export function longChatOn(monoId: string | undefined): boolean {
  return !!monoId && findMono(monoId)?.longChat === true;
}

/** A block as tree messages (none for chrome): the kind is who spoke, so a seat's words are never logged as Ash's. */
export function treeMessages(block: Block): Array<T.Msg & { ref: string }> {
  const text = (block.text ?? "").trim();
  const ref = block.id;
  if (block.streaming || block.draft) return [];
  if (block.role === "user") {
    if (!block.internal) return text ? [{ kind: "user", text, ref }] : [];
    const note = block.monoNote;
    if (note) return text ? [{ kind: "seat", text: `[${note.from}] ${text}`, ref }] : [];
    if (block.monoSessionCompletion) return text ? [{ kind: "work", text: `[${block.monoSessionCompletion.title}] ${text}`, ref }] : [];
    if (block.monoCheck) return text ? [{ kind: "work", text: `[MonoCode check] ${text}`, ref }] : [];
    return [];
  }
  if (block.role === "assistant") return text ? [{ kind: "mono", text, ref }] : [];
  if (block.role === "tool" && block.tool) {
    const call = (block.tool.title ?? block.tool.kind ?? "tool").trim();
    const out = (block.tool.detail ?? "").trim();
    const echo =
      out.length > ECHO_MAX ? `${out.slice(0, ECHO_MAX)}\n[${out.length - ECHO_MAX} more characters are in the chat, not here]` : out;
    return [
      { kind: "tool", text: call, ref },
      ...(echo ? [{ kind: "echo" as const, text: echo, ref: `${ref}:out` }] : []),
    ];
  }
  return [];
}

/**
 * Logs a finished turn's blocks not logged yet, oldest first. Idempotent: each block goes in once (its id rides on
 * its message in main/, so a restart knows), and a block before the last logged one is never logged after it.
 */
export async function feedTree(
  monoId: string,
  blocks: readonly Block[],
  opts?: { evenWithoutSetting?: boolean },
): Promise<number> {
  // WP-51: a first mate past the size is fed even when "Keep one long chat" is off.
  if (!longChatOn(monoId) && opts?.evenWithoutSetting !== true) return 0;
  const { tree, fed } = await openTree(monoId);
  let from = 0;
  for (let k = blocks.length - 1; k >= 0; k--)
    if (fed.has(blocks[k].id)) {
      from = k + 1;
      break;
    }
  const msgs = blocks.slice(from).flatMap(treeMessages);
  if (!msgs.length) return 0;
  for (const msg of msgs) fed.add(msg.ref);
  T.push(tree, msgs);
  return msgs.length;
}

/** What a fresh conversation of a long-chat Mono opens on: the view, and how to open it back up. */
export async function treeContext(
  monoId: string,
  cli: string,
  opts?: { evenWithoutSetting?: boolean },
): Promise<string | undefined> {
  // WP-51: same gate as feedTree. Without the flag, a Mono that is off still has no tree.
  if (!longChatOn(monoId) && opts?.evenWithoutSetting !== true) return undefined;
  const { tree } = await openTree(monoId);
  if (tree.count === 0) return undefined;
  const view = T.view(tree)
    .map((block) => block.text)
    .join("");
  return `<long_chat>
You keep one long chat with Ash. Below is all of it so far, oldest first, as one-line summaries: "id+n|text" covers the n messages from id on; recent lines are single messages, word for word. Each item names who said it (user: is Ash; mono: is you; seat: another Mono or a room). A line you need in full: \`${cli} tree.zoom {"id":12,"n":4}\` opens it into the two lines it was made from, \`{"id":12,"n":1}\` gives message 12 whole, \`${cli} tree.date {"id":12}\` its date, and \`${cli} tree.grep {"query":"homepage refactor"}\` finds every message that has those words, word for word, when a summary leaves out what you need. Its latest word on a thing is the truth; a question in it is still a question. Workers you start don't get this.
${view}</long_chat>`;
}

/** tree.zoom and tree.date, for the Mono's own chat (agentApp.ts checks the caller). */
export async function treeZoom(monoId: string, id: number, n: number, at = 0): Promise<string> {
  const { tree } = await openTree(monoId);
  return T.zoom(tree, id, n, at);
}

export async function treeGrep(monoId: string, query: string): Promise<string> {
  const { tree } = await openTree(monoId);
  return T.grep(tree, query);
}

export async function treeDate(monoId: string, id: number): Promise<string> {
  const { tree } = await openTree(monoId);
  return T.date(tree, id);
}

/** The view as lines for the settings panel: what each covers, and its text. */
export type TreeLine = { id: number; n: number; text: string };
export function treeLines(text: string): TreeLine[] {
  return text
    .split("\n")
    .map((line) => /^(\d+)\+(\d+)\|(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => ({ id: Number(match[1]), n: Number(match[2]), text: match[3] }));
}

export async function treeView(monoId: string): Promise<TreeLine[]> {
  const { tree } = await openTree(monoId);
  return treeLines(
    T.view(tree)
      .map((block) => block.text)
      .join(""),
  );
}
