// What autopilot does with a call that would have gone to Ash: take the agent's own recommendation, or hold it for him
// when it touches his red list (redList.ts). Three doors reach it, all pure here:
// - `app autopilot.decide`, an agent asking before it asks Ash (decideCall);
// - a chat's question for Ash is read and answered by Today's waiting list (hub/model/waitingChats.ts takePick); a
//   question with no pick is handed back to the agent with handBackText;
// - a tool approval a supervised chat is waiting on (approvalVerdict): allowed only when it is a read, or an edit inside
//   the chat's own folder (safeApproval.ts), and off the red list.
// The app hook (useAutopilot.ts) applies the verdicts and writes each one to the Autopilot log.

import { pathKey } from "../../../shared/lib/paths";
import type { Block } from "../../sessions/model/session";
import type { TrustedServers } from "./mcpTrust";
import { callText, redListCategory, redListInWords, redVerdict, type RedCategory } from "./redList";
import { questionVeto, reviewVeto } from "./reviewerRules";
import { credentialInPaths } from "./credentialPaths";
import { bashWords, readPaths, safeCall, searchStartsOutside } from "./safeApproval";
import { forUser } from "../../hub/model/userName";

export type CallVerdict =
  | { outcome: "off" }
  | { outcome: "held"; red: RedCategory | null; until: number }
  | { outcome: "taken"; answer: string; until: number };

/**
 * An agent's call: its recommendation is taken unless autopilot is off, the call is on the red list, or it is a send,
 * a delete, a payment, a publish or an account change, which always wait for Ash (reviewerRules.ts questionVeto).
 * A call the rules can't read holds.
 */
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
  const until = input.until;
  try {
    // WP-101 fix round 2, item F: the fields are read from an agent's call, which may be any shape at all. A question
    // or a recommendation that isn't text can't be judged, so it holds; the review found these returning "taken"
    // with a null answer.
    if (!input || typeof input !== "object") return { outcome: "held", red: null, until };
    if (typeof input.question !== "string" || !input.question.trim()) return { outcome: "held", red: null, until };
    if (typeof input.recommendation !== "string") return { outcome: "held", red: null, until };
    if (input.options !== undefined && input.options !== null && !Array.isArray(input.options)) return { outcome: "held", red: null, until };
    const red = redVerdict(
      callText(input.question, input.recommendation, input.why, ...(input.options ?? [])),
      input.declaredRed,
    );
    if (red) return { outcome: "held", red, until };
    // WP-101: the same rule a reviewed approval follows, on the question path: asking is not a ground for answering.
    if (questionVeto({ question: input.question, recommendation: input.recommendation, options: input.options }))
      return { outcome: "held", red: null, until };
    return { outcome: "taken", answer: input.recommendation, until };
  } catch (error) {
    // A call that can't be judged holds: never an answer on an error (WP-101, fail closed).
    console.warn("Autopilot decision:", error);
    return { outcome: "held", red: null, until };
  }
}

/** What Ash's absence tells an agent whose question has no marked pick. */
export function handBackText(untilLabel: string): string {
  return forUser`Ash is away on autopilot until ${untilLabel} and can't answer. Decide this yourself: take your own recommendation, carry on, and say what you chose and why in your report. Anything on his red list (money, deleting data without a backup, production hosts, mass destructive changes, messages sent as him, credentials) still waits for him.`;
}

/** The most an approval's words may run to and still be judged: past it, the red list can't read all of it. */
export const APPROVAL_TEXT_MAX = 6_000;

type ApprovalBlock = Pick<Block, "text" | "tool" | "approval">;

/** The words a tool approval is judged on: everything it shows, and exactly what it would run. Never cut. */
export function approvalText(block: ApprovalBlock): string {
  const preview = block.tool?.preview ? JSON.stringify(block.tool.preview) : "";
  const call = block.approval?.call;
  return callText(
    block.text,
    block.tool?.title,
    block.tool?.kind,
    block.tool?.detail,
    preview,
    call?.tool,
    call?.command,
    call?.server,
    call?.glob,
    ...(call?.paths ?? []),
    ...(call?.args ?? []),
  );
}

