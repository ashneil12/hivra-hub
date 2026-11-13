// Hivra WP-10: every brief a first mate sends comes from one template (docs/hivra/SPEC.md section 4, "Brief").
//
// Fixed sections, written by code: the isolation check, the status protocol and where steering arrives (and, after the
// worker's rules, the definition of done: briefPrompt in agentAppTasks.ts keeps "Done when:" last, as /goal reads it).
// The model fills only three: the intent (the person's ask), the spec (`brief`) and the definition of done (`goal`).
// `checkBrief` refuses a brief with any of them empty or left as a placeholder, before anything starts.
//
// The fixed sentences are vendored verbatim from firstmate's bin/fm-brief.sh (https://github.com/kunchenguid/firstmate,
// Copyright (c) 2026 Kun Chen, MIT License; see vendor/firstmate-contract.md). A binding sentence after each block is the
// rewrite: Hivra has no status file and no inbox directory, so the worker uses task_cannot and this chat.
import { WORKER_ASK_TEST } from "./askTest";
import { briefSkillsSection, type BriefTask } from "./briefSkills";
import { checksSection, leaveSection, stampSection, type CheckLine } from "./briefChecks"; // SC-4
import { specSection, type SpecBrief } from "./briefSpec"; // PT-6
import { quoteOriginalRequest } from "./originalRequest";
import { proofToolsSection, type ProofToolLine } from "../../proofTools/model/proofTools"; // PT-1

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

/** What is wrong with each of the brief's model-written sections, one phrase each; none when it can go out. */
export function briefProblems(parts: Partial<Record<keyof BriefParts, unknown>>): string[] {
  return (Object.keys(LABEL) as (keyof BriefParts)[]).flatMap((key) => {
    const problem = sectionProblem(parts[key]);
    return problem ? [`${LABEL[key].name} (${LABEL[key].field}) ${problem}`] : [];
  });
}

/**
 * The refusal for a brief whose model-written sections are empty or placeholders, in words the model can act on; none
 * when it can go out.
 */
export function checkBrief(parts: Partial<Record<keyof BriefParts, unknown>>): string | undefined {
  const problems = briefProblems(parts);
  if (!problems.length) return undefined;
  return `Not sent: ${problems.join("; ")}. Fill intent with the person's own ask, brief with the build instructions, and goal with the condition that finishes it, then send it again.`;
}

