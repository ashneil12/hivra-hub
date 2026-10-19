// What autopilot does with a call that would have gone to Ash: take the agent's own recommendation, or hold it for him
// when it touches his red list (redList.ts). Three doors reach it, all pure here:
// - `app autopilot.decide`, an agent asking before it asks Ash (decideCall);
// - a chat's own question (AskUserQuestion and the like) left for Ash (questionVerdict);
// - a tool approval a supervised chat is waiting on (approvalVerdict).
// The app hook (useAutopilot.ts) applies the verdicts and writes each one to the Autopilot log.

import { pathKey } from "../../../shared/lib/paths";
import type { Block } from "../../sessions/model/session";
import {
  isOtherOption,
  type UserQuestion,
  type UserQuestionOption,
  type UserQuestionPrompt,
  type UserQuestionReply,
} from "../../sessions/model/userQuestion";
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

const RECOMMENDED = /\(?\brecommended\b\)?/i;

/** The option an agent marked as its pick ("(Recommended)" in its label or description), never "Other". */
export function recommendedOptions(question: UserQuestion): UserQuestionOption[] {
  return question.options.filter(
    (option) =>
      !isOtherOption(option) &&
      !/^other\b/i.test(option.label.trim()) &&
      (RECOMMENDED.test(option.label) || RECOMMENDED.test(option.description ?? "")),
  );
}

export function plainLabel(option: UserQuestionOption): string {
  return option.label.replace(/\s*\(?\brecommended\b\)?\s*/i, " ").replace(/\s+/g, " ").trim() || option.label;
}

/** What Ash's absence tells an agent whose question has no marked pick. */
export function handBackText(untilLabel: string): string {
  return `Ash is away on autopilot until ${untilLabel} and can't answer. Decide this yourself: take your own recommendation, carry on, and say what you chose and why in your report. Anything on his red list (money, deleting data without a backup, production hosts, mass destructive changes, messages sent as him, credentials) still waits for him.`;
}

export type QuestionVerdict =
  | { kind: "held"; red: RedCategory; what: string }
  | {
      kind: "answer";
      reply: Extract<UserQuestionReply, { kind: "answered" }>;
      what: string;
      /** What was taken, as it reads in the log. */
      taken: string;
      /** No pick was marked: the agent was told to decide itself. */
      handedBack: boolean;
    };

export function questionWhat(prompt: UserQuestionPrompt): string {
  const first = prompt.questions[0];
  return (prompt.title?.trim() || first?.prompt.trim() || first?.header?.trim() || "A question").slice(0, 500);
}

/**
 * A chat's question while autopilot covers it. Red list (in its title, prompts or options), or a red hold the chat
 * itself asked for: held. Otherwise each question takes the option marked recommended; a single real option is taken;
 * a question with none marked is handed back to the agent in words when it takes free text, else its first option is
 * taken (agents put their pick first).
 */
export function questionVerdict(
  prompt: UserQuestionPrompt,
  untilLabel: string,
  forcedRed?: RedCategory,
): QuestionVerdict {
  const what = questionWhat(prompt);
  const text = callText(
    prompt.title,
    ...prompt.questions.flatMap((q) => [q.header, q.prompt, ...q.options.flatMap((o) => [o.label, o.description])]),
  );
  const red = forcedRed ?? redListCategory(text);
  if (red) return { kind: "held", red, what };
  const answers: Record<string, string[]> = {};
  const custom: Record<string, string> = {};
  const taken: string[] = [];
  let handedBack = false;
  for (const question of prompt.questions) {
    const real = question.options.filter((o) => !isOtherOption(o));
    const marked = recommendedOptions(question);
    const picks = marked.length ? (question.multiSelect ? marked : marked.slice(0, 1)) : real.length === 1 ? real : [];
    if (picks.length) {
      answers[question.id] = picks.map((o) => o.id);
      taken.push(picks.map(plainLabel).join(", "));
    } else if (question.allowCustom) {
      custom[question.id] = handBackText(untilLabel);
      handedBack = true;
    } else if (real.length) {
      answers[question.id] = [real[0].id];
      taken.push(`${plainLabel(real[0])} (its first option; none was marked recommended)`);
    }
  }
  return {
    kind: "answer",
    reply: { kind: "answered", answers, ...(Object.keys(custom).length ? { custom } : {}) },
    what,
    taken: [...taken, ...(handedBack ? ["Handed back: the agent decides itself"] : [])].join("; "),
    handedBack,
  };
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
