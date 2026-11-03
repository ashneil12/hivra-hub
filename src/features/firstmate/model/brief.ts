// Hivra WP-10: every brief a first mate sends comes from one template (docs/hivra/SPEC.md section 4, "Brief").
//
// Fixed sections, written by code: the isolation check, the status protocol and where steering arrives (and, after the
// worker's rules, the definition of done: briefPrompt in agentAppTasks.ts keeps "Done when:" last, as /goal reads it).
// The model fills only three: the intent (the person's ask), the spec (`brief`) and the definition of done (`goal`).
// `checkBrief` refuses a brief with any of them empty or left as a placeholder, before anything starts.
//
// Adapted from firstmate's bin/fm-brief.sh and bin/fm-spawn.sh (https://github.com/kunchenguid/firstmate, Copyright (c)
// 2026 Kun Chen, MIT License): the scaffold with "Captain's intent" and "Firstmate spec" filled in by the first mate, the
// worktree-isolation assertion, the status protocol and the steering inbox, and the refusal of leftover placeholders.

export type BriefParts = {
  /** The person's own ask, in their words, with the context needed to read it. */
  intent: string;
  /** The build instructions that ask needs (delegate_task's `brief`). */
  spec: string;
  /** The condition that finishes the task (delegate_task's `goal`). */
  done: string;
};

/** Where the brief's reader works: a checkout of its own, the shared checkout, or (a first mate) reading only. */
export type BriefIsolation =
  | { kind: "own-checkout"; mainCheckout: string }
  | { kind: "shared"; folder: string }
  | { kind: "first-mate" };

const LABEL: Record<keyof BriefParts, { field: string; name: string }> = {
  intent: { field: "intent", name: "The intent" },
  spec: { field: "brief", name: "The spec" },
  done: { field: "goal", name: "The definition of done" },
};

/** Whole-section fill-ins that say nothing. */
const EMPTY_WORDS = new Set([
  "todo",
  "tbd",
  "tbc",
  "fixme",
  "xxx",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "placeholder",
  "fill in",
  "fill me in",
  "to be decided",
  "to be determined",
  "same as above",
  "see above",
  "as above",
  "see brief",
  "see the brief",
  "lorem ipsum",
  "...",
  "…",
  "-",
  "?",
]);

/**
 * Only the template's own fill-in tokens (firstmate's {TASK} and {FIRSTMATE_SPEC}, and the names of this template's three
 * parts), so a brief about ${PORT}, ${{ matrix.os }}, {{ user.name }} or <summary> is never mistaken for one.
 */
const PART = "(?:intent|spec|brief|goal|task|definition of done)";
const TOKENS = [
  /(?<!\$)\{(?:TASK|FIRSTMATE_SPEC|INTENT|SPEC|GOAL)\}/,
  new RegExp(`(?<!\\$)\\{\\{\\s*${PART}\\s*\\}\\}`, "i"),
  new RegExp(`<\\s*(?:${PART}|your ${PART}(?: here)?|fill(?: me)? in)\\s*>`, "i"),
  new RegExp(`\\[\\s*(?:${PART}|your ${PART}(?: here)?|fill(?: me)? in)\\s*\\]`, "i"),
];

function normalised(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`*_]+|[\s"'`*_.:;!]+$/g, "")
    .replace(/\s+/g, " ");
}

/** Why this section can't go out, or undefined when it can. */
export function sectionProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return "is empty";
  const plain = normalised(value);
  if (!plain || EMPTY_WORDS.has(plain) || /^[\s.…\-_?]+$/.test(value.trim())) return "is a placeholder";
  const token = TOKENS.map((pattern) => pattern.exec(value)?.[0]).find(Boolean);
  if (token) return `still has a placeholder (${token.slice(0, 40)})`;
  return undefined;
}

/**
 * The refusal for a brief whose model-written sections are empty or placeholders, in words the model can act on; none
 * when it can go out.
 */
export function checkBrief(parts: Partial<Record<keyof BriefParts, unknown>>): string | undefined {
  const problems = (Object.keys(LABEL) as (keyof BriefParts)[]).flatMap((key) => {
    const problem = sectionProblem(parts[key]);
    return problem ? [`${LABEL[key].name} (${LABEL[key].field}) ${problem}`] : [];
  });
  if (!problems.length) return undefined;
  return `Not sent: ${problems.join("; ")}. Fill intent with the person's own ask, brief with the build instructions, and goal with the condition that finishes it, then send it again.`;
}

