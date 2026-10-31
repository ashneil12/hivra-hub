/**
 * r102 (3, 05bc: "Of 40: 11 done, 1 already there, 1 blocked by your answer, 27 parked." over 10 Done and 28 Parked
 * bullets; 9: "already there" is done, and the count line opens the reply). A status answer's count line is checked
 * against the groups it sums up and corrected before Ash reads it.
 */
const COUNT_LINE = /^[*_]*Of (\d+):\s*([^\n]+?)[.*_\s]*$/m;
const BUCKET = /^(\d+)\s+(.+)$/;
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/;

type Bucket = { n: number; label: string };

const key = (label: string) => {
  const l = label.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (/^already (?:there|done|in)/.test(l)) return "done";
  if (/^blocked/.test(l)) return "blocked";
  if (/^waiting/.test(l)) return "waiting";
  return l.split(" ")[0]!;
};

/** The groups under the count line: a heading line ("Done.", "Parked:", "Blocked by your answers") and its list items. */
function groups(lines: readonly string[]): Map<string, number> | null {
  const out = new Map<string, number>();
  let current: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (ITEM.test(line)) {
      if (!current) return null;
      out.set(current, (out.get(current) ?? 0) + 1);
      continue;
    }
    const head = /^[*_#\s]*(done|already there|running|waiting on you|blocked by your answers?|parked)\b/i.exec(line);
    current = head ? key(head[1]!) : undefined;
  }
  return out;
}

export function withCountLineChecked(text: string): string {
  const m = COUNT_LINE.exec(text);
  if (!m) return text;
  const buckets: Bucket[] = m[2]!
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((part) => BUCKET.exec(part.trim()))
    .filter((b): b is RegExpExecArray => !!b)
    .map((b) => ({ n: Number(b[1]), label: b[2]!.trim() }));
  if (!buckets.length) return text;
  // "already there" folds into done.
  const merged: Bucket[] = [];
  for (const b of buckets) {
    const k = key(b.label);
    const same = merged.find((x) => key(x.label) === k);
    if (same) same.n += b.n;
    else merged.push({ n: b.n, label: k === "done" ? "done" : b.label });
  }
  // Recount from the groups below when every bucket has its own listed group.
  const rest = text.slice(m.index + m[0].length).split("\n");
  const listed = groups(rest);
  if (listed && merged.every((b) => listed.has(key(b.label))) && [...listed.keys()].every((k) => merged.some((b) => key(b.label) === k)))
    for (const b of merged) b.n = listed.get(key(b.label))!;
  const total = merged.reduce((sum, b) => sum + b.n, 0);
  const of = listed && merged.every((b) => listed.has(key(b.label))) ? total : Math.max(Number(m[1]), total);
  const line = `Of ${of}: ${merged.map((b) => `${b.n} ${b.label}`).join(", ")}.`;
  // The count line opens the reply.
  const before = text.slice(0, m.index).trim();
  const after = text.slice(m.index + m[0].length).replace(/^\n+/, "");
  return [line, before, after].filter(Boolean).join("\n\n");
}
