// A worker's self-review becomes one plain lesson in the skill it was working from (ash-day step 16). The Lead files it
// with the `skill_learn` tool once a review says something worth keeping; it applies at once (Ash, 14 Oct: bigger bot
// changes apply themselves, logged, never waiting for a click) and lands in Settings → Changes → Bot changes with Undo,
// so "take that lesson out" rewrites the skill file back. Skills are real files under the user's home
// (`.agents/skills/<name>/SKILL.md`), so what the bot learned outlives the chat.
import { createPath, homeDir, movePath, readTextFile, writeTextFile } from "../../../platform/tauri/fs";
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
import { forUser, userName } from "../../hub/model/userName";
import { evictions, LET_GO_FOLDER, noteLearned, parseRegistry, REGISTRY_FILE } from "./learnedSkills";
import { replaceOnce, sanitizeLesson } from "./lessonSafety";

export const SKILL_LEARN = "skill-learn";

/**
 * What a row needs to put a lesson back out: which skill, and the exact bullet that was added. WP-242: an edit also
 * keeps the passage it replaced, so Undo puts that back.
 */
type LessonPart = { skill: string; lesson: string; was?: string };

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
  const matches = lines.flatMap((line, i) => (i > at && i < end && line.trim() === bullet ? [i] : []));
  // WP-242: an edit must match exactly one passage. Two identical bullets cannot say which one is meant.
  if (matches.length !== 1) return undefined;
  const found = matches[0];
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
    const put = part.was !== undefined ? replaceOnce(now, `- ${part.lesson}`, `- ${part.was}`) : undefined;
    const back = put ? (put.ok ? put.text : undefined) : removeLesson(now, part.lesson);
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
    if (part.was !== undefined) {
      const put = replaceOnce(now, `- ${part.was}`, `- ${part.lesson}`);
      if (!put.ok) throw new Error(put.reason);
      await writeTextFile(path, put.text);
      invalidateSkills();
      return;
    }
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
  /**
   * WP-242: the lesson replaces this passage of SKILL.md instead of being added. It must be in the file exactly once;
   * otherwise nothing is written and a plain line says why.
   */
  replace?: string;
}): Promise<LearnedLesson> {
  const skill = slugSkillName(input.skill);
  if (!isValidSkillName(skill)) throw new Error("skill must be lowercase letters, numbers and hyphens, like \"reviewing-a-diff\".");
  const plain = plainLesson(input.lesson);
  if (!plain) throw new Error("lesson must be the one plain sentence to keep, in Ash's words where you can.");
  // WP-242: every lesson is cleaned of personal details before it is saved, whichever path it came by.
  const checked = sanitizeLesson(plain, lessonNames());
  if (!checked.ok) throw new Error(checked.reason);
  const lesson = checked.lesson;
  const path = await skillPath(skill);
  const before = await readTextFile(path).catch(() => "");
  if (input.replace !== undefined) return editLesson(input, skill, lesson, path, before);
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
  const written = addLesson(text, lesson);
  await writeTextFile(path, written);
  invalidateSkills();
  await keepWithinCap(skill, written);
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

/** The person's own name, which a lesson never keeps (WP-242). */
function lessonNames(): string[] {
  const name = userName();
  return name ? [name] : [];
}

/** WP-242: a lesson that replaces exactly one passage of the skill, with Undo putting the passage back. */
async function editLesson(
  input: { by: string; from?: string; replace?: string },
  skill: string,
  lesson: string,
  path: string,
  before: string,
): Promise<LearnedLesson> {
  const title = titleFromSkillName(skill);
  const was = plainLesson(input.replace ?? "");
  const put = replaceOnce(before, `- ${was}`, `- ${lesson}`);
  if (!put.ok) throw new Error(forUser`${put.reason} (${title})`);
  await writeTextFile(path, put.text);
  invalidateSkills();
  await keepWithinCap(skill, put.text);
  recordFlowChange({
    kind: SKILL_LEARN,
    by: input.by,
    title: lesson,
    data: { skill, lesson, was } satisfies LessonPart,
    line: forUser`${input.by} changed a lesson in ${title}`,
    now: forUser`The old lesson is back in ${title}`,
    undoneText: forUser`Undone: ${title} has its old lesson again.`,
  });
  return { skill, lesson, path, note: forUser`It's changed in ${title} now, and Ash sees it in Settings → Changes → Bot changes with Undo.` };
}

/**
 * WP-242: records the skill just written and moves the least recently used learned skills out past the cap. Never
 * fails the lesson: a record or a move that cannot be made is tried again on the next lesson.
 */
async function keepWithinCap(skill: string, written: string): Promise<void> {
  try {
    const home = await homeDir();
    const file = joinPath(home, REGISTRY_FILE);
    const now = Date.now();
    const registry = noteLearned(parseRegistry(await readTextFile(file).catch(() => undefined)), skill, now, written);
    const current: Record<string, string | undefined> = {};
    for (const name of Object.keys(registry)) {
      current[name] = await readTextFile(joinPath(home, `.agents/skills/${name}/SKILL.md`)).catch(() => undefined);
    }
    const { evict, registry: left } = evictions(registry, current, skill);
    const kept = { ...left };
    if (evict.length) {
      const parent = await createPath(home, `${LET_GO_FOLDER}/${now}`, true);
      for (const name of evict) {
        try {
          await movePath(joinPath(home, `.agents/skills/${name}`), parent);
        } catch {
          // Still in place: it stays on the record and goes next time.
          kept[name] = registry[name];
        }
      }
      invalidateSkills();
    }
    await writeTextFile(file, `${JSON.stringify(kept, null, 2)}\n`);
  } catch {
    // The cap is housekeeping; the lesson itself is saved.
  }
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