function isolationSection(isolation: BriefIsolation): string {
  switch (isolation.kind) {
    case "own-checkout":
      return [
        "## Isolation check",
        `You work in a checkout of your own, never in the project's main checkout (${isolation.mainCheckout}). Before anything else, run \`git rev-parse --show-toplevel\`. If it prints that folder, stop at once: change nothing, and report in one line that you were started in the main checkout.`,
      ].join("\n");
    case "shared":
      return [
        "## Isolation check",
        `You work in the shared folder ${isolation.folder}, on purpose: the person and other workers may be in it too. Change only what this brief names; never discard or rewrite changes you didn't make.`,
      ].join("\n");
    case "first-mate":
      return [
        "## Isolation check",
        "You are a first mate on this: read the project, never edit it. Your workers make every change, each in a checkout of its own.",
      ].join("\n");
  }
}

/**
 * A worker's questions go to its first mate, never to the person. A first mate (today's Leads) still talks to the person
 * in its own chat until WP-05 moves that, so its brief doesn't tell it otherwise.
 */
function statusProtocol(isolation: BriefIsolation): string {
  const question =
    isolation.kind === "first-mate"
      ? "- A question only the person can answer: ask them in your own chat, as you do today."
      : "- A question you need answered: ask it. It goes to your first mate, who answers or takes it to the person; never address the person yourself.";
  return [
    "## Status protocol",
    "- Your first mate watches your work; you don't need to report progress. Speak up only when something changes what happens next.",
    question,
    "- If you can't finish, say so with task_cannot and one plain line on what is in the way. Don't keep trying something that can't work.",
    "- When you finish, end with your report in the shape your rules give. Checks and links count as evidence; your opinion of your own work doesn't.",
  ].join("\n");
}

const STEERING = [
  "## Steering",
  "Your first mate may send you messages while you work; they arrive in this chat as new turns. They outrank this brief where they differ, and the person's own words outrank both.",
].join("\n");

/**
 * The brief's body from the template: the fixed sections around the model's intent and spec. The definition of done
 * goes last in the whole prompt (briefPrompt), so it is not repeated here.
 */
export function renderBrief(parts: Pick<BriefParts, "intent" | "spec">, isolation: BriefIsolation): string {
  return [
    isolationSection(isolation),
    `## Intent\n${parts.intent.trim()}`,
    `## Spec\n${parts.spec.trim()}`,
    statusProtocol(isolation),
    STEERING,
  ].join("\n\n");
}

/** The definition of done a brief from before WP-10 gets when it has none. */
export const LEGACY_GOAL = "The checks the brief names pass, and the report says what changed.";

/**
 * A worker queued before WP-10 (H8's waiting workers are stored with their delegate input) has no intent and maybe no
 * goal; replayed as it is, the template would refuse it and the worker would be dropped. It gets its job's title as
 * the intent and a plain definition of done, so it starts as it was asked to. Anything it already carries is kept.
 */
export function withLegacyBriefParts(input: Record<string, unknown>, title: string): Record<string, unknown> {
  const intent = sectionProblem(input.intent) ? `${title.trim() || "The job"} (asked before briefs carried the ask itself)` : input.intent;
  const goal = sectionProblem(input.goal) ? LEGACY_GOAL : input.goal;
  return { ...input, intent, goal };
}

/** The template's fixed section headings (written by code, never the model's words) and its two filled ones. */
export const FIXED_SECTIONS = ["Isolation check", "Status protocol", "Steering"] as const;
export const FILLED_SECTIONS = ["Intent", "Spec"] as const;

const FIXED_BLOCK = new RegExp(
  `^## (?:${FIXED_SECTIONS.join("|")})\\n[\\s\\S]*?(?=^## |^<|^Done when:|(?![\\s\\S]))`,
  "gm",
);
const FILLED_HEADING = new RegExp(`^## (?:${FILLED_SECTIONS.join("|")})\\n`, "gm");

/** A brief's text with the template's fixed sections taken out and its filled headings dropped: the model's words. */
export function withoutTemplate(text: string): string {
  return text.replace(FIXED_BLOCK, "").replace(FILLED_HEADING, "");
}

/** The spec of a brief written from the template, or undefined for one that isn't. */
export function specOf(text: string): string | undefined {
  const found = /^## Spec\n([\s\S]*?)(?=^## |^<|^Done when:|(?![\s\S]))/m.exec(text);
  return found?.[1].trim() || undefined;
}
