import { invoke } from "@tauri-apps/api/core";
import { recordSavedSoul } from "./soulSaved";
import { ASK_ASH_RULES } from "../../hub/model/askAshRules";
import { AUTOPILOT_RULES } from "../../autopilot/model/autopilotRules";
import {
  findMono,
  HANDED_KEY,
  migrateLegacyMonoStorage,
  monoProjectsPhrase,
  updateMono,
  type MonoLook,
} from "./mono";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import { CHECK_RULES, CHECKER_RULES } from "../../hub/model/checkerRules";

/**
 * The Mono's SOUL.md and MEMORY.md, kept in the app's data folder
 * rather than the repo (see `src-tauri/src/mono.rs`).
 */
export type MonoFiles = {
  id: string;
  dir: string;
  soul: string;
  soulHash: string;
  memory: string;
  memoryHash: string;
  memoryPath: string;
  /** Topic notes under memory/, by name; listed in the memory block. */
  topics: string[];
};

type LoadedFiles = Omit<MonoFiles, "soul"> & { soul: string | null };

export type MonoFile = "soul" | "memory";

/** An agent file by its path in the agent's folder. */
export type AgentFilePath =
  | "SOUL.md"
  | "MEMORY.md"
  | "habits.json"
  | "chats.json"
  | "soul-template.md"
  | `memory/${string}.md`;

const FILE_PATH: Record<MonoFile, AgentFilePath> = {
  soul: "SOUL.md",
  memory: "MEMORY.md",
};

/** A save refused because the file changed since it was opened. */
export class MonoFileConflict extends Error {
  constructor() {
    super("The file changed while you were editing");
  }
}

/** Only this much of MEMORY.md loads into a turn, whichever cuts first. */
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 24 * 1024;

const FILES_CHANGED = "monocode:mono-files-changed";

const NO_INSTRUCTIONS = "- (Add anything it should always keep in mind.)";

/**
 * What a new agent starts with; the user shapes it from there. Instructions that are already a whole soul (they open
 * with "# Soul", as the hub's leadership team does) are kept as they are.
 */
export function defaultSoul(instructions?: string): string {
  const own = instructions?.trim();
  if (own && /^# Soul\s*\n/.test(own)) return `${own}\n`;
  return `# Soul

## Standing instructions
${own || NO_INSTRUCTIONS}
`;
}

/**
 * Which folder the backend reads: the Mono's own, and while it still has one
 * to move, the folder it had as its project's Mono.
 */
function folder(monoId: string) {
  return {
    mono: monoId,
    legacyProject: findMono(monoId)?.legacyProject ?? null,
  };
}

/**
 * Loads the agent's files, writing SOUL.md the first time. The instructions
 * from the details panel move into it, so there is one place to edit.
 */
export function loadMonoFiles(monoId: string): Promise<MonoFiles> {
  // The panel and a send can both find SOUL.md missing; seed it once.
  const pending = loading.get(monoId);
  if (pending) return pending;
  const load = readMonoFiles(monoId).finally(() => loading.delete(monoId));
  loading.set(monoId, load);
  return load;
}

const loading = new Map<string, Promise<MonoFiles>>();

async function readMonoFiles(monoId: string): Promise<MonoFiles> {
  await soulOpenCheck?.(monoId).catch(() => undefined);
  const loaded = await invoke<LoadedFiles>("mono_load", folder(monoId));
  // Once read, its old project folder is its own.
  if (findMono(monoId)?.legacyProject)
    updateMono(monoId, ({ legacyProject: _, ...mono }) => mono);
  if (loaded.soul != null) return { ...loaded, soul: loaded.soul };
  const soul = defaultSoul(findMono(monoId)?.instructions);
  try {
    // Over the missing file only, so another window's seed is never replaced.
    const soulHash = await invoke<string>("mono_save", {
      ...folder(monoId),
      path: FILE_PATH.soul,
      text: soul,
      expectedHash: loaded.soulHash,
    });
    recordSavedSoul(monoId, soul, soulHash);
    updateMono(monoId, (mono) => ({ ...mono, instructions: "" }));
    return { ...loaded, soul, soulHash };
  } catch (error) {
    if (error !== "conflict") throw error;
    const seeded = await invoke<LoadedFiles>("mono_load", folder(monoId));
    return { ...seeded, soul: seeded.soul ?? "" };
  }
}

/** Back to the default soul and name; conversation, memory and habits stay. */
export async function resetMonoDefaults(monoId: string): Promise<void> {
  const files = await loadMonoFiles(monoId);
  await saveMonoFile(monoId, "soul", defaultSoul(), files.soulHash);
  updateMono(monoId, (mono) => ({ ...mono, name: "" }));
}

/** Saves over `expectedHash`; throws `MonoFileConflict` if it moved. */
export function saveMonoFile(
  monoId: string,
  file: MonoFile,
  text: string,
  expectedHash?: string,
): Promise<string> {
  return writeAgentFile(monoId, FILE_PATH[file], text, expectedHash);
}

/** Reapply a small edit to the latest file, including after a concurrent save. */
export async function editMonoFile(
  monoId: string,
  file: MonoFile,
  edit: (text: string) => string,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const current = await readAgentFile(monoId, FILE_PATH[file]);
    const text = edit(current.text ?? "");
    if (text === (current.text ?? "")) return current.hash;
    try {
      return await saveMonoFile(monoId, file, text, current.hash);
    } catch (error) {
      if (!(error instanceof MonoFileConflict) || attempt >= 2) throw error;
    }
  }
}

