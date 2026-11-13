// The light checker (Ash, 21 Oct: keep it, but slim): after a chat Ash talks to answers one of his dumps, one cheap
// isolated look compares the two. If something he asked looks missed, the owning chat gets one private
// `[MonoCode check]` turn through the usual delivery (hubChecks.ts CheckDelivery), and answers "Right:" or "Fixed:".
// It never starts work and Ash never hears from it. Each dump is looked at once.
//
// B5 + I6 (22 Oct): a dump in ANY hub chat counts, a plain New-session one included, and it is written down the moment
// it arrives (noteDumps), so a chat quit before it answers is still checkable. The look compares what was actually
// built too: the files a turn changed, the checks it ran and the commits it made, read from the same tool blocks the
// rest of the hub reads (checkpointEdits.ts, soulTamper.ts), not just the reply's prose.
import type { Block, Session } from "../../sessions/model/session";
import { isEditTool, isExecuteTool } from "../../../integrations/harness/core/preview";
import { askStore } from "../../asks/model/askStore";
import { askedFor } from "../../asks/model/askedView";
import { coveringEvidence, evidenceSince, extractAsks, type EvidenceSource } from "./askLedger";
import { CHECK_RULES } from "./checkerRules";
import { CHECK_PREFIX, type HubCheck } from "./hubChecks";
import { forUser } from "./userName";
import { RESEND_NOTE, resumeStopped } from "../../sessions/model/inFlight";

/**
 * A dump: a message with something in it to act on. A long paste or one over several lines, and now also a short ask
 * ("fix the save bug") — its asks go into the ledger (askLedger.ts) and are checked like any other. Only chatter is
 * left out, so a "thanks" produces nothing.
 */
export function isDump(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("[MonoCode")) return false;
  return (
    extractAsks(trimmed).length > 0 ||
    trimmed.length >= 280 ||
    trimmed.split("\n").filter((line) => line.trim()).length >= 3
  );
}

/** The id of a chat's latest message from Ash, for noticing a new one arrives (the app's own hidden turns count as a change). */
export function lastUserBlockId(session: Pick<Session, "blocks">): string {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (block.role !== "user" || block.draft) continue;
    return block.id;
  }
  return "";
}

/** How far back a chat is read for dumps, and how many of one chat's dumps are written down at once. */
const SCAN_BLOCKS = 40;
const PER_CHAT = 3;

/**
 * A chat's recent dumps, newest first. A short ask after a dump does not hide the dump (Ash can paste a dump and keep
 * typing); an answered dump from more than two hours ago is history, and everything before it is older still.
 */
function recentDumps(
  session: Pick<Session, "blocks">,
  now: number,
): { block: Block; index: number }[] {
  const found: { block: Block; index: number }[] = [];
  const last = session.blocks.length - 1;
  for (let index = last, seen = 0; index >= 0 && seen < SCAN_BLOCKS; index--, seen++) {
    const block = session.blocks[index];
    if (block.role !== "user" || block.draft || block.internal || !isDump(block.text ?? "")) continue;
    // The app's own resend after a restart is not Ash writing (r61: verify-live's crash_loop_capped flake).
    if ((block.text ?? "").startsWith(RESEND_NOTE)) continue;
    const started = block.startedAt ?? block.sentAt;
    const answered = index < last;
    if (started !== undefined && answered && now - started > RECENT_MS) break;
    found.push({ block, index });
    if (found.length >= PER_CHAT) break;
  }
  return found;
}

/** One dump, written down when it arrives: what Ash asked and which chat owns it. */
export type DumpNote = { chatId: string; blockId: string; text: string; at: number };

/** A dump noticed for the first time: its text in full, and the time Ash sent it (not the time it was noticed). */
export type NewDump = { chatId: string; blockId: string; text: string; at: number };

const NOTES_KEY = "monocode:hub-dump-asks";
const NOTES_MAX = 100;
const NOTE_TEXT_MAX = 8_000;
/** An answered dump older than this that was never seen while its chat was busy is history, not something to look at. */
const RECENT_MS = 2 * 60 * 60 * 1000;

