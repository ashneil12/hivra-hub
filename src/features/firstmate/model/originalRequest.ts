// Hivra WP-171: every worker brief quotes the person's own request.
//
// A brief is the first mate's summary of the ask, and summaries run thin: told to "write the page and match the
// requirements", a worker builds a marketing page instead of the game the person asked for. The request is the one
// text every part of a job has to agree with, so each brief carries a bounded, quoted copy of it, labelled as context
// with the worker's own task kept apart. `intent` still holds the first mate's fill of the ask; this is the raw words.
//
// Translated from Atomic Agent's src/tools/fusion/worker-prompt.ts (MIT, Copyright (c) 2026 Atomic Bot, commit
// 1b4e641525c5b1427b48ff6b8d9932dc26bd8256): the 16,000 character bound with a note saying what was cut, the 280
// character line between a request and a follow-up, and the rule that a short follow-up is quoted with the message it
// follows up. Changed for Hivra:
// - The request is read from the first mate's chat: the person's own messages, never what the app wrote on their
//   behalf (reports, wakes, notes, checks, hidden turns and drafts).
// - Every line of the quote starts with ">", so nothing in it can read as one of the brief's own headings, its finish
//   line or one of its tags, and the app's views can hide it with the rest of the template.
// - A follow-up is never cut off by a long earlier message: the earlier one gives way.
// - Not carried over: Atomic's rule that a stopped request is never merged or fallen back to. Hivra's transcript keeps no
//   mark of a turn the person stopped, so a short message after a stopped one is quoted with it.

/** How much of the request a brief quotes: about 4,000 tokens, a real spec with room to spare. */
export const ORIGINAL_REQUEST_CHAR_BUDGET = 16_000;

/** A message shorter than this reads as a follow-up ("continue", "the weekly one"), not as the request itself. */
export const FOLLOW_UP_MAX_CHARS = 280;

export const FOLLOW_UP_MARKER = "Follow-up from the person, after the message above:";

/** The part of a chat block this reads. */
export type RequestBlock = {
  role: string;
  text: string;
  internal?: boolean;
  draft?: boolean;
  monoSessionCompletion?: unknown;
  monoCheck?: unknown;
  monoNote?: unknown;
  monoHabit?: unknown;
};

/** The app starts the turns it writes itself with "[MonoCode " (a report, a wake, a question), so none is read as the person's. */
const APP_TURN = /^\[MonoCode /;

/** What the person said, oldest first: their own messages only. */
function personMessages(blocks: readonly RequestBlock[]): string[] {
  const said: string[] = [];
  for (const block of blocks) {
    if (block.role !== "user" || block.internal || block.draft) continue;
    if (block.monoSessionCompletion || block.monoCheck || block.monoNote || block.monoHabit) continue;
    const text = typeof block.text === "string" ? block.text.trim() : "";
    if (!text || APP_TURN.test(text)) continue;
    said.push(text);
  }
  return said;
}

/**
 * The request to quote: the person's latest message when it says enough on its own, otherwise (a short follow-up) the
 * message before it and then the follow-up. With no current message, the last thing the person said.
 */
export function pickOriginalRequest(input: { current: string; earlier: readonly string[] }): string | undefined {
  const previous = [...input.earlier].reverse().find((text) => text.trim())?.trim();
  const current = input.current.trim();
  if (!current) return previous;
  if (current.length >= FOLLOW_UP_MAX_CHARS || previous === undefined) return current;
  const tail = `\n\n${FOLLOW_UP_MARKER}\n${current}`;
  // The follow-up is the part that says what is wanted now: a long earlier message gives way to it.
  const room = ORIGINAL_REQUEST_CHAR_BUDGET - tail.length - 1;
  return `${previous.length > room ? `${previous.slice(0, Math.max(0, room))}…` : previous}${tail}`;
}

/** The request to quote in a brief sent from this chat, or undefined when the person has said nothing. */
export function originalRequestOf(blocks: readonly RequestBlock[] | undefined): string | undefined {
  const said = personMessages(blocks ?? []);
  if (!said.length) return undefined;
  return pickOriginalRequest({ current: said[said.length - 1], earlier: said.slice(0, -1) });
}

const count = (n: number) => n.toLocaleString("en-US");

/** The brief section's body: what the quote is for, then the request, every line behind ">", cut at the bound with a note. */
export function quoteOriginalRequest(request: string): string {
  const clipped = request.length > ORIGINAL_REQUEST_CHAR_BUDGET ? request.slice(0, ORIGINAL_REQUEST_CHAR_BUDGET) : request;
  const lines = [
    "Context only: your task is the Spec below. This is the person's own message, which the first mate split into tasks. Use it for the names, formats, constraints and look your part must agree with, and do only your own task. If it disagrees with your Spec, do what the Spec says and note the difference at the top of your report. Every line of the quote starts with \">\".",
    ...clipped.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")),
  ];
  if (clipped.length < request.length)
    lines.push(`(Cut here: the request is ${count(request.length)} characters and only the first ${count(ORIGINAL_REQUEST_CHAR_BUDGET)} are quoted.)`);
  return lines.join("\n");
}
