// r91 (Critiquito, Being built row 09): a worker's question showed as "Asked: Blocked. Ash has not signed off …
// `DELETE /tallies/:id` … `{ ok: true }` (`fc23fe1`)". Being built says it in one plain line, in Ash's words: no
// backticks, routes, JSON or commit hashes, and a blocked worker says what it waits on ("Blocked until you choose …").

const MAX = 120;

/** The text with code taken out: code spans, JSON, routes, status codes in brackets, commit hashes. */
function withoutCode(text: string): string {
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S*/g, " ")
    .replace(/(^|\s)\/[\w:./-]+/g, " ")
    .replace(/\b[0-9a-f]{7,40}\b/g, " ")
    .replace(/\(\s*[^()]*\d[^()]*\)/g, (m) => (/[a-z]{4,}\s+[a-z]{4,}/i.test(m) ? m : " "))
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+([,.;:?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const sentences = (text: string) => text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
const hadCode = (s: string) => /`|\{|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\b[0-9a-f]{7,40}\b/.test(s);

function cut(line: string): string {
  const one = line.replace(/[\s.]+$/, "");
  if (one.length <= MAX) return one;
  return `${one.slice(0, MAX).replace(/\s+\S*$/, "")}…`;
}

/** One plain line for what a worker asked, for Being built ("Asked: …" is added by the caller). */
export function plainAskedLine(text: string): string {
  const all = sentences(text.replace(/\s*\n+\s*/g, " "));
  if (/^blocked\b/i.test(text.trim())) {
    for (const s of all) {
      const choose = s.match(/\b(?:still\s+)?(?:has|have|needs?|need)\s+to\s+(choose|decide|pick|say)\s+(.+)$/i);
      if (choose) return cut(`Blocked until you ${choose[1].toLowerCase()} ${withoutCode(choose[2])}`);
    }
    for (const s of all) {
      const sign = s.match(/\b(?:has|have)\s+not\s+signed\s+(?:that\s+|it\s+)?off(?:\s+on)?\s*([^,.;]*)/i);
      if (sign) return cut(`Blocked until you sign off ${withoutCode(sign[1]) || "on it"}`);
    }
  }
  const plain = all.filter((s) => !hadCode(s) && !/^blocked\.?$/i.test(s));
  const line = plain.length ? plain.slice(0, 2).join(" ") : withoutCode(all.join(" "));
  return cut(line || "a question");
}