/**
 * The words an approval shows: its title, then what it really runs (the command, or the files it names), with the
 * invisible and direction-control characters taken out so a name can't hide what it says (review M5). A generated
 * title alone hid the command, so the command is shown beside it.
 */
export function approvalWhat(block: Pick<Block, "text" | "tool" | "approval">): string {
  const title = block.tool?.title?.trim() || block.text.trim() || "A tool call";
  const call = block.approval?.call;
  const real = call?.command ?? (call?.paths?.length ? call.paths.join(", ") : undefined);
  const shown = real && real !== title ? `${title}: ${real}` : title;
  return shown
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export type ApprovalVerdict =
  | { kind: "allow"; what: string }
  | { kind: "held"; red: RedCategory | null; what: string; why: string };

/**
 * A tool approval while autopilot covers the chat, in a chat working in `folder` (its worktree when it has one):
 * allowed only when it is a read, or an edit inside that folder, and nothing it says
 * touches the red list. Everything else, and anything too long to read whole, waits for Ash as when autopilot is off.
 * `trusted` is the exact set of MCP servers Hivra wired from installed plugins for this chat (mcpTrust.ts); without
 * it, every MCP call waits.
 */
export function approvalVerdict(
  block: ApprovalBlock,
  folder: string | undefined,
  forcedRed?: RedCategory,
  trusted?: TrustedServers | null,
): ApprovalVerdict {
  let what = "A tool call";
  try {
    what = approvalWhat(block);
    if (forcedRed) return { kind: "held", red: forcedRed, what, why: forUser("its chat was told to ask Ash") };
    const text = approvalText(block);
    if (text.length > APPROVAL_TEXT_MAX) return { kind: "held", red: null, what, why: "it is too long to check whole" };
    const red = redListCategory(text);
    if (red) return { kind: "held", red, what, why: "it touches the red list" };
    // WP-101 fix round 2, item A: a shell command is also read as the words the shell would pass. Quotes and
    // backslashes can hide a path from the raw text (`cat ~/.ne"t"rc`), so the red list reads the real words.
    const words = bashWords(block.approval?.call);
    if (words) {
      const fromWords = redListInWords(words, folder);
      if (fromWords) return { kind: "held", red: fromWords, what, why: "it touches the red list" };
    }
    // WP-101 fix round 4, finding 4: a read tool (Read, NotebookRead) names its file in `paths`, which the red list's text
    // reading splits at a space and has no rule for a shell startup file in. The same path check as a shell word runs.
    if (credentialInPaths(readPaths(block.approval?.call), folder)) return { kind: "held", red: "credentials", what, why: "it touches the red list" };
    // WP-101 review H1: a search (Grep, Glob, LS) names where it walks from in its paths, read as a walk.
    // Round 2: a glob names files the ignore rules hide, so a search with one waits whatever it searches.
    if (block.approval?.call?.glob !== undefined)
      return { kind: "held", red: null, what, why: "its glob can match files git and the ignore rules hide, so it waits for Ash" };
    if (searchStartsOutside(block.approval?.call, folder))
      return { kind: "held", red: null, what, why: "it searches outside the chat's folder, or in a login store" };
    // WP-101: a send, a delete, a payment, a publish or an account change always waits, whatever else says it may
    // (reviewerRules.ts). This can only hold, never allow.
    const reviewed = reviewVeto({
      action: { tool: block.approval?.call?.tool, command: block.approval?.call?.command, title: block.tool?.title },
    });
    if (reviewed) return { kind: "held", red: null, what, why: reviewed };
    const why = safeCall(block.approval?.call, folder, trusted);
    return why ? { kind: "held", red: null, what, why } : { kind: "allow", what };
  } catch (error) {
    // A call that can't be judged holds: never an allow on an error (WP-101, fail closed).
    console.warn("Autopilot approval:", error);
    return { kind: "held", red: null, what, why: "the app couldn't decide it, so it waits for Ash" };
  }
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