/** The dumps waiting to be looked at, oldest first. */
export function readDumpNotes(): DumpNote[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NOTES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is DumpNote =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as DumpNote).chatId === "string" &&
        typeof (entry as DumpNote).blockId === "string" &&
        typeof (entry as DumpNote).text === "string" &&
        typeof (entry as DumpNote).at === "number",
    );
  } catch {
    return [];
  }
}

function writeDumpNotes(notes: readonly DumpNote[]): void {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes.slice(-NOTES_MAX)));
  } catch {
    // Without storage a dump is still looked at while this window lives; only a restart loses it.
  }
}

/**
 * Write down every dump that arrived, at dump time: the text is kept here, so the chat that owns it can still be
 * checked after a quit, a crash or a restart that cut its answer. An unanswered dump is always noted; an answered one
 * only while it is recent (two hours), so upgrading doesn't sweep the whole backlog. A worker (`app-...`) and any chat
 * the caller says no to are never noted: they never own a check.
 *
 * Each dump noted for the first time is handed to `onNew` at that moment, with the time Ash sent it: that is where the
 * app writes its asks into the ask ledger for a chat no first mate's hearing covers (asks/model/hubRoute.ts). This file
 * keeps no ledger of its own any more (askLedger.ts), so nothing is written twice.
 */
export function noteDumps(
  sessions: readonly Pick<Session, "id" | "blocks" | "busy">[],
  now = Date.now(),
  skip?: (sessionId: string) => boolean,
  onNew?: (dump: NewDump) => void,
): DumpNote[] {
  const notes = readDumpNotes();
  const known = new Set(notes.map((note) => note.blockId));
  let added = false;
  for (const session of sessions) {
    if (session.id.startsWith("app-") || skip?.(session.id)) continue;
    for (const found of recentDumps(session, now)) {
      if (known.has(found.block.id)) continue;
      notes.push({
        chatId: session.id,
        blockId: found.block.id,
        text: (found.block.text ?? "").slice(0, NOTE_TEXT_MAX),
        at: now,
      });
      // The same moment the note is written, his asks are handed on to be written down (B5).
      onNew?.({ chatId: session.id, blockId: found.block.id, text: found.block.text ?? "", at: found.block.startedAt ?? found.block.sentAt ?? now });
      known.add(found.block.id);
      added = true;
    }
  }
  if (added) writeDumpNotes(notes);
  return added ? readDumpNotes() : notes;
}

/** A dump was looked at: it stops waiting here. */
export function forgetDumpNote(blockId: string): void {
  const notes = readDumpNotes();
  const kept = notes.filter((note) => note.blockId !== blockId);
  if (kept.length !== notes.length) writeDumpNotes(kept);
}

/** What the chat said after Ash's dump. */
export function replyAfter(blocks: readonly Block[], index: number): string {
  return blocks
    .slice(index + 1)
    .filter((block) => block.role === "assistant" && block.text?.trim())
    .map((block) => block.text!.trim())
    .join("\n\n");
}

const SUCCEEDED = ["completed", "success"];
const MAX_EVIDENCE = 12;

/** A command that runs a project's checks: tests, a type check, lint/format, a build check. */
const CHECK_COMMAND =
  /\b(?:npm\s+(?:run\s+)?(?:test|check|check-all)|npx\s+(?:vitest|tsc|playwright)|vitest\b|tsc\b|cargo\s+(?:test|clippy|fmt|check)|pytest|go\s+test|make\s+(?:test|check))\b/;

