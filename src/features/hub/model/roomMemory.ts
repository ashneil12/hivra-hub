// A room belongs to a project (rooms are per project), so a seat's room turn starts on that project's memory: the same
// primer the project's Lead starts with (hubMemoryPrimer.ts, Ash OS `ash-hub-memory-primer`), so a reviewer checks the
// Lead's facts against memory instead of challenging them blind (20 Oct baseline). The leadership seats' own chats
// have no project (hubMcp.ts chatProjects), so nothing else gives it to them.
//
// It goes in once per conversation of the seat's chat: again when that chat starts a new conversation (rotated), when
// the memory changed, or when the turn that carried it never went in. Without a primer (Ash OS unreachable, or no such
// project) nothing is added and the seat reads memory as before.
import { fetchMemoryPrimer, memoryPrimerBlock } from "./hubMemoryPrimer";
import { hasAshOsTools } from "./hubMcp";

/** A room turn never waits longer than this for the primer (it is cached for a minute after the first read). */
export const ROOM_PRIMER_TIMEOUT_MS = 1_500;

/** Per seat chat: the conversation, project and memory it last read in a room turn. */
const read = new Map<string, string>();

export function forgetRoomMemory(): void {
  read.clear();
}

type Call = (action: string, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * The project's memory for a seat's room turn, or undefined when this conversation of its chat already has it (or there
 * is none). `delivered` marks it read once the turn has gone into the chat.
 */
export async function roomMemory(
  session: { id: string; providerSessionId?: string; harness: string },
  project: string,
  options: { call?: Call; timeoutMs?: number } = {},
): Promise<{ block: string; delivered: () => void } | undefined> {
  if (!project) return undefined;
  const primer = await fetchMemoryPrimer(project, { call: options.call, timeoutMs: options.timeoutMs ?? ROOM_PRIMER_TIMEOUT_MS });
  if (!primer) return undefined;
  const key = JSON.stringify([session.providerSessionId ?? "", project, primer.text]);
  if (read.get(session.id) === key) return undefined;
  const block = `This room is the ${project} project's. Its memory, the same its Lead starts with: check what the others say against it before you challenge them.\n${memoryPrimerBlock(project, primer, { tools: hasAshOsTools(session.harness), worker: false })}`;
  return { block, delivered: () => void read.set(session.id, key) };
}