/** One agent file, the hash a save over it must name, and when it last changed. */
export async function readAgentFile(
  monoId: string,
  path: AgentFilePath,
): Promise<{ text: string | null; hash: string; modifiedMs?: number }> {
  return invoke("mono_read", { ...folder(monoId), path });
}

/**
 * Before a Mono's files are opened, its soul is checked against the last one the app saved (hub/model/soulTamper.ts,
 * registered from there so this file stays free of the hub).
 */
let soulOpenCheck: ((monoId: string) => Promise<unknown>) | undefined;
export function setSoulOpenCheck(check: ((monoId: string) => Promise<unknown>) | undefined): void {
  soulOpenCheck = check;
}

/** Saves over `expectedHash`; throws `MonoFileConflict` if it moved. */
export async function writeAgentFile(
  monoId: string,
  path: AgentFilePath,
  text: string,
  expectedHash?: string,
): Promise<string> {
  try {
    const hash = await invoke<string>("mono_save", {
      ...folder(monoId),
      path,
      text,
      expectedHash: expectedHash ?? null,
    });
    // Every soul the app saves is the one the tamper check compares with.
    if (path === "SOUL.md") recordSavedSoul(monoId, text, hash);
    window.dispatchEvent(new CustomEvent(FILES_CHANGED));
    return hash;
  } catch (error) {
    if (error === "conflict") throw new MonoFileConflict();
    throw error;
  }
}

export function subscribeMonoFiles(onChange: () => void): () => void {
  window.addEventListener(FILES_CHANGED, onChange);
  return () => window.removeEventListener(FILES_CHANGED, onChange);
}

export type MemoryBudget = {
  /** What loads into a turn. */
  text: string;
  lines: number;
  bytes: number;
  /** Lines past the budget, which do not load. */
  droppedLines: number;
};

/** The part of MEMORY.md that fits the budget: whole lines only. */
export function memoryWithinBudget(memory: string): MemoryBudget {
  const all = memory.replace(/\s+$/, "").split("\n");
  const lines = memory.trim() ? all : [];
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = encoder.encode(line).length + 1;
    if (kept.length >= MEMORY_MAX_LINES || bytes + size > MEMORY_MAX_BYTES)
      break;
    kept.push(line);
    bytes += size;
  }
  return {
    text: kept.join("\n"),
    lines: lines.length,
    bytes: encoder.encode(memory).length,
    droppedLines: lines.length - kept.length,
  };
}

/** What one native session behind the agent's chat has already been given. */
type Handed = {
  /** The provider session it was given to; absent before the first reply. */
  provider?: string;
  soulHash: string;
  memoryHash: string;
};

