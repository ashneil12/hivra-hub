// On the engine a chat reaches another chat through the engine's own thread tools (t3_thread_send), not through the
// app's delegate tool, which the engine's agents do not have. What the Chief of Staff is told about its first mates
// there: each one's conversation, and how to hand a job over. And what a first mate is told once, when the app opens
// its conversation, so a job that arrives through the engine is worked the way a brief is.

/** A first mate as the Chief of Staff reaches it on the engine. */
export type EngineMate = {
  /** Its name, as the person knows it ("EXO lead"). */
  name: string;
  /** The project it leads, by name. */
  project: string;
  /** Its conversation in the engine. */
  threadId: string;
};

const MISSING = "This chat runs on Dropwave's new engine. The tools delegate_task, mono_message and the `app` command do not exist here, whatever your notes say; never call them.";

/** The Chief of Staff's note for a turn on the engine; nothing when it has no first mate to reach. */
export function engineMatesNote(mates: readonly EngineMate[]): string | undefined {
  if (!mates.length) return undefined;
  return [
    "<first_mates>",
    MISSING,
    "A project's work goes to its first mate. Each has one conversation in this engine:",
    ...mates.map((mate) => `- ${mate.name} (project ${mate.project}): threadId ${JSON.stringify(mate.threadId)}`),
    "To hand over a job, call t3_thread_send with that threadId and a message that holds the whole job: the person's own words, what done looks like, and what to report back. Then call t3_thread_wait on that thread for its answer and tell the person what came back, in your own words. Never start a new thread for a project that has a first mate, and never do a project's work yourself.",
    "</first_mates>",
  ].join("\n");
}

/** The request id of the app's one briefing turn in a first mate's conversation (kept on its block, so it goes in once). */
export function engineBriefingId(conversation: string): string {
  return `engine-briefing-${conversation}`;
}

/** How the briefing opens; the chat shows a turn that opens so as one small line of the app's (sessions/model/appNote.ts). */
export const ENGINE_BRIEFING_TAG = "[MonoCode briefing]";

/**
 * The first mate's briefing, sent by the app as the first turn of the conversation it opened: the turn hands the first
 * mate its soul and memory as every first turn does, and says how work reaches it here.
 */
export function engineMateBriefing(from: string): string {
  return [
    ENGINE_BRIEFING_TAG,
    MISSING,
    `${from} hands you work in this conversation through the engine: a message from it is a brief. Work it as your project's first mate: use your own subagents for the parts, check their work, then answer in this conversation with the outcome, the evidence (the commit, the check that ran, a screenshot or served URL) and what is not verified. Your answer is what goes back to ${from}.`,
    "Nothing to do yet. Reply with exactly: Ready.",
  ].join("\n");
}
