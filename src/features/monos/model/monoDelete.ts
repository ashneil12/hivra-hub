// What "Delete mono…" really does (r30f, Critiquito: say only what happens). App.tsx onDeleteMono:
// - deletes its current 1:1 chat (onRemoveHistorySession "delete": the session record and its transcript);
// - removes it from the roster (removeMono: the WebView cache and MONOS.json), clears its chat background, and marks a
//   default-team Mono as removed by Ash so the team repair doesn't bring it back;
// - drops its team from the hub (forgetMonoTeam; the team's folder stays on disk).
// Its habits stop because the habit runner only walks the roster (useMonoHabits). Nothing touches its folder in the
// Monos' home: SOUL.md, MEMORY.md, memory/ notes, habits.json and chats.json (with older chats' ids) all stay.
// r30g (Critiquito): the copy says the soul and memory are kept, without a folder path.

/** The confirm's line before "This can't be undone.": what goes, and that the soul and memory are kept. */
export function monoDeleteDetail(hasChat: boolean): string {
  const kept = "Its soul and memory are kept.";
  return hasChat ? `Its current chat will be deleted and its habits stop. ${kept}` : kept;
}