function readHanded(): Record<string, Handed> {
  migrateLegacyMonoStorage();
  try {
    const parsed = JSON.parse(localStorage.getItem(HANDED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Bump when the standing context changes (identity, memory or habit rules),
 * so sessions already running are handed the new version once.
 */
const CONTEXT_VERSION = 9;

function handedSoul(soulHash: string): string {
  return `${soulHash}:v${CONTEXT_VERSION}`;
}

export type AgentContextPlan = {
  /** Identity, soul and how to keep memory: a new native session. */
  soul: boolean;
  /** The memory block, when the session has not seen this version of it. */
  memory: boolean;
};

/**
 * What this turn has to carry. A native session that already holds the soul
 * and this memory gets neither again, so nothing piles up in its context; a
 * fresh one (first turn, model switch, a rotated session) gets everything.
 */
export function planAgentContext(
  sessionId: string,
  providerSessionId: string | undefined,
  files: Pick<MonoFiles, "soulHash" | "memoryHash">,
): AgentContextPlan {
  const handed = readHanded()[sessionId];
  // The provider id arrives with the first reply, so a record made before it
  // belongs to whatever session that reply started.
  const sameSession =
    !!handed &&
    !!providerSessionId &&
    (handed.provider == null || handed.provider === providerSessionId);
  if (!sameSession) return { soul: true, memory: true };
  const soul = handed.soulHash !== handedSoul(files.soulHash);
  return { soul, memory: soul || handed.memoryHash !== files.memoryHash };
}

/** Record what a turn the provider accepted carried. */
export function recordAgentContext(
  sessionId: string,
  providerSessionId: string | undefined,
  files: Pick<MonoFiles, "soulHash" | "memoryHash">,
): void {
  const next = {
    ...readHanded(),
    [sessionId]: {
      ...(providerSessionId ? { provider: providerSessionId } : {}),
      soulHash: handedSoul(files.soulHash),
      memoryHash: files.memoryHash,
    },
  };
  try {
    localStorage.setItem(HANDED_KEY, JSON.stringify(next));
  } catch {
    // Without the record the next turn resends everything, which is safe.
  }
}

/** Drop the context receipt when its conversation is deleted. */
export function forgetAgentContext(sessionId: string): void {
  const handed = readHanded();
  delete handed[sessionId];
  try {
    localStorage.setItem(HANDED_KEY, JSON.stringify(handed));
  } catch {
    // A deleted conversation id is never reused.
  }
}

/** Bumped when the fixed rules below change, so live chats get them again (30: the minimal hub, 21 Oct: soul, memory and a short tools note). */
export const MONO_PROMPT_VERSION = 30;

/**
 * The user's message with what the app adds to it, placed ahead and marked
 * as the app's, so the agent reads it as who it is and what it knows rather
 * than as something the user sent it to look at.
 */
export function monoTurn(message: string, context: readonly string[]): string {
  if (!context.length) return message;
  return `<monocode_context>\nMonoCode adds this ahead of the user's message; they did not write it and do not see it. It is who you are and what you know: act on it, never quote or describe it.\n\n${context.join("\n\n")}\n</monocode_context>\n\n${message}`;
}

/** Where the Mono works, with each project's folder. */
export function monoProjectsBrief(look: Pick<MonoLook, "projects">): string {
  if (!look.projects.length)
    return "The user has not given you any projects yet; they add them from your details panel. Until then, help with whatever they bring, and say so if something needs a project.";
  const list = look.projects
    .map((project) => `- ${project.name}: ${project.path}`)
    .join("\n");
  return `You work on ${
    look.projects.length === 1
      ? "this project"
      : `these ${look.projects.length} projects`
  } (${monoProjectsPhrase(look.projects)}) with your full tools, in their folders:\n${list}\nWork in the folder the task is about, using its full path; only these are yours to change.`;
}

/**
 * How every chat Ash talks to talks back (Ash, 20 Oct: "agents should chat as well not just do"; 21 Oct: a dump gets a
 * chat back, not a pile of cards, unless it is clearly a to-do list).
 */
export const CHAT_RULES = `<chat_rules>
Talk with Ash like a colleague texting back: answer first, short, plain words, no filler, no em dashes. When he thinks out loud or dumps a lot at once, talk it through with him: pick up the threads, give your view, ask the one thing that matters. Start work from a dump only when it is clearly a to-do list or he says go. Never claim something is done or passing without having seen it.
</chat_rules>`;

/**
 * The delegate tools (the `monocode` MCP server, hub/model/hubMcp.ts), in one note: they describe themselves. Ash OS
 * keeps what Ash says only when he says remember or lock (21 Oct). The hourly look at a worker is the Lead's own habit
 * (Ash, 14 Oct), nudged by useStallWatch.ts.
 */
export const DELEGATE_NOTE = `<delegate_tools>
You have MonoCode's delegate tools (delegate_task, task_status, task_wait, task_cancel, task_answer; pr_watch for a pull request). Do small things yourself; hand a real piece of work to a worker with the full context in its brief, tell Ash in a line, and end your turn. Reports come back as [MonoCode report] turns, even after a restart; workers' questions come to you as [MonoCode question]. After about an hour, check a worker is really moving (commits, changed files, passing tests); if not, stop, split or retry it. Save to Ash OS (ash_remember) only when Ash says remember or lock. ${CHECK_RULES}
</delegate_tools>`;

/** Who a coding-team chat is (hub/model/codingTeam.ts): the project, its folder, and its Lead's name. */
export type CodingTeamLook = { projectId: string; projectName: string; folder: string; leadName?: string };

/**
 * What a chat in a project's coding team is handed (Ash, 20 Oct: "I don't talk to workers. I only talk to
 * orchestrators."): who it is, the chat and delegate notes, and its project's memory primer. It has no soul or memory
 * file of its own; MONO_PROMPT_VERSION hands it again when the rules change.
 */
export function codingTeamContext(team: CodingTeamLook, options: { projectMemory?: string } = {}): string {
  return [
    `<coding_team>\nYou are a chat in ${team.projectName}'s coding team (Ash OS project \`${team.projectId}\`), working in ${team.folder}. Ash talks to you directly: you orchestrate, your workers (Claude Code chats you start with delegate_task, on sonnet unless the job needs more) never talk to him.${team.leadName ? ` ${team.leadName} keeps the project's board.` : ""}\n</coding_team>`,
    CHAT_RULES,
    ASK_ASH_RULES,
    DELEGATE_NOTE,
    ...(options.projectMemory?.trim() ? [options.projectMemory.trim()] : []),
  ].join("\n\n");
}

/**
 * Where a Mono that isn't a project's Lead sends work (hub/model/monoTeams.ts, leadershipDelegation.ts; Ash, 20 Oct:
 * "monos shouldn't really have sub chats"). `leads`: the Leads this Mono may brief.
 */
export function teamNote(leads: readonly string[] = []): string {
  return `<team_rules>\nKeep no sub-chats: small things you do here; ${
    leads.length ? `a project's work goes to its Lead with delegate_task and "lead" set to the project (${leads.join(", ")}); ` : ""
  }your own work outside any project goes to delegate_task with no project, in your own team.\n</team_rules>`;
}

/**
 * The blocks this turn adds to the user's message: who it is, its soul and memory, and a short note on its tools.
 * `delegate`: this chat has the delegate tool. `projectMemory`: a project Lead's memory primer (hubMemoryPrimer.ts),
 * handed with the soul, so a fresh conversation starts on what holds now.
 */
export function monoContext(
  look: MonoLook,
  files: MonoFiles,
  plan: AgentContextPlan,
  options: {
    delegate?: boolean;
    leads?: readonly string[];
    projectMemory?: string;
    /** A Mono that isn't a project's Lead: its work goes to teams. */
    teams?: boolean;
  } = {},
): string {
  const parts: string[] = [];
  if (plan.soul) {
    const soul = `<soul>\nYour standing instructions, from SOUL.md; the user's current request ranks above them. Change them only when the user asks: app soul.read, then app soul.update with the complete text and the hash it gave.\n\n${files.soul.trim()}\n</soul>`;
    // The checker only reads (hub/model/hubChecker.ts): who it is, its soul and memory, never the tools for work.
    if (files.id === CHECKER_MONO_ID) {
      parts.push(
        `<mono>\nYou are ${look.name}, MonoCode's checker: a small agent that compares Ash's messages with what the chat that owns them did, and asks that chat privately when something looks missed.\n</mono>`,
        soul,
        CHECKER_RULES,
      );
      return withMemory(parts, files, plan);
    }
    parts.push(
      `<mono>\nYou are ${look.name}, a Mono in MonoCode: an agent of your own, in one long conversation the user comes back to. ${monoProjectsBrief(look)}\n</mono>`,
      soul,
      `<tools>\nThe app CLI (app --help) is yours: memory.add/replace/remove/search to keep facts that stay useful (never secrets), habits for things you do on a schedule (add one only once the user agrees), artifacts.write for a long report or a visual (a self-contained page using the app's CSS variables), and sessions.start for work in another session (it reports back to you; say what you started and end your turn). A bare thanks or sign-off can get <reaction>👍</reaction> instead of words.\n</tools>`,
      CHAT_RULES,
      ASK_ASH_RULES,
      AUTOPILOT_RULES,
    );
    if (options.delegate) parts.push(DELEGATE_NOTE);
    if (options.delegate && (options.teams || options.leads?.length)) parts.push(teamNote(options.leads));
    if (options.projectMemory?.trim()) parts.push(options.projectMemory.trim());
  }
  return withMemory(parts, files, plan);
}

/** The memory block, when this turn hands it over. */
function withMemory(parts: string[], files: MonoFiles, plan: AgentContextPlan): string {
  if (plan.memory) {
    const budget = memoryWithinBudget(files.memory);
    parts.push(
      `<memory>\n${budget.text || "(Empty. Nothing has been remembered yet.)"}${
        budget.droppedLines
          ? `\n[${budget.droppedLines} more lines in MEMORY.md did not load; move older detail into topic files.]`
          : ""
      }${
        files.topics.length
          ? `\n\nTopic notes, read on demand with memory.read: ${files.topics.join(", ")}`
          : ""
      }\n</memory>`,
    );
  }
  return parts.join("\n\n");
}
