// What "Delete mono…" really does (r30f, Critiquito: say only what happens). App.tsx onDeleteMono:
// - deletes its current 1:1 chat (onRemoveHistorySession "delete": the session record and its transcript);
// - removes it from the roster (removeMono: the WebView cache and MONOS.json), clears its chat background, and marks a
//   default-team Mono as removed by Ash so the team repair doesn't bring it back;
// - drops its team from the hub (forgetMonoTeam; the team's folder stays on disk).
// Its habits stop because the habit runner only walks the roster (useMonoHabits). Nothing touches its folder in the
// Monos' home: SOUL.md, MEMORY.md, memory/ notes, habits.json and chats.json (with older chats' ids) all stay.
import { monoHomeShown } from "../../hub/model/hubMcp";

/** The confirm's line before "This can't be undone.": what goes, and where what stays is kept. */
export function monoDeleteDetail(hasChat: boolean, home = monoHomeShown()): string {
  const stay = `Its soul and memory stay in ${home}/.`;
  return hasChat ? `Its current chat will be deleted and its habits stop. ${stay}` : stay;
}
