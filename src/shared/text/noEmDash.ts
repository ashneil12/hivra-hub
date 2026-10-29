/**
 * Ash's rule: no em dashes in anything he reads. Room posts already drop them when they are saved (hub roomTurns
 * cleanPost); a chat reply (a coding-team Lead or worker, a Mono 1:1) drops them where it renders, so the ~1 KB hub note
 * doesn't have to grow a line for it (r74, CoS call after the r72 blind p01/p02 grades). Same swap as room posts:
 * " — " / " – " and a bare "—" become ", ". Code is left as written: fenced blocks and `inline code` keep their dashes.
 */
const FENCE = /^([ \t]*)(`{3,}|~{3,})/;

function proseOnly(line: string): string {
  // Split on inline code spans; even parts are prose.
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[ \t]+[—–][ \t]+/g, ", ").replace(/[ \t]*—[ \t]*/g, ", ")))
    .join("");
}

export function withoutEmDashes(text: string): string {
  if (!text || !text.includes("—") && !/[ \t]–[ \t]/.test(text)) return text;
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const open = FENCE.exec(line);
      if (fence) {
        if (open && open[2][0] === fence[0] && open[2].length >= fence.length) fence = null;
        return line;
      }
      if (open) {
        fence = open[2];
        return line;
      }
      return proseOnly(line);
    })
    .join("\n");
}
