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
//   behalf (reports, wakes, notes, checks, hidden turns and drafts). The current turn has to be the person's. A room
//   post, a wake, or any other turn the person did not just write quotes nothing, not an older message.
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

function blockText(block: RequestBlock): string {
  return typeof block.text === "string" ? block.text.trim() : "";
}

/** A message the person wrote themselves. */
function isPersonMessage(block: RequestBlock): boolean {
  if (block.role !== "user" || block.internal || block.draft) return false;
  if (block.monoSessionCompletion || block.monoCheck || block.monoNote || block.monoHabit) return false;
  const text = blockText(block);
  return text.length > 0 && !APP_TURN.test(text);
}

/** The latest user turn that was sent. A draft still being typed is not one. */
function currentTurn(blocks: readonly RequestBlock[]): RequestBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role !== "user" || block.draft) continue;
    if (!blockText(block) && !block.monoNote && !block.monoCheck && !block.monoSessionCompletion && !block.monoHabit) continue;
    return block;
  }
  return undefined;
}

/** What the person said, oldest first: their own messages only. */
function personMessages(blocks: readonly RequestBlock[]): string[] {
  const said: string[] = [];
  for (const block of blocks) if (isPersonMessage(block)) said.push(blockText(block));
  return said;
}

/**
 * The request to quote: the person's latest message when it says enough on its own, otherwise (a short follow-up) the
 * message before it and then the follow-up. With no current message, the last thing the person said. A request past
 * the quote budget is cut here, at the first read; {@link readOriginalRequest} keeps the length for the cut note.
 */
function selectRequest(input: { current: string; earlier: readonly string[] }): string | undefined {
  const previous = [...input.earlier].reverse().find((text) => text.trim())?.trim();
  const current = input.current.trim();
  if (!current) return previous;
  if (current.length >= FOLLOW_UP_MAX_CHARS || previous === undefined) return current;
  const tail = `\n\n${FOLLOW_UP_MARKER}\n${current}`;
  // The follow-up is the part that says what is wanted now: a long earlier message gives way to it.
  const room = ORIGINAL_REQUEST_CHAR_BUDGET - tail.length - 1;
  return `${previous.length > room ? `${previous.slice(0, Math.max(0, room))}…` : previous}${tail}`;
}

/** The words a brief can carry: at most the quote budget. `chars` is how long the request was before the cut. */
export function boundRequest(text: string, knownChars?: number): { text: string; chars: number } {
  const trimmed = text.trim();
  const known =
    typeof knownChars === "number" && Number.isFinite(knownChars) ? Math.max(0, Math.floor(knownChars)) : undefined;
  const chars = known !== undefined && known >= trimmed.length ? known : trimmed.length;
  const body =
    trimmed.length > ORIGINAL_REQUEST_CHAR_BUDGET ? trimmed.slice(0, ORIGINAL_REQUEST_CHAR_BUDGET) : trimmed;
  return { text: body, chars };
}

export function pickOriginalRequest(input: { current: string; earlier: readonly string[] }): string | undefined {
  const full = selectRequest(input);
  if (full === undefined) return undefined;
  return full.length > ORIGINAL_REQUEST_CHAR_BUDGET ? full.slice(0, ORIGINAL_REQUEST_CHAR_BUDGET) : full;
}

/**
 * The request to quote in a brief sent from this chat, cut to the quote budget, or undefined when the person has
 * said nothing. `chars` is the length before the cut, so the brief can say what was left out.
 */
export function readOriginalRequest(
  blocks: readonly RequestBlock[] | undefined,
): { text: string; chars: number } | undefined {
  const list = blocks ?? [];
  // The turn this brief is answering. A room post or a wake is not the person's request, even when they wrote one earlier.
  const current = currentTurn(list);
  if (!current || !isPersonMessage(current)) return undefined;
  const said = personMessages(list);
  if (!said.length) return undefined;
  const full = selectRequest({ current: said[said.length - 1], earlier: said.slice(0, -1) });
  if (!full) return undefined;
  return boundRequest(full);
}

/** The request's words, or undefined when the person has said nothing. */
export function originalRequestOf(blocks: readonly RequestBlock[] | undefined): string | undefined {
  return readOriginalRequest(blocks)?.text;
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * The brief section's body: what the quote is for, then the request, every line behind ">", cut at the bound with a
 * note. `chars` is how long the request was before it was cut at the first read; without it, the length is this text's.
 */
export function quoteOriginalRequest(request: string, chars?: number): string {
  const clipped = request.length > ORIGINAL_REQUEST_CHAR_BUDGET ? request.slice(0, ORIGINAL_REQUEST_CHAR_BUDGET) : request;
  const known = typeof chars === "number" && Number.isFinite(chars) ? Math.max(0, Math.floor(chars)) : request.length;
  const full = known > clipped.length ? known : request.length;
  const lines = [
    "Context only: your task is the Spec below. This is the person's own message, which the first mate split into tasks. Use it for the names, formats, constraints and look your part must agree with, and do only your own task. If it disagrees with your Spec, do what the Spec says and note the difference at the top of your report. Every line of the quote starts with \">\".",
    ...clipped.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")),
  ];
  if (clipped.length < full)
    lines.push(`(Cut here: the request is ${count(full)} characters and only the first ${count(ORIGINAL_REQUEST_CHAR_BUDGET)} are quoted.)`);
  return lines.join("\n");
}
