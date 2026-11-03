// The memory a project's Lead and its workers start with (Ash, 19 Oct: agents have global and per-project memory; a
// project never reads another project's memory). Ash OS used to compose a primer of it; that service is retired with
// the bridge (WP-04), so there is no composed primer by default and the block says where the memory files are. The app
// puts it ahead of a Lead's fresh conversation (a new or rotated session: monoFiles.ts `projectMemory`) and in a
// worker's brief (agentAppTasks.ts). A caller that has a primer source passes `call` (WP-51's memory curator).
//
// A chat's project is its ASH_PROJECT (hubMcp.ts chatProjects): a Lead's own, inherited by its workers. The leadership
// team, other Monos and plain chats have none and get no primer: they read memory as before.
import { chatProjects, hasMemoryTools } from "./hubMcp";
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
  /** The chat has memory tools (ash_recall, ash_remember): it can search further itself. */
  tools: boolean;
  /** A worker reports what Ash decides to whoever briefed it; a Lead saves it with ash_remember (r76: his answer to its own question too). */
  worker: boolean;
};

/**
 * The block a session reads: the primer and what to do for more. Without a primer it says how to read the memory
 * instead.
 */
export function memoryPrimerBlock(project: string, primer: MemoryPrimer | undefined, reader: PrimerReader): string {
  const folder = primer?.memory_dir ?? `~/agent-memory/${project}`;
  const own = forUser`You read and write only ${project}'s memory and Ash's global memory (ash); never another project's.`;
  if (!primer) {
    return forUser`<project_memory>\nBefore you act, read ${project}'s memory: ${
      reader.tools
        ? forUser`ash_recall with project "${project}" (its current decisions and never-do rules, plus Ash's global ones).`
        : `${folder}/MEMORY.md and ~/agent-memory/ash/MEMORY.md.`
    } ${own}\n</project_memory>`;
  }
  const more = reader.tools
    ? forUser`For anything not here (older lines, what Ash said, what changed and when), search with ash_recall: a query, project "${project}". ${own}${
        reader.worker ? "" : forUser(" Save to it with ash_remember at once when Ash makes a call: he answers a question you asked him, or says remember, lock or from now on (project ash only for how Ash works in every project). A half-made or contested thought stays unsaved.")
      }`
    : forUser`For more, read never.md and decisions.md in ${folder}. ${own}`;
  return forUser`<project_memory>\nThis was loaded at the start of this conversation: what holds now for ${primer.name ?? project} and how Ash works. Ash's latest words beat it; it beats the code, docs and plans. Act on it without repeating it back.${
    reader.worker ? forUser(" Anything Ash decides while you work goes in your report to whoever briefed you.") : ""
  }\n\n${primer.text.trim()}\n\n${more}\n</project_memory>`;
}

/**
 * A Lead's fresh conversation (monoFiles.ts `projectMemory`): its project's primer, or undefined for a chat with no
 * project (the leadership team, other Monos).
 */
export async function leadMemoryBlock(
  sessionId: string,
  harness: string,
  options: { call?: Call } = {},
): Promise<string | undefined> {
  const [project] = chatProjects(sessionId);
  if (!project) return undefined;
  const primer = await fetchMemoryPrimer(project, options);
  return memoryPrimerBlock(project, primer, { tools: hasMemoryTools(harness), worker: false });
}

/**
 * A worker's brief (agentAppTasks.ts): the project of the chat that delegates it (a worker inherits its Lead's,
 * hubMcp.ts), on the worker's own engine. Undefined when that chat has no project.
 */
export async function workerMemoryBlock(
  ownerSessionId: string,
  harness: string,
  options: { call?: Call } = {},
): Promise<string | undefined> {
  const [project] = chatProjects(ownerSessionId);
  if (!project) return undefined;
  const primer = await fetchMemoryPrimer(project, options);
  return memoryPrimerBlock(project, primer, { tools: hasMemoryTools(harness), worker: true });
}
