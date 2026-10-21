// The soul tamper check (Alfred's idea, the CoS's guard on it). The app keeps the hash of every soul it saves
// (monos/model/soulSaved.ts). When it reads or opens a soul whose file no longer matches, something other than the app
// changed it, and the file's change time is set against when that Mono's own chats and workers (or any chat working in
// its home folder) were running (monos/model/sessionRuns.ts):
// - an agent or worker chat was running then: the last saved soul is put back, the changed file is kept beside it in
//   that Mono's memory, and one Bot changes row says so, whose button ("Keep that change") brings the change back;
// - nothing was running: it was Ash editing the file by hand. His version is kept and becomes the saved one, with a
//   row whose Undo goes back to what the app last saved. Ash's edits always win.
// A Mono the app has no saved soul for yet (first launch with this, or storage cleared) just has its file recorded.
import { listMonos, monoLook } from "../../monos/model/mono";
import { readAgentFile, setSoulOpenCheck, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { recordSavedSoul, savedSoul } from "../../monos/model/soulSaved";
import { refreshProcessRuns, runsAt, type RunWindow } from "../../monos/model/sessionRuns";
import { recordBotChange } from "./botChanges";
import { chatMonoOwner, chatRunKind, monoHomeDirs } from "./hubMcp";

export type TamperFiles = {
  read(monoId: string, path: AgentFilePath): Promise<{ text: string | null; hash: string; modifiedMs?: number }>;
  write(monoId: string, path: AgentFilePath, text: string, expectedHash?: string): Promise<string>;
};

export type SoulCheck = "unchanged" | "recorded" | "put-back" | "kept-ash" | "skipped";

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/** Where the changed file is kept when the saved soul is put back. */
export function changedSoulNote(at: number): AgentFilePath {
  return `memory/soul-changed-outside-${stamp(at)}.md`;
}

/** What was running when the soul changed, by the run records' own kind (chat, worker or habit run). */
export type RunningKinds = { chats?: number; otherChats?: number; workers?: number; habits?: number };

/** "frank's chat", "a worker", "Hivra lead's chat and 2 workers": what was running, in plain words. */
function runningPhrase(name: string, k: RunningKinds): { phrase: string; many: boolean } {
  const parts: string[] = [];
  const n = (x?: number) => x ?? 0;
  if (n(k.chats)) parts.push(n(k.chats) === 1 ? `${name}'s chat` : `${n(k.chats)} of ${name}'s chats`);
  if (n(k.otherChats)) parts.push(n(k.otherChats) === 1 ? `a chat working in ${name}'s folder` : `${n(k.otherChats)} chats working in ${name}'s folder`);
  if (n(k.workers)) parts.push(n(k.workers) === 1 ? "a worker" : `${n(k.workers)} workers`);
  if (n(k.habits)) parts.push(n(k.habits) === 1 ? `one of ${name}'s habits` : `${n(k.habits)} of ${name}'s habits`);
  if (!parts.length) parts.push("a worker");
  const total = n(k.chats) + n(k.otherChats) + n(k.workers) + n(k.habits);
  const phrase = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  return { phrase, many: total > 1 };
}

export function putBackLine(name: string, running: RunningKinds = { workers: 1 }): string {
  const { phrase, many } = runningPhrase(name, running);
  return `Something outside the app changed ${name}'s soul while ${phrase} ${many ? "were" : "was"} running, so it was put back.`;
}

/** The runs, counted by kind: this Mono's own chat, another chat working in its home folder, a worker, a habit run. */
export function runningKinds(runs: readonly Pick<RunWindow, "sessionId">[], monoId: string): RunningKinds {
  const out: Required<RunningKinds> = { chats: 0, otherChats: 0, workers: 0, habits: 0 };
  for (const run of runs) {
    const kind = chatRunKind(run.sessionId);
    if (kind === "worker") out.workers++;
    else if (kind === "habit") out.habits++;
    else if (chatMonoOwner(run.sessionId) === monoId) out.chats++;
    else out.otherChats++;
  }
  return out;
}

export function keptAshLine(name: string): string {
  return `${name}'s soul was edited outside the app. Kept your version.`;
}

/**
 * One tool call as a chat made it: its kind (edit, read, execute...), what it said (command, file paths), and when its
 * turn started (or when it was first seen), so a write from an earlier turn of the same chat isn't blamed on this run.
 */
export type RunToolCall = { kind?: string; text: string; at?: number };

/** What a chat's tool calls were, by session id: App.tsx sets it from its sessions. */
let toolCallSource: ((sessionId: string) => readonly RunToolCall[]) | null = null;
export function setRunToolTextSource(source: ((sessionId: string) => readonly RunToolCall[]) | null): void {
  toolCallSource = source;
}

type ToolBlockLike = { tool?: { callId?: string; kind?: string; title?: string; detail?: string; paths?: string[] } };
const seenCalls = new Map<string, Map<string, RunToolCall>>();
const SEEN_SESSIONS = 100;
/** How much earlier than its run window a turn's start can be (the page notices a chat is busy a little late). */
const TURN_SLACK_MS = 30_000;
const SEEN_CALLS = 300;
const RECENT_BLOCKS = 60;

/**
 * The tool calls of the chats running now, kept as they were asked for (App.tsx, on every sessions change). A finished
 * shell call's detail becomes its output, so its command is only seen while it is pending: kept here, it still counts.
 */
export function noteToolCalls(
  sessions: readonly { id: string; busy?: boolean; blocks?: readonly ToolBlockLike[] }[],
  now: number = Date.now(),
): void {
  for (const session of sessions) {
    if (!session.busy || !session.blocks?.length) continue;
    let calls = seenCalls.get(session.id);
    if (!calls) {
      calls = new Map();
      seenCalls.set(session.id, calls);
      if (seenCalls.size > SEEN_SESSIONS) seenCalls.delete(seenCalls.keys().next().value!);
    }
    const blocks = session.blocks;
    for (let i = Math.max(0, blocks.length - RECENT_BLOCKS); i < blocks.length; i++) {
      const tool = blocks[i]!.tool;
      if (!tool) continue;
      const key = tool.callId ?? `#${i}`;
      const text = [tool.title, tool.detail, ...(tool.paths ?? [])].filter(Boolean).join("\n");
      const known = calls.get(key);
      if (!known) calls.set(key, { kind: tool.kind, text, at: now });
      else if (!known.text.includes(text)) calls.set(key, { ...known, kind: known.kind ?? tool.kind, text: `${known.text}\n${text}` });
    }
    while (calls.size > SEEN_CALLS) calls.delete(calls.keys().next().value!);
  }
}

export function resetToolCallsForTest(): void {
  seenCalls.clear();
}

function callsOf(sessionId: string): RunToolCall[] {
  return [...(seenCalls.get(sessionId)?.values() ?? []), ...(toolCallSource?.(sessionId) ?? [])];
}

// A command that writes, moves or deletes a file named SOUL.md: a redirect or tee into it, an in-place sed or perl,
// mv/rm/truncate/touch on it, cp onto it, or a script that opens a file to write or replaces one.
const SHELL_WRITES_SOUL = [
  />{1,2}\s*["']?[^\s"'|;&]*SOUL\.md/i,
  /\btee\b[^|;&]*SOUL\.md/i,
  /\b(?:sed|perl)\b[^|;&]*\s-\w*i\b[^|;&]*SOUL\.md/i,
  /\b(?:mv|rm|truncate|touch|install|ln)\b[^|;&]*SOUL\.md/i,
  /\bcp\b[^|;&]*SOUL\.md["']?\s*(?:$|[|;&])/im,
];
const SCRIPT_WRITES = /open\([^)]*,\s*(?:mode\s*=\s*)?["'][^"']*[wax+]|\.write\(|write_(?:text|bytes)\(|writeFile|appendFile|fs\.write|os\.(?:replace|rename|remove|unlink)\(|shutil\.(?:copy\w*|move)\(/;

/** A tool call that changed a file named SOUL.md (not one that only read, searched or listed it). */
export function callWritesSoul(call: RunToolCall): boolean {
  if (!/SOUL\.md/i.test(call.text)) return false;
  if (call.kind === "edit") return true;
  if (call.kind === "read" || call.kind === "search") return false;
  return SHELL_WRITES_SOUL.some((re) => re.test(call.text)) || SCRIPT_WRITES.test(call.text);
}

/**
 * A run whose tool calls wrote this Mono's soul: its id and SOUL.md in one call that writes it (Alfred's S19 case C,
 * a Hivra worker's python one-liner writing the Nibbii lead's SOUL.md). That run is an agent, whoever's it is. A run
 * that only read the soul (cat, rg, a Read) doesn't count, so Ash's edit made meanwhile is kept.
 */
export function runNamedSoul(
  run: Pick<RunWindow, "sessionId"> & Partial<Pick<RunWindow, "start">>,
  monoId: string,
  calls: (sessionId: string) => readonly RunToolCall[] = callsOf,
): boolean {
  // Only this run's own calls: one from an earlier turn of the same chat started before this run did.
  const inRun = (call: RunToolCall) => call.at == null || run.start == null || call.at >= run.start - TURN_SLACK_MS;
  return calls(run.sessionId).some((call) => inRun(call) && call.text.includes(monoId) && callWritesSoul(call));
}

/**
 * Whether a run could have been the one that changed this Mono's soul: a chat or worker of that same Mono, one
 * working inside that Mono's own home folder, or any run whose tool calls named that soul. Another Mono's chat that
 * was only running at the time doesn't count, so an edit made then is Ash's and is kept.
 */
export function runIsMonos(
  run: Pick<RunWindow, "sessionId" | "cwd"> & Partial<Pick<RunWindow, "start">>,
  monoId: string,
  texts?: (sessionId: string) => readonly RunToolCall[],
): boolean {
  if (chatMonoOwner(run.sessionId) === monoId) return true;
  if (runNamedSoul(run, monoId, texts)) return true;
  const cwd = run.cwd?.replace(/\/+$/, "");
  if (!cwd) return false;
  return monoHomeDirs().some((home) => {
    const dir = `${home.replace(/\/+$/, "")}/${monoId}`;
    return cwd === dir || cwd.startsWith(`${dir}/`);
  });
}

/** One Mono's soul, checked against the last one the app saved. */
export async function checkSoul(
  monoId: string,
  name: string,
  files: TamperFiles = { read: readAgentFile, write: writeAgentFile },
  running: (at: number) => RunWindow[] = (at) => runsAt(at),
  now: number = Date.now(),
  belongs: (run: RunWindow, monoId: string) => boolean = runIsMonos,
): Promise<SoulCheck> {
  const soul = await files.read(monoId, "SOUL.md");
  const saved = savedSoul(monoId);
  if (soul.text == null) return "skipped";
  if (!saved) {
    recordSavedSoul(monoId, soul.text, soul.hash, now);
    return "recorded";
  }
  if (soul.hash === saved.hash) return "unchanged";
  // Only the text matters (a hash format change, or the same text saved again, is no tamper).
  if (soul.text === saved.text) {
    recordSavedSoul(monoId, soul.text, soul.hash, now);
    return "unchanged";
  }
  const changedAt = soul.modifiedMs ?? now;
  // The app process's record of its chats' turns, as it stands now (it holds across a window reload).
  await refreshProcessRuns(now);
  // Only this Mono's own chats and workers, or one working in its home folder (another Mono's chat doesn't count).
  const runs = running(changedAt).filter((run) => belongs(run, monoId));
  if (runs.length) {
    // 1. The changed file, kept beside it in its memory (never lost).
    const note = changedSoulNote(changedAt);
    const existing = await files.read(monoId, note);
    if (existing.text !== soul.text) await files.write(monoId, note, soul.text, existing.hash);
    // 2. The last saved soul back, over the changed one only.
    await files.write(monoId, "SOUL.md", saved.text, soul.hash);
    const back = await files.read(monoId, "SOUL.md");
    if (back.text !== saved.text) return "skipped";
    recordSavedSoul(monoId, saved.text, back.hash, now);
    const kinds = runningKinds(runs, monoId);
    const { phrase, many } = runningPhrase(name, kinds);
    recordBotChange({
      id: `soul-put-back:${monoId}:${soul.hash}`,
      bot: name,
      day: "Today",
      line: putBackLine(name, kinds),
      now: "Changed from outside the app",
      after: "Back to the soul the app last saved",
      details: [
        `When it changed, ${phrase} ${many ? "were" : "was"} running.`,
        `The changed version is kept in ${name}'s memory, and "Keep that change" brings it back.`,
      ],
      undoLabel: "Keep that change",
      undoneText: `Kept the outside change to ${name}'s soul.`,
      monoId,
      file: "SOUL.md",
      beforeText: soul.text,
      afterText: saved.text,
      at: now,
    });
    return "put-back";
  }
  recordSavedSoul(monoId, soul.text, soul.hash, now);
  recordBotChange({
    id: `soul-outside:${monoId}:${soul.hash}`,
    bot: name,
    day: "Today",
    line: keptAshLine(name),
    now: "The soul the app last saved",
    after: "Your version",
    details: [`None of ${name}'s chats or workers was running when it changed, so it was you. Undo goes back to the soul the app last saved.`],
    undoneText: `Undone: ${name}'s soul is back to how the app last saved it.`,
    monoId,
    file: "SOUL.md",
    beforeText: saved.text,
    afterText: soul.text,
    at: now,
  });
  return "kept-ash";
}

/**
 * A portable restore wrote these Monos' souls (some from Rust, which the app's own save path never sees): each soul as
 * it now stands is the app's save, so no "edited outside the app" row appears and nothing is put back.
 */
export async function recordRestoredSouls(
  monoIds: readonly string[],
  files: Pick<TamperFiles, "read"> = { read: readAgentFile },
  now: number = Date.now(),
): Promise<void> {
  for (const id of new Set(monoIds)) {
    try {
      const soul = await files.read(id, "SOUL.md");
      if (soul.text != null) recordSavedSoul(id, soul.text, soul.hash, now);
    } catch {
      /* unreadable now: its next check records it, or treats it as Ash's */
    }
  }
}

/** Opening a Mono's files checks its soul first (monoFiles.ts readMonoFiles). */
export function watchSoulOpens(): void {
  setSoulOpenCheck(async (monoId) => {
    const mono = listMonos().find((m) => m.id === monoId);
    if (mono) await checkSoul(monoId, monoLook(mono).name);
  });
}

/** Every Mono's soul, before anything else reads them at launch. One that can't be read is checked next time. */
export async function checkSouls(
  monos: readonly { id: string; name?: string }[] = listMonos().map((m) => ({ id: m.id, name: monoLook(m).name })),
  files?: TamperFiles,
): Promise<Record<string, SoulCheck>> {
  const out: Record<string, SoulCheck> = {};
  for (const m of monos) {
    try {
      out[m.id] = await checkSoul(m.id, m.name?.trim() || m.id, files);
    } catch {
      /* moved or unreadable now: the next read checks it */
    }
  }
  return out;
}
