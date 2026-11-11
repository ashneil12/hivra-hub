// The memory a project's Lead and its workers start with (Ash, 19 Oct: agents have global and per-project memory; a
// project never reads another project's memory). Ash OS used to compose a primer of it; that service is retired with
// the bridge (WP-04), so there is no composed primer by default and the block says where the memory files are. The app
// puts it ahead of a Lead's fresh conversation (a new or rotated session: monoFiles.ts `projectMemory`) and in a
// worker's brief (agentAppTasks.ts). A caller that has a primer source passes `call` (WP-51's memory curator).
//
// A chat's project is its ASH_PROJECT (hubMcp.ts chatProjects): a Lead's own, inherited by its workers. The leadership
// team, other Monos and plain chats have none and get no primer: they read memory as before.
import { moreMemoryLead, primerSaveClause, projectLabel, projectMemoryDirs, readMemorySentence } from "./agentMemoryPath";
import { chatProjects } from "./hubMcp";
import { forUser } from "./userName";

/** A composed primer (the shape Ash OS used to answer). */
export type MemoryPrimer = {
  project: string;
  name?: string;
  text: string;
  lines?: number;
  more?: number;
  memory_dir?: string;
  global_dir?: string;
};

type Call = (action: string, payload: Record<string, unknown>) => Promise<unknown>;

/** Primers are read again after this long, so a fresh session never starts on an old copy. */
export const PRIMER_TTL_MS = 60_000;
/** A send never waits longer than this for it: without one the block says how to read the memory instead. */
export const PRIMER_TIMEOUT_MS = 4_000;

const cache = new Map<string, { at: number; primer: MemoryPrimer }>();
const pending = new Map<string, Promise<MemoryPrimer | undefined>>();

/** Forget every cached primer (tests; a project's memory Ash just changed is re-read within the TTL anyway). */
export function forgetMemoryPrimers(): void {
  cache.clear();
  pending.clear();
}

function isPrimer(value: unknown): value is MemoryPrimer {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as MemoryPrimer).text === "string" &&
    typeof (value as MemoryPrimer).project === "string"
  );
}

/**
 * The primer for one project from `call`: cached for PRIMER_TTL_MS, one call at a time per project, and undefined
 * without a source, when it doesn't answer in PRIMER_TIMEOUT_MS, or answers something else.
 */
export async function fetchMemoryPrimer(
  project: string,
  options: { call?: Call; now?: () => number; timeoutMs?: number } = {},
): Promise<MemoryPrimer | undefined> {
  const now = options.now ?? Date.now;
  const hit = cache.get(project);
  if (hit && now() - hit.at < PRIMER_TTL_MS) return hit.primer;
  const inflight = pending.get(project);
  if (inflight) return inflight;
  const call = options.call;
  if (!call) return undefined;
  const read = (async () => {
    try {
      const answer = await Promise.race([
        call("memory-primer", { project }),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), options.timeoutMs ?? PRIMER_TIMEOUT_MS)),
      ]);
      if (!isPrimer(answer) || !answer.text.trim()) return undefined;
      cache.set(project, { at: now(), primer: answer });
      return answer;
    } catch {
      return undefined;
    } finally {
      pending.delete(project);
    }
  })();
  pending.set(project, read);
  return read;
}

export type PrimerReader = {
  /** A worker reports what Ash decides to whoever briefed it; a Lead saves it in the memory files (r76: his answer to its own question too). */
  worker: boolean;
};

/**
 * The block a session reads: the primer and what to do for more. Without a primer it says how to read the memory
 * instead. The folder is this copy's own (agentMemoryPath.ts), never "~/agent-memory". A chat that has the memory
 * tool (the real bench) is told the tool first and the file second; every other chat just gets the file.
 */
export function memoryPrimerBlock(project: string, primer: MemoryPrimer | undefined, reader: PrimerReader): string {
  const dirs = projectMemoryDirs(project, primer);
  const id = projectLabel(project);
  const title = primer?.name && !/[/\\]|\.\./.test(primer.name) ? primer.name : id;
  const own = forUser`You read and write only ${id}'s memory and Ash's global memory (ash); never another project's.`;
  if (!primer) {
    return forUser`<project_memory>\n${readMemorySentence(project, dirs)} ${own}\n</project_memory>`;
  }
  const more = forUser`${moreMemoryLead(dirs)} ${own}${reader.worker ? "" : primerSaveClause(project, dirs)}`;
  return forUser`<project_memory>\nThis was loaded at the start of this conversation: what holds now for ${title} and how Ash works. Ash's latest words beat it; it beats the code, docs and plans. Act on it without repeating it back.${
    reader.worker ? forUser(" Anything Ash decides while you work goes in your report to whoever briefed you.") : ""
  }\n\n${primer.text.trim()}\n\n${more}\n</project_memory>`;
}

/**
 * A Lead's fresh conversation (monoFiles.ts `projectMemory`): its project's primer, or undefined for a chat with no
 * project (the leadership team, other Monos).
 */
export async function leadMemoryBlock(
  sessionId: string,
  _harness: string,
  options: { call?: Call } = {},
): Promise<string | undefined> {
  const [project] = chatProjects(sessionId);
  if (!project) return undefined;
  const primer = await fetchMemoryPrimer(project, options);
  return memoryPrimerBlock(project, primer, { worker: false });
}

/**
 * WP-156: a project's standing answers for a fresh conversation (monoFiles.ts `standingAnswers`), read for the chat's own
 * project (the same one the memory primer reads). `read` asks the app (`decisions_standing_brief`), which answers ""
 * while standing answers are off, so the note stays as it was. The app filters protected keys and caps the rows.
 * Undefined: no project, nothing active, or the setting is off. A failed read rejects; the caller leaves the note as it was.
 */
export async function leadStandingBlock(
  sessionId: string,
  read: (project: string) => Promise<unknown>,
): Promise<string | undefined> {
  const [project] = chatProjects(sessionId);
  if (!project) return undefined;
  const value = await read(project);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A worker's brief (agentAppTasks.ts): the project of the chat that delegates it (a worker inherits its Lead's,
 * hubMcp.ts), on the worker's own engine. Undefined when that chat has no project.
 */
export async function workerMemoryBlock(
  ownerSessionId: string,
  _harness: string,
  options: { call?: Call } = {},
): Promise<string | undefined> {
  const [project] = chatProjects(ownerSessionId);
  if (!project) return undefined;
  const primer = await fetchMemoryPrimer(project, options);
  return memoryPrimerBlock(project, primer, { worker: true });
}