/** "12 passed, 1 failed" from a check's output, when it says. */
function checkResult(output: string): string {
  const passed = output.match(/(\d+)\s+(?:tests?\s+)?passed/i)?.[1];
  const failed = output.match(/(\d+)\s+(?:tests?\s+)?failed/i)?.[1];
  const parts = [passed && `${passed} passed`, failed && `${failed} failed`].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/**
 * What the chat actually built after Ash's dump, as plain facts: the files a turn changed, the commits it made and the
 * checks it ran. Read from the same tool blocks the rest of the hub reads (successful edits and shell calls only, the
 * way checkpointEdits.ts and soulTamper.ts do), so the look compares the build, not only what a reply claims.
 */
export function builtEvidence(blocks: readonly Block[], after: number): string[] {
  const changed = new Set<string>();
  const lines: string[] = [];
  const add = (line: string) => {
    if (lines.length < MAX_EVIDENCE && !lines.includes(line)) lines.push(line);
  };
  for (let i = after + 1; i < blocks.length && lines.length < MAX_EVIDENCE; i++) {
    const block = blocks[i];
    const tool = block.role === "tool" ? block.tool : undefined;
    if (!tool || (tool.status && !SUCCEEDED.includes(tool.status))) continue;
    if (isEditTool(tool.kind, tool.title, tool.preview)) {
      for (const path of tool.paths ?? []) if (path) changed.add(path);
      if (tool.preview?.path) changed.add(tool.preview.path);
      continue;
    }
    if (!isExecuteTool(tool.kind, tool.title)) continue;
    const command = tool.title?.trim() ?? "";
    const output = tool.detail ?? "";
    if (/\bgit\b/i.test(command) && /\bcommit\b/i.test(command)) {
      const subject = output.match(/^\[[^\]\n]+\]\s+(.+)$/m)?.[1]?.trim();
      add(`committed${subject ? ` ${subject.slice(0, 140)}` : ""}`);
      continue;
    }
    if (CHECK_COMMAND.test(command)) add(`ran ${command.slice(0, 160)}${checkResult(output)}`);
  }
  if (changed.size) {
    const paths = [...changed];
    const listed = paths.slice(0, 8).join(", ") + (paths.length > 8 ? ` (+${paths.length - 8} more)` : "");
    lines.unshift(`changed ${listed}`);
  }
  return lines.slice(0, MAX_EVIDENCE);
}

export const NOTHING_MISSED = "NONE";

/**
 * The one cheap look. The message and the reply are always compared; when the chat left a build behind, what it built
 * is handed over too and counts as handled even when the reply doesn't mention it (I6: compare what was built).
 */
export function dumpCheckPrompt(ash: string, reply: string, evidence: readonly string[] = []): string {
  const built = evidence.length
    ? `\n\n<what the chat built>\n${evidence
        .slice(0, MAX_EVIDENCE)
        .map((line) => `- ${line}`)
        .join("\n")}\n</what the chat built>\nSomething listed under what the chat built counts as handled, even when the reply doesn't mention it.`
    : "";
  return `Compare a message with the reply to it. List each concrete thing the message asks for that the reply neither handles, starts, plans nor talks about. Ignore musings and anything the reply asked back about.
Answer with exactly ${NOTHING_MISSED}, or one line per missed thing starting "- ", quoting the message's own words.

<message>
${ash.slice(0, 8_000)}
</message>

<reply>
${reply.slice(0, 8_000)}
</reply>${built}`;
}

/** What the look found missed; empty for NONE or anything unreadable. */
export function parseMissed(answer: string): string[] {
  if (answer.trim().toUpperCase().startsWith(NOTHING_MISSED)) return [];
  return answer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line.length > 3)
    .map((line) => line.slice(2).trim())
    .slice(0, 5);
}

/** The private turn for the chat that owns the dump. */
export function dumpCheck(sessionId: string, ask: { id: string }, missed: readonly string[]): HubCheck {
  const finding = missed.map((line) => `- ${line}`).join("\n");
  return {
    id: `dc-${ask.id}`,
    dumpId: ask.id,
    owner: sessionId,
    chatId: sessionId,
    finding,
    askIds: [],
    prompt: forUser`${CHECK_PREFIX} I read Ash's last long message and your answer. This may have been missed:\n${finding}\nIs this right? ${CHECK_RULES}`,
  };
}

/** The private turn for a dump the chat went idle on without answering (a quit, a crash, a cut run). */
export function unansweredDumpCheck(sessionId: string, note: DumpNote): HubCheck {
  return {
    id: `dc-${note.blockId}-unanswered`,
    dumpId: note.blockId,
    owner: sessionId,
    chatId: sessionId,
    finding: "- the whole message was never answered",
    askIds: [],
    prompt: forUser`${CHECK_PREFIX} Ash sent this long message and no answer was ever sent to it in this chat:\n\n${note.text.slice(0, 4_000)}\n\nIs this right? ${CHECK_RULES}`,
  };
}

