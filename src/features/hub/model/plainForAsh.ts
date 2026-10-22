/**
 * A Mono's words as Ash reads them on a card: no raw task or session ids ("t-9bd8c17f", "(task t-618b…)") and no
 * absolute folder paths (a path reads as its last part: "/Users/ash/Worktrees/hub-c7/src/Today.tsx" -> "Today.tsx").
 * Hub lead live 22 Oct. The Mono's own tools keep the real ids; this is only what is shown.
 */
const TASK_ID = /\s*\((?:task\s+)?t-[0-9a-f]{6,}(?:-[0-9a-f]{2,})*\)|(?:\s+(?:in|as|for|under)\s+task|\s*\btask)?\s+t-[0-9a-f]{6,}(?:-[0-9a-f]{2,})*\b/gi;
const PATH = /(^|[\s(“"'`])((?:~|\/Users|\/home|\/private|\/tmp|\/var|\/opt|\/Volumes)(?:\/[^\s/)”"'`,;:]+)+)\/?/g;

export function plainForAsh(text: string): string {
  return text
    .replace(TASK_ID, "")
    .replace(PATH, (_m, lead: string, path: string) => lead + (path.split("/").filter(Boolean).pop() ?? path))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1");
}
