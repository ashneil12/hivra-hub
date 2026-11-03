// What each hub chat adds to Claude Code's own system prompt (Ash, 21 Oct: "start from vanilla Claude Code and add back
// only what's needed"): the hub note, and a Mono's soul and memory (monos/model/monoFiles.ts monoContext,
// codingTeamContext). The app sets it before a turn; claude.ts appends it with --append-system-prompt when it starts the
// process, and restarts the process (resuming the conversation) when the key changes. Memory isn't in the key: a memory
// change reaches a running process in the next message instead.
import { setClaudeAppend, type ClaudeAppend } from "../../../integrations/harness/providers/claude/claudeExtraArgs";

const notes = new Map<string, ClaudeAppend>();

export function setHubNote(sessionId: string, note: ClaudeAppend | undefined): void {
  if (note?.text.trim()) notes.set(sessionId, note);
  else notes.delete(sessionId);
}

/**
 * Whether a chat's hub note, soul and memory go on its engine's system prompt (only Claude Code takes an appended one)
 * instead of ahead of the message. A raw slash command never carries them.
 */
export function appendsHubNote(harness: string, rawCommand = false): boolean {
  return harness === "claude" && !rawCommand;
}

export function hubNoteFor(sessionId: string): ClaudeAppend | undefined {
  return notes.get(sessionId);
}

setClaudeAppend(hubNoteFor);