/** How a look is allowed to see the chats (app/hooks/useHubChecks.ts). */
export type DumpCheckOptions = {
  now?: number;
  /** Chats left alone: the checker's own (it only reads), and any other this copy says no to. */
  skip?: (sessionId: string) => boolean;
  /** Where commits and Bot changes come from (askEvidence.ts); the look compares them too, not only the reply. */
  source?: EvidenceSource;
  /** Each dump noticed for the first time, to be written into the ask ledger (see noteDumps). */
  onNewDump?: (dump: NewDump) => void;
};

/**
 * Look at each dump once, in any hub chat. A dump is noted when it arrives (noteDumps), so this walks the notes, not
 * the chats: a note survives the chat being quit and is looked at after a restart. What the chat built is compared with
 * what he asked: the tool blocks after his message, and (when a source is given) the commits in the chat's folder since
 * he said it and the Bot changes rows. A chat that went idle without answering or building anything gets one "never
 * answered" note instead of a comparison. When nothing was missed, the asks whose build lines up are closed in the
 * ledger; the rest stay open for askSettle.ts.
 */
export async function lookAtDumps(
  sessions: readonly Session[],
  look: (prompt: string) => Promise<string>,
  offer: (checks: HubCheck[]) => unknown,
  options: DumpCheckOptions = {},
): Promise<void> {
  noteDumps(sessions, options.now, options.skip, options.onNewDump);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const note of readDumpNotes()) {
    const session = byId.get(note.chatId);
    if (!session || session.busy || session.queuedMessages?.length) continue;
    // A chat that stopped resuming itself after restart after restart waits for Ash: a check would start it again
    // behind his back (r61: the fourth resume verify-live's crash_loop_capped caught, a "never answered" check).
    if (resumeStopped(session)) continue;
    // A worker (`app-...`) never owns a check, and the checker's own chat would only note on itself.
    if (session.id.startsWith("app-") || options.skip?.(session.id)) continue;
    if (!claimDumpCheck(note.blockId)) {
      forgetDumpNote(note.blockId);
      continue;
    }
    const index = session.blocks.findIndex((block) => block.id === note.blockId);
    const block = index >= 0 ? session.blocks[index] : undefined;
    const since = block?.startedAt ?? block?.sentAt ?? note.at;
    const built = index >= 0 ? builtEvidence(session.blocks, index) : [];
    const git = options.source ? await evidenceSince({ cwd: session.cwd, since }, options.source) : [];
    const evidence = [...built, ...git];
    const reply = index >= 0 ? replyAfter(session.blocks, index) : "";
    if (!reply.trim() && !evidence.length) {
      forgetDumpNote(note.blockId);
      await offer([unansweredDumpCheck(session.id, note)]);
      continue;
    }
    const missed = parseMissed(await look(dumpCheckPrompt(note.text, reply, evidence)).catch(() => ""));
    forgetDumpNote(note.blockId);
    if (missed.length) {
      await offer([dumpCheck(session.id, { id: note.blockId }, missed)]);
      continue;
    }
    // Nothing missed: close the asks the build visibly covers, leaving any the look could not tie to work open.
    const store = askStore();
    for (const ask of askedFor(await store.load(), session.id, note.blockId)) {
      if (!ask.open || ask.kind === "idea") continue;
      const cover = coveringEvidence(ask, evidence);
      if (cover) await store.handle(ask.id, `looked, and the build shows: ${cover}`);
    }
  }
}

const CHECKED_KEY = "monocode:hub-dump-checked";
const CHECKED_MAX = 500;

/** Mark a dump as looked at; false when it already was. */
export function claimDumpCheck(blockId: string): boolean {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(CHECKED_KEY) ?? "[]");
    if (Array.isArray(parsed)) list = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    list = [];
  }
  if (list.includes(blockId)) return false;
  try {
    localStorage.setItem(CHECKED_KEY, JSON.stringify([...list, blockId].slice(-CHECKED_MAX)));
  } catch {
    // Without storage a dump may be looked at again after a restart; the delivery still sends a check once.
  }
  return true;
}
