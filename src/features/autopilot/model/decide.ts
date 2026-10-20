// What autopilot does with a call that would have gone to Ash: take the agent's own recommendation, or hold it for him
// when it touches his red list (redList.ts). Three doors reach it, all pure here:
// - `app autopilot.decide`, an agent asking before it asks Ash (decideCall);
// - a chat's question for Ash is read and answered by Today's waiting list (hub/model/waitingChats.ts takePick); a
//   question with no pick is handed back to the agent with handBackText;
// - a tool approval a supervised chat is waiting on (approvalVerdict).
// The app hook (useAutopilot.ts) applies the verdicts and writes each one to the Autopilot log.

import { pathKey } from "../../../shared/lib/paths";
import type { Block } from "../../sessions/model/session";
import { callText, redListCategory, redVerdict, type RedCategory } from "./redList";

export type CallVerdict =
  | { outcome: "off" }
  | { outcome: "held"; red: RedCategory; until: number }
  | { outcome: "taken"; answer: string; until: number };

/** An agent's call: its recommendation is taken unless autopilot is off or the call is on the red list. */
export function decideCall(input: {
  question: string;
  recommendation: string;
  why?: string;
  options?: string[];
  declaredRed?: unknown;
  /** The covering switch's end time, or undefined when autopilot is off for this call. */
  until: number | undefined;
}): CallVerdict {
  if (input.until === undefined) return { outcome: "off" };
  const red = redVerdict(
    callText(input.question, input.recommendation, input.why, ...(input.options ?? [])),
    input.declaredRed,
  );
  if (red) return { outcome: "held", red, until: input.until };
  return { outcome: "taken", answer: input.recommendation, until: input.until };
}

/** What Ash's absence tells an agent whose question has no marked pick. */
export function handBackText(untilLabel: string): string {
  return `Ash is away on autopilot until ${untilLabel} and can't answer. Decide this yourself: take your own recommendation, carry on, and say what you chose and why in your report. Anything on his red list (money, deleting data without a backup, production hosts, mass destructive changes, messages sent as him, credentials) still waits for him.`;
}

const APPROVAL_TEXT_MAX = 6_000;

/** The words a tool approval is judged on. */
export function approvalText(block: Pick<Block, "text" | "tool">): string {
  const preview = block.tool?.preview ? JSON.stringify(block.tool.preview) : "";
  return callText(block.text, block.tool?.title, block.tool?.kind, block.tool?.detail?.slice(0, APPROVAL_TEXT_MAX), preview.slice(0, APPROVAL_TEXT_MAX));
}

export function approvalWhat(block: Pick<Block, "text" | "tool">): string {
  return (block.tool?.title?.trim() || block.text.trim() || "A tool call").replace(/\s+/g, " ").slice(0, 300);
}

/** A tool approval while autopilot covers the chat: allowed, unless it touches the red list. */
export function approvalVerdict(
  block: Pick<Block, "text" | "tool">,
  forcedRed?: RedCategory,
): { kind: "allow"; what: string } | { kind: "held"; red: RedCategory; what: string } {
  const what = approvalWhat(block);
  const red = forcedRed ?? redListCategory(approvalText(block));
  return red ? { kind: "held", red, what } : { kind: "allow", what };
}

// ---- which project a chat belongs to -------------------------------------------------------------------------------

export type ProjectRef = { id: string; folder: string | null };

function inside(path: string, folder: string): boolean {
  const p = pathKey(path);
  const f = pathKey(folder);
  return p === f || p.startsWith(`${f}/`);
}

/**
 * The hub project a chat works in, for coverage: a Lead's own project; a Mono with one project, that one; any other
 * chat, the project whose folder holds its folder. A leadership Mono across several projects belongs to none (only the
 * switch for everything covers it).
 */
export function chatProject(
  chat: { cwd: string; worktreeCwd?: string },
  projects: readonly ProjectRef[],
  mono?: { projects: readonly string[]; leadProjectId?: string },
): string | null {
  if (mono) {
    if (mono.leadProjectId) return mono.leadProjectId;
    if (mono.projects.length === 1) {
      const match = projects.find((p) => p.folder && inside(mono.projects[0], p.folder));
      return match?.id ?? null;
    }
    return null;
  }
  for (const path of [chat.cwd, chat.worktreeCwd].filter((p): p is string => !!p)) {
    const match = projects.find((p) => p.folder && inside(path, p.folder));
    if (match) return match.id;
  }
  return null;
}
