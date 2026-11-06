// WP-100: one memory can live in more than one place: the reviewed doc, the skill file a kept skill wrote its lesson
// into, and the chat or history draft it came from. Deleting a fact reaches every copy the screen can safely remove,
// and the screen says plainly about the ones it cannot (a chat's own words are the person's record, not a copy).

import type { MemoryItem } from "./doc";

export type CopyKind = "skill" | "changes" | "chat" | "draft";

/** A skill's folder name as a person says it: `reviewing-a-diff` reads "reviewing a diff". */
function skillWords(name: string): string {
  return name.split("-").filter(Boolean).join(" ");
}

export type Copy = {
  kind: CopyKind;
  /** Whether deleting the fact takes this copy out. A chat or a draft is left alone: only the fact goes. */
  removable: boolean;
  /** One plain sentence naming this copy, for the note the screen shows after a delete. */
  what: string;
  /** A skill's name in words, for the note: "reviewing a diff". */
  words?: string;
};

/**
 * Every place this fact lives. A skill's lesson file is a copy only once the person accepted the skill, because before
 * that nothing was written. A fact read from a history draft names that draft. A chat's words are always named: the
 * screen cannot take them out of the person's own transcript. A kept skill's lesson is also in Bot changes (the row
 * that put it in the file, with its own Undo); that record is not erased, so the screen names it too.
 */
export function copiesOf(item: MemoryItem): Copy[] {
  const copies: Copy[] = [];
  if (item.action === "skill" && item.skill && item.state === "confirmed") {
    const words = skillWords(item.skill.name);
    copies.push({ kind: "skill", removable: true, what: `The ${words} skill file`, words });
    copies.push({ kind: "changes", removable: false, what: "Settings, Changes, Bot changes" });
  }
  if (item.source.kind === "import") {
    copies.push({ kind: "draft", removable: false, what: "The draft it was imported from" });
  }
  copies.push({ kind: "chat", removable: false, what: "The chat it came from" });
  return copies;
}

/** A sentence starting in lower case, for after "Deleted here, but". */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The one sentence the screen shows after a delete, naming what still holds the fact. */
export function deleteNote(copies: readonly Copy[], skillCleared: boolean): string {
  const parts: string[] = [];
  const skill = copies.find((copy) => copy.kind === "skill");
  if (skill) {
    parts.push(
      skillCleared
        ? `Its lesson is no longer in the ${skill.words ?? "skill"} skill file.`
        : `The ${skill.words ?? "skill"} skill file still has that lesson.`,
    );
  }
  if (copies.some((copy) => copy.kind === "draft")) parts.push("The draft it was imported from still has its line.");
  if (copies.some((copy) => copy.kind === "changes")) {
    parts.push("Its change is still listed under Settings, Changes, Bot changes.");
  }
  if (copies.some((copy) => copy.kind === "chat")) parts.push("The chat it came from still has its words.");
  const rest = parts.join(" ");
  return skill && !skillCleared ? `Deleted here, but ${lowerFirst(rest)}` : `Deleted. ${rest}`;
}
