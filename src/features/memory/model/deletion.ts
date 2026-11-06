// WP-100: deleting a fact from the Memory screen takes it out of every copy the screen can reach. The doc row goes
// first, over the revision this window read, so a lost delete writes nothing anywhere else. A skill's lesson file is
// taken out after the row is saved, and a file that cannot be reached is said plainly rather than hidden.

import { copiesOf, deleteNote, type Copy } from "./copies";
import type { MemoryDoc, MemoryItem } from "./doc";
import { commitDoc, deleteItem } from "./review";

export type DeleteResult = { doc: MemoryDoc; deleted: boolean; note: string };

/**
 * Deletes one fact and every copy the screen can remove, and returns the one plain sentence naming what still holds it.
 * A skill lesson that cannot be taken out leaves the fact deleted with a note saying the file still has it; the delete
 * is not undone for it, because a lesson left behind is a copy the person can still find and remove.
 */
export async function deleteMemory(
  load: () => Promise<MemoryDoc>,
  save: (revision: number, doc: MemoryDoc) => Promise<boolean>,
  takeLesson: (name: string, lesson: string) => Promise<void>,
  id: string,
): Promise<DeleteResult> {
  let found: MemoryItem | undefined;
  const result = await commitDoc(load, save, (doc) => {
    const item = doc.items.find((have) => have.id === id);
    found = item;
    return item ? deleteItem(doc, id) : doc;
  });
  if (!result.applied || !found) return { doc: result.doc, deleted: false, note: "" };

  const item = found;
  const copies: Copy[] = copiesOf(item);
  let skillCleared = true;
  if (copies.some((copy) => copy.kind === "skill") && item.skill) {
    try {
      await takeLesson(item.skill.name, item.skill.lesson);
    } catch {
      skillCleared = false;
    }
  }
  return { doc: result.doc, deleted: true, note: deleteNote(copies, skillCleared) };
}
