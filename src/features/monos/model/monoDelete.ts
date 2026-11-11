// What "Delete mono…" really does (r30f, Critiquito: say only what happens). App.tsx onDeleteMono:
// - moves its current 1:1 chat to the trash with it (onRemoveHistorySession "delete", after the trash), and with it its
//   further chats and its own chat in each project (G2: they no longer stay behind as plain chats);
// - removes it from the roster (removeMono: the WebView cache and MONOS.json), clears its chat background, and marks a
//   default-team Mono as removed by Ash so the team repair doesn't bring it back;
// - drops its team from the hub (forgetMonoTeam).
// Its habits stop because the habit runner only walks the roster (useMonoHabits). WP-76: its files, including the soul
// and memory, move to the trash for 30 days and can be put back. The copy does not name a folder path.

/** The confirm's line before "This can't be undone.": the chat stops, and the files can be put back. */
export function monoDeleteDetail(hasChat: boolean): string {
  const kept = "Its files go to the trash for 30 days, and you can put them back.";
  return hasChat
    ? `Its current chat is stopped and moved to the trash with it, and its habits stop. ${kept}`
    : kept;
}
