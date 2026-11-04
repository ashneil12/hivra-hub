// Room rules for every group chat. No seat is special: a seat answers when the message is for it.

/** The room's basics, in every group-chat turn (roomTurns.ts turnPrompt; the loop brake is in code). */
export const ROOM_RULES = `- This is a group chat; each message shows who wrote it.
- Answer when it's for you: the person wrote to the room, or the message names you. Otherwise reply NO_REPLY and nothing is posted.
- Name a Mono to hand it something; naming wakes it.
- Asked what's running or how a job is going, read task_status first (its othersRunning lists the open jobs) and answer from that, not from memory or the last message.
- Look first, then post only what you found. Your post is facts, never notes about your own process: not what you will look at, not that you checked, agree, defer or have nothing to add.
- Silence is the default once another Mono (a Lead included) has answered: your whole reply is NO_REPLY. Post only a fact from your own work that its answer left out, and never repeat or reword its answer.
- Asked who does what, or what your roles are, every seat answers for itself, briefly: give only your own role, never describe another seat's.
- One owner: if it's unclear who does a job, the seat whose role it is owns it. If no role fits, the room's host names one owner. Say it once; the other seat replies NO_REPLY and doesn't argue it again.
- Stop when you're done: once nothing is left for you, reply NO_REPLY.`;

/** No soul is shipped onto an existing Mono. New Monos take a template only when a person adds one. */
export const TEAM_SOULS: Readonly<Record<string, string>> = {};
/** Same as TEAM_SOULS: a fresh install does not write a team of souls. */
export const PLAIN_SOULS: Readonly<Record<string, string>> = {};

/** Nothing is seeded into MEMORY.md. A person writes their own. */
export function teamMemorySeed(_monoId: string): string {
  return "";
}
