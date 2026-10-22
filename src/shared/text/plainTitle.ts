/**
 * A chat or conversation title as plain text (Alfred's r50 blind run, 22 Oct): a title is often the first message, so it
 * can hold markdown ("The current branch is **pm/pages-live**..."), which showed raw in the header, the conversation list
 * and the delete confirm. Links keep their words, code keeps its text, emphasis marks, headings, quotes and list marks
 * go, and it is one line. No cutting: callers that need a short title cut it themselves.
 */
export function plainTitle(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
