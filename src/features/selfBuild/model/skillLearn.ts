// A worker's self-review becomes one plain lesson in the skill it was working from (ash-day step 16). The Lead files it
// with the `skill_learn` tool once a review says something worth keeping; it applies at once (Ash, 14 Oct: bigger bot
// changes apply themselves, logged, never waiting for a click) and lands in Settings → Changes → Bot changes with Undo,
// so "take that lesson out" rewrites the skill file back. Skills are real files under the user's home
// (`.agents/skills/<name>/SKILL.md`), so what the bot learned outlives the chat.
import { createPath, homeDir, readTextFile, writeTextFile } from "../../../platform/tauri/fs";
import { joinPath } from "../../../shared/lib/paths";
import {
  blankSkillMarkdown,
  invalidateSkills,
  isValidSkillName,
  slugSkillName,
  titleFromSkillName,
} from "../../skills/model/skills";
import { recordFlowChange } from "../../hub/model/botChanges";
import { registerChangeKind } from "./changeFlow";
import { forUser } from "../../hub/model/userName";

export const SKILL_LEARN = "skill-learn";

/** What a row needs to put a lesson back out: which skill, and the exact bullet that was added. */
type LessonPart = { skill: string; lesson: string };

const LESSONS = /^##\s+lessons\s*$/i;

/** Where a learned skill lives: the user's own skills folder, so it is there in every project. */
async function skillPath(name: string): Promise<string> {
  const root = await homeDir();
  return joinPath(root, `.agents/skills/${name}/SKILL.md`);
}

/** One plain sentence, whatever the model sent: no newlines, no bullets of its own. */
export function plainLesson(raw: string): string {
  const line = raw
    .replace(/\s+/g, " ")
    .replace(/^[-*•\d.\s]+/, "")
    .trim();
  return line.length > 400 ? `${line.slice(0, 397).trimEnd()}…` : line;
}

/** The file with the lesson added under `## Lessons` (made if the skill has none yet). */
export function addLesson(text: string, lesson: string): string {
  const bullet = `- ${lesson}`;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => LESSONS.test(line.trim()));
  if (at < 0) {
    const body = text.replace(/\s+$/, "");
    return `${body}\n\n## Lessons\n\n${bullet}\n`;
  }
  const end = nextHeading(lines, at + 1);
  let last = at;
  for (let i = end - 1; i > at; i--) {
    if (lines[i].trim()) {
      last = i;
      break;
    }
  }
  const next = [...lines.slice(0, last + 1), bullet, ...lines.slice(last + 1)];
  return next.join("\n");
}

const nextHeading = (lines: string[], from: number): number => {
  for (let i = from; i < lines.length; i++) if (/^##\s/.test(lines[i])) return i;
  return lines.length;
};

/** The file with that exact bullet taken out again; undefined when it isn't there any more. */
export function removeLesson(text: string, lesson: string): string | undefined {
  const bullet = `- ${lesson}`;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => LESSONS.test(line.trim()));
  if (at < 0) return undefined;
  const end = nextHeading(lines, at + 1);
  const found = lines.findIndex((line, i) => i > at && i < end && line.trim() === bullet);
  if (found < 0) return undefined;
  const rest = lines.filter((_, i) => i !== found);
  const sectionEnd = nextHeading(rest, at + 1);
  const empty = rest.slice(at + 1, sectionEnd).every((line) => !line.trim());
  // The last lesson out takes its now-empty `## Lessons` heading with it, so the file reads as it did before.
  return empty ? `${rest.slice(0, at).join("\n").replace(/\s+$/, "")}\n` : rest.join("\n");
}

registerChangeKind(SKILL_LEARN, {
  apply: async (data) => {
    const part = data as LessonPart;
    return [{ title: part.lesson, data: part }];
  },
  undo: async (data) => {
    const part = data as LessonPart;
    const path = await skillPath(part.skill);
    const now = await readTextFile(path).catch(() => "");
    const back = removeLesson(now, part.lesson);
    if (back === undefined) throw new Error(forUser`${titleFromSkillName(part.skill)} has changed since, so that lesson wasn't taken out.`);
    await writeTextFile(path, back);
    invalidateSkills();
    return undefined;
  },
  redo: async (data, undone) => {
    if (undone !== undefined) throw new Error("That lesson can't be put back.");
    const part = data as LessonPart;
    const path = await skillPath(part.skill);
    const now = await readTextFile(path).catch(() => "");
    if (now.includes(`- ${part.lesson}`)) return;
    const text = now.trim() ? now : blankSkillMarkdown(part.skill);
    await writeTextFile(path, addLesson(text, part.lesson));
    invalidateSkills();
  },
});

export type LearnedLesson = { skill: string; lesson: string; path: string; note: string };

/**
 * The Lead files one lesson into a skill: `<lesson>` goes under that skill's `## Lessons`, and the skill is made when it
 * doesn't exist yet. Applying at once, it is a Bot changes row like any other change a bot makes to itself.
 */
export async function learnSkillLesson(input: {
  skill: string;
  lesson: string;
  /** Whose review it came from, when the Lead names the worker. */
  from?: string;
  /** The Mono filing it: the row's "bot". */
  by: string;
}): Promise<LearnedLesson> {
  const skill = slugSkillName(input.skill);
  if (!isValidSkillName(skill)) throw new Error("skill must be lowercase letters, numbers and hyphens, like \"reviewing-a-diff\".");
  const lesson = plainLesson(input.lesson);
  if (!lesson) throw new Error("lesson must be the one plain sentence to keep, in Ash's words where you can.");
  const path = await skillPath(skill);
  const before = await readTextFile(path).catch(() => "");
  if (before.includes(`- ${lesson}`)) {
    return {
      skill,
      lesson,
      path,
      note: forUser`${titleFromSkillName(skill)} already has that lesson, so nothing changed.`,
    };
  }
  const text = before.trim() ? before : blankSkillMarkdown(skill);
  if (!before.trim()) {
    await createPath(await homeDir(), `.agents/skills/${skill}`, true);
  }
  await writeTextFile(path, addLesson(text, lesson));
  invalidateSkills();
  const title = titleFromSkillName(skill);
  recordFlowChange({
    kind: SKILL_LEARN,
    by: input.by,
    title: lesson,
    data: { skill, lesson } satisfies LessonPart,
    line: input.from
      ? forUser`${input.by} wrote a lesson from ${input.from}'s review into ${title}`
      : forUser`${input.by} wrote a lesson into ${title}`,
    now: forUser`Not in ${title}`,
    undoneText: forUser`Undone: that lesson is out of ${title} again.`,
  });
  return {
    skill,
    lesson,
    path,
    note: forUser`It's in ${title} now, and Ash sees it in Settings → Changes → Bot changes with Undo.`,
  };
}

/** Takes one lesson back out of that skill's own file. A missing file is left alone. */
export async function takeBackSkillLesson(skill: string, lesson: string): Promise<void> {
  const name = slugSkillName(skill);
  if (!isValidSkillName(name)) return;
  const sentence = plainLesson(lesson);
  if (!sentence) return;
  const path = await skillPath(name);
  const now = await readTextFile(path).catch(() => "");
  const back = removeLesson(now, sentence);
  if (back === undefined) return;
  await writeTextFile(path, back);
  invalidateSkills();
}
