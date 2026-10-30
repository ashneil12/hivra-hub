/**
 * r94 (Critiquito e): a quiet note the app itself sent a chat (Self-repair, the hourly check, MonoCode) reads like the app
 * notes do ("The app asked this chat to retry"), not "Self-repair sent this chat a message". Undefined for a note from
 * another Mono, which keeps its name.
 */
export function appNoteTitle(from: string | undefined, line: string | undefined): string | undefined {
  const said = line ?? "";
  if (from === "Self-repair") {
    const stalled = /provider error|stalled|no progress|went quiet|stopped answering/i.test(said);
    if (/\bretr(?:y|ied|ies)\b|\bredoes\b|try again/i.test(said) && !/won't retry|didn't clear/i.test(said))
      return stalled ? "The app asked this chat to retry a stalled job" : "The app asked this chat to retry";
    if (stalled) return "The app told this chat a job has stalled";
    if (/carry on|pick (?:its|the) turn up/i.test(said)) return "The app asked this chat to carry on";
    return "The app sent this chat a note";
  }
  if (from === "Hourly check") return "The app's hourly check asked this chat how it's going";
  if (from === "MonoCode") return "The app sent this chat a note";
  return undefined;
}