function isolationSection(isolation: BriefIsolation): string {
  switch (isolation.kind) {
    case "own-checkout":
      // Verbatim from bin/fm-brief.sh. The last line is the rewrite: Hivra names the checkout and has no status file.
      return [
        "## Isolation check",
        "**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable task worktree you were launched in, such as a treehouse pool path or an Orca-managed worktree, not the primary checkout firstmate operates from.",
        "The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.",
        "If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked [at=<epoch>]: launched in primary checkout, not an isolated worktree` to the status file and stop.",
        `The primary checkout is ${isolation.mainCheckout}. Hivra has no status file: if that check fails, change nothing and report that blocked line with task_cannot.`,
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
  const lines = [
    "## Status protocol",
    "- Your first mate watches your work; you don't need to report progress. Speak up only when something changes what happens next.",
    question,
  ];
  // WP-247: OpenBot's ask test, the worker's version (askTest.ts). A first mate reads the contract's own copy.
  if (isolation.kind !== "first-mate") lines.push(`- ${WORKER_ASK_TEST}`);
  if (isolation.kind !== "first-mate") {
    // Verbatim from bin/fm-brief.sh. The binding after it is the rewrite: there is no status file.
    lines.push(
      "4. Report status by appending one line:",
      "   `$STATUS_APPEND`",
      "   States: working, needs-decision, blocked, $PAUSED_VERB, done, failed.",
      "   Substitute `<epoch>` with the current Unix time in seconds - run `date +%s` and write the number it printed; a stamp that is not plain digits records no time at all.",
      "   Each append wakes firstmate, so report sparingly: only phase changes a supervisor",
      "   would act on (setup done, bug reproduced, fix implemented, validation passed) and the",
      "   needs-decision/blocked/paused/done/failed states. No step-by-step FYI progress lines;",
      "   firstmate reads your pane for that.",
      "   Whenever you mention a PR anywhere - a status line, your terminal, a summary - write its full",
      "   https:// URL exactly as the forge printed it, never a bare number such as \"PR 108\"; firstmate",
      "   copies that URL from your line rather than assembling one.",
      "   A mid-task `working:` line (including setup complete) is nonterminal: do not end the",
      "   turn after it; continue the same stage until a defined `done:` gate under Definition of done.",
      "5. If you hit the same obstacle twice, append `blocked [at=<epoch>]: {why}` and stop; firstmate will help.",
      "6. If a decision belongs above the implementation worker (product choices, destructive actions),",
      "   append `needs-decision [at=<epoch>]: {summary of options}` and stop. Firstmate will reply with the decision.",
      "   A decision or blocker you opened stays open until a `resolved` line carrying its exact key lands; a later `done:` or `working:` line never closes it, even when the answer is what started that work.",
      "   Firstmate's reply normally writes that closing line at answer time; when a blocker or wait clears WITHOUT a firstmate reply, append `resolved [at=<epoch>]: {how it cleared}` yourself (same `[key=<slug>]` if you opened it with one) as you resume.",
      "Hivra has no status file (rewrite: a delegation row, not an append). Do not write one. Say a blocker or a decision with task_cannot and one plain line. `done:` and `working:` still never close an open decision.",
    );
  }
  lines.push(
    "- If you can't finish, say so with task_cannot and one plain line on what is in the way. Don't keep trying something that can't work.",
    "- When you finish, end with your report in the shape your rules give. Checks and links count as evidence; your opinion of your own work doesn't.",
  );
  return lines.join("\n");
}

const STEERING = [
  "## Steering",
  "Your first mate may send you messages while you work; they arrive in this chat, inside your running turn or as your next one. They outrank this brief where they differ, and the person's own words outrank both.",
  "A question you can't answer from this brief goes to your first mate (task_cannot, or your report), never to the person.",
  // Verbatim from bin/fm-brief.sh. The binding is the rewrite: Hivra stores steering in the database, not *.msg files.
  "# Firstmate instruction inbox",
  "Firstmate steers you through durable message files in $INBOX_DIR.",
  "When a terminal message says an instruction is waiting there - and at any natural checkpoint when you are unsure - list them with `find $INBOX_DIR -maxdepth 1 -name '*.msg' 2>/dev/null | sort -V`, read the complete contents of each record (including its final line even when it is not newline-terminated) and act on each message in numeric order, then acknowledge each handled message by moving it: `mv $INBOX_DIR/NNN.msg $INBOX_DIR/handled/`.",
  "Prefer the format-aware `fm_task_inbox_body` reader from `bin/fm-task-inbox-lib.sh` when it is available. If you read manually, a header line `body-terminator=1` means the writer added exactly one synthetic final newline to terminate the record file; that marked newline is not part of the logical message body, so remove only it and preserve any intentional trailing newlines. Legacy records without that marker may end without a newline; read them through the file end.",
  "The move IS the acknowledgement: without it firstmate rings again and eventually treats you as stuck. An empty or absent inbox needs no action.",
  "Hivra has no inbox directory (rewrite: a steering row delivered into this chat). Do not look for `*.msg` files or run `mv`. A message that arrives here is already the instruction.",
  "# Project memory",
  "A project's `AGENTS.md` or `CLAUDE.md` is loaded into every agent session in that project, so edit it only to correct information that is factually wrong - including information your own change made wrong - and never to add knowledge because it is missing.",
  "A correction edits only the wrong text: do not run `bin/fm-ensure-agents-md.sh`, create either file, or add sections, headings, or pointers alongside it.",
].join("\n");

/**
 * PT-3: the proof skills a fully checked project's code brief names, from the hivra-rpi pack (run by name only): Jesse
 * Vincent's test-driven-development and verification-before-completion, and Matt Pocock's TDD (rpi-tdd). MIT, credited in
 * src-tauri/plugins/hivra-rpi/NOTICE.
 */
export const PROOF_SKILLS = ["test-driven-development", "verification-before-completion", "rpi-tdd"] as const;

export const PROOF_SKILLS_SECTION = [
  "## Proof skills",
  `This project checks every task fully. Before you change the code, read these skills by name and follow them: ${PROOF_SKILLS.join(", ")}.`,
].join("\n");

/**
 * The brief's body from the template: the fixed sections around the model's intent and spec. The definition of done
 * goes last in the whole prompt (briefPrompt), so it is not repeated here.
 */
export function renderBrief(
  parts: Pick<BriefParts, "intent" | "spec">,
  isolation: BriefIsolation,
  task?: BriefTask,
  extras?: {
    /** WP-171: a task of a fan-out carries its contract (fanoutWaves.ts fanoutSection). Absent, no section. */
    contract?: string;
    /** WP-171: the person's own request (originalRequest.ts originalRequestOf), quoted after the intent. Absent, no section. */
    originalRequest?: string;
    /** How long that request was before the quote budget cut it. Absent: the text's own length. */
    originalRequestChars?: number;
    /** SC-4: the main checkout's HEAD when this brief was written. Present: the brief opens with the drift rule. */
    stamp?: string;
    /** SC-4: the in-scope paths the drift command lists (briefChecks.ts scopePaths). */
    scope?: readonly string[];
    /** SC-4: the brief's own check lines. Present and not empty: a "Checks that must pass" section. */
    checks?: readonly CheckLine[];
    /** SC-4: the do-not-touch paths. Present and not empty: a "Do not touch" section. */
    leave?: readonly string[];
    /** PT-3: the project checks every task fully, so a code or bug-fix brief also names the proof skills. */
    proofSkills?: boolean;
    /** PT-1: the proof tools this project already has (proofTools.ts `proofToolLines`). Absent or empty: no section. */
    proofTools?: readonly ProofToolLine[];
    /** PT-6: the brief's spec parts and what the app read of the project's spec of record. Absent, or nothing to say: no section. */
    spec?: SpecBrief;
  },
): string {
  // WP-41: name the pstack skills for this kind of work. No task, no section, so a brief that doesn't ask stays as it was.
  const skills = task ? briefSkillsSection(task) : undefined;
  // PT-3: in a project that checks every task fully, a code or bug-fix brief also names the proof skills.
  const proof = extras?.proofSkills && (task === "code" || task === "debug") ? PROOF_SKILLS_SECTION : undefined;
  // PT-1: the same kinds of brief name the proof tools the project already has, each by name with how to use it here.
  const tools = task === "code" || task === "debug" ? proofToolsSection(extras?.proofTools) : undefined;
  // PT-6: the spec of record this task changes (the spec first, then the code), or the spec that covers its scope as context.
  const spec = extras?.spec ? specSection(extras.spec) : undefined;
  return [
    isolationSection(isolation),
    // SC-4: the drift rule opens the brief, right after the isolation check.
    ...(extras?.stamp ? [stampSection(extras.stamp, extras.scope ?? [])] : []),
    `## Intent\n${parts.intent.trim()}`,
    ...(extras?.originalRequest?.trim()
      ? [`## Original request\n${quoteOriginalRequest(extras.originalRequest.trim(), extras.originalRequestChars)}`]
      : []),
    `## Spec\n${parts.spec.trim()}`,
    // PT-6: written by code from the project's own files, every line of them indented (briefSpec.ts).
    ...(spec ? [spec] : []),
    // SC-4: what the worker must pass, and what it must leave alone. Written by code, in lists a line can't break out of.
    ...(extras?.checks?.length ? [checksSection(extras.checks)] : []),
    ...(extras?.leave?.length ? [leaveSection(extras.leave)] : []),
    ...(extras?.contract ? [`## Fan-out contract\n${extras.contract}`] : []),
    statusProtocol(isolation),
    STEERING,
    ...(skills ? [skills] : []),
    ...(proof ? [proof] : []),
    ...(tools ? [tools] : []),
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
export const FIXED_SECTIONS = [
  "Isolation check",
  "Before you start",
  "Original request",
  "Spec of record", // PT-6
  "Checks that must pass",
  "Do not touch",
  "Fan-out contract",
  "Status protocol",
  "Steering",
  "Skills",
  "Proof tools here", // PT-1
] as const;
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
