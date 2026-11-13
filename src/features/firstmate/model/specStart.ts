// PT-6: spec_start. "Write this project's spec of record from what it already has: its README, docs and the briefs of landed
// tasks. Only when the person asks." The tool (src-tauri/src/firstmate/spec_mcp.rs) is one app call; agentAppTasks.ts reads the
// project's landed tasks (firstmate_spec_landed) and where its spec lives (firstmate_spec_context), builds ONE brief here and
// delegates it like any task, so the draft lands the way any task does. Nothing here starts on its own.
import { specOf, withoutTemplate } from "./brief";
import { SPEC_FOLDERS, SPEC_INDEX, SPEC_SINGLE_FILE, type SpecHome } from "./briefSpec";

/** One task that landed in the project: what the app's rows keep of it (src-tauri/src/firstmate/spec_record.rs `Landed`). */
export type LandedTask = { title: string; goal: string; brief: string; at: number };

/** The most landed tasks a draft reads, and how much of each field is kept (the same bounds as the app's own read). */
const LANDED_MAX = 30;
const TITLE_MAX = 200;
const GOAL_MAX = 400;
const BRIEF_MAX = 8_000;
/** One landed task is one line of the brief, at most this many characters. */
const LINE_MAX = 320;

const oneLine = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");
const head = (text: string, max: number): string => [...text].slice(0, max).join("");

/** What `firstmate_spec_landed` answers, read defensively: an entry that isn't a title and text is dropped, and the rest is capped. */
export function readLanded(value: unknown): LandedTask[] {
  if (!Array.isArray(value)) return [];
  const out: LandedTask[] = [];
  for (const entry of value) {
    if (out.length >= LANDED_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const { title, goal, brief, at } = entry as Record<string, unknown>;
    if (typeof title !== "string") continue;
    out.push({
      title: head(title, TITLE_MAX),
      goal: typeof goal === "string" ? head(goal, GOAL_MAX) : "",
      brief: typeof brief === "string" ? head(brief, BRIEF_MAX) : "",
      at: typeof at === "number" && Number.isFinite(at) ? at : 0,
    });
  }
  return out;
}

/** The person's ask in a rendered brief (its `## Intent`), else its spec, else the brief as plain text. */
function askOf(brief: string): string {
  const intent = /^## Intent\n([\s\S]*?)(?=^## |^<|^Done when:|(?![\s\S]))/m.exec(brief)?.[1];
  return oneLine(intent?.trim() ? intent : (specOf(brief) ?? withoutTemplate(brief)));
}

/** One landed task as one line: nothing in it can open a heading, a block or a section of the brief. */
function landedLine(task: LandedTask): string {
  const title = oneLine(task.title);
  const ask = askOf(task.brief);
  const line = `- ${title}${ask ? `: ${ask}` : ""}`;
  return [...line].length > LINE_MAX ? `${head(line, LINE_MAX - 1).trimEnd()}…` : line;
}

function placeText(home: SpecHome | undefined): { intro: string; folder: string | undefined } {
  if (home?.singleFile)
    return {
      intro: `This project keeps its spec in one file, ${SPEC_SINGLE_FILE}. Extend it with the areas it lacks, one \`## <Section name>\` section for each, and never rewrite a section a person wrote. Make no other spec files.`,
      folder: undefined,
    };
  const folder = home?.exists ? home.folder : SPEC_FOLDERS[0];
  if (home?.exists)
    return {
      intro: `This project already keeps its specs in ${folder}/. Keep what is there: add the areas it lacks, bring the index, ${folder}/${SPEC_INDEX}, up to date (make it when it is missing), and never rewrite a section a person wrote. A new area is ${folder}/<area>.md.`,
      folder,
    };
  return {
    intro: `It goes in ${folder}/: an index, ${folder}/${SPEC_INDEX}, and one file per area, ${folder}/<area>.md.`,
    folder,
  };
}

/**
 * The delegate input of the one worker that drafts the project's spec of record: its intent, the build instructions, the
 * definition of done and a title. It names no gates, scope or check line (so it is no code brief, and a project that checks every
 * task fully doesn't refuse it) and no spec part (the draft is what it writes).
 */
export function specStartInput(args: { landed: readonly LandedTask[]; home?: SpecHome; project?: string }): Record<string, unknown> {
  const { intro, folder } = placeText(args.home);
  const brief = [
    `Write this project's spec of record from what the project already has. ${intro}`,
    "Read first: the project's README, its docs folder and AGENTS.md or CLAUDE.md when it has one, then the landed tasks below.",
    "A file holds a title (`# <Area>`), then one `## <Section name>` section for each thing that must stay true. The heading is the section's stable id: name it once and keep it. Under it, in plain words, write the person's intent, the laws (what must always hold) and the acceptance checks, each check as a line like `- <what must be true>: run <command>, expect: <output>`. A file may start with a front-matter block holding one line, `paths: <the code areas it covers>` (comma separated, from the project's root), so a later task in those areas sees the file.",
    ...(folder
      ? [`The index is a title, one line on what the spec is for, then one line per file: the file's name and one sentence on its area.`]
      : []),
    "Write only what the project's own files and the landed tasks below support. Where they don't say, write a line that starts \"Open question:\" and ask nothing of the person. Don't invent a requirement. Change no code, no tests and no other documents. Commit the spec in one commit of its own.",
    args.landed.length
      ? `Landed tasks (newest first):\n${args.landed.slice(0, LANDED_MAX).map(landedLine).join("\n")}`
      : "No task has landed in this project yet, so write from the project's own files alone.",
  ].join("\n\n");
  const goal = folder
    ? `${folder}/${SPEC_INDEX} exists and lists every file in ${folder}/, and every file has \`## \` sections written from the project's own files and landed tasks, with no change to anything else.`
    : `${SPEC_SINGLE_FILE} has a \`## \` section for each area of the project, written from the project's own files and landed tasks, with no change to anything else.`;
  return {
    intent: "The person asked for this project's spec of record to be written from what it already has.",
    brief,
    goal,
    title: "Write the project's spec of record",
    ...(args.project ? { project: args.project } : {}),
  };
}
