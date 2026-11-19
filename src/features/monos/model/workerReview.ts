// A worker's report ends with a self-review of its own work (A7): what it checked, how, and what it is still unsure
// about. The app parses that here and refuses a report without one, so "I checked it" is a fact on the row instead of
// a sentence in a prompt. The same three lines are asked for in the worker rules (agentAppTasks.ts) and checked again
// by the store (delegations.rs), so a report can't reach a Lead with the review missing.

/** What a worker says it checked, how, and what is not sure about. */
export type WorkerReview = { checked: string; how: string; unsure: string };

/** A line or two each, and a few lines in all: a record of the checks, not a second report. */
export const REVIEW_FIELD_MAX = 1_000;
export const REVIEW_TOTAL_MAX = 4_000;

/** The shape the worker is asked for, in one place, so the rules, the refusal and the re-ask cannot drift apart. */
export const SELF_REVIEW_SHAPE = `## Self-review
Checked: what you checked
How: how you checked it (the command, the test, the file you read)
Unsure: what you are still unsure about, or "nothing"`;

export type ReviewRuling =
  | { kind: "ok"; review: WorkerReview }
  | { kind: "refused"; reason: string };

const HEADING = /^\s{0,3}#{1,6}\s*self[\s-]?review\s*:?\s*[*_]*\s*$/i;
const ANY_HEADING = /^\s{0,3}#{1,6}\s/;
const FIELD = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?(checked|how|unsure)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
/** Answers that say there is nothing open, so the line is filled in and means it. */
const NOTHING_OPEN = /^(?:nothing|none|n\/a|na|nothing (?:else|more|yet|specific|outstanding)|no concerns?)\.?$/i;

const FIELD_NAME = { checked: "Checked", how: "How", unsure: "Unsure" } as const;
type FieldName = keyof typeof FIELD_NAME;

/** Soft line breaks inside a field become one line: the row and the Lead read it as a sentence, not a layout. */
function tidy(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().replace(/^[*_]+|[*_]+$/g, "").trim();
}

/**
 * The self-review at the end of a worker's report. The last `## Self-review` wins, so a report that quotes one earlier
 * (a template, an example) is read for the one the worker actually wrote. Refusals say what is wrong in the worker's
 * own terms, because the worker gets them back and has to fix the report.
 */
export function parseWorkerReview(reply: string): ReviewRuling {
  const lines = reply.split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADING.test(lines[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0)
    return {
      kind: "refused",
      reason: 'The report has no "## Self-review" section, so nothing in it is recorded as checked.',
    };

  const found: Partial<Record<FieldName, string>> = {};
  const seen = new Set<FieldName>();
  let current: FieldName | null = null;
  const parts: Record<FieldName, string[]> = { checked: [], how: [], unsure: [] };
  for (const line of lines.slice(at + 1)) {
    if (ANY_HEADING.test(line)) break;
    const field = FIELD.exec(line);
    if (field) {
      current = field[1]!.toLowerCase() as FieldName;
      seen.add(current);
      parts[current].push(field[2] ?? "");
      continue;
    }
    if (current && line.trim()) parts[current].push(line);
  }
  for (const name of Object.keys(parts) as FieldName[]) {
    const text = tidy(parts[name].join(" "));
    if (text) found[name] = text;
  }

  for (const name of ["checked", "how", "unsure"] as FieldName[]) {
    if (!seen.has(name))
      return { kind: "refused", reason: missingLine(name) };
    if (!found[name]) return { kind: "refused", reason: emptyLine(name) };
    if (isPlaceholder(name, found[name]!))
      return { kind: "refused", reason: templateLine(name) };
  }
  const review: WorkerReview = {
    checked: found.checked!,
    how: found.how!,
    unsure: found.unsure!,
  };
  // Ash 12 Nov: a long "How:" line failed a homepage refactor that worked. Length is a format matter, never the work's
  // verdict: an over-long line is cut to fit (the full text stays in the worker's report and chat), not refused.
  const cap = Math.min(REVIEW_FIELD_MAX, Math.floor(REVIEW_TOTAL_MAX / 3));
  for (const name of ["checked", "how", "unsure"] as FieldName[])
    if (review[name].length > cap) review[name] = `${review[name].slice(0, cap - 1).trimEnd()}…`;
  return { kind: "ok", review };
}

function missingLine(name: FieldName): string {
  if (name === "checked")
    return 'The self-review has no "Checked:" line, so nothing in it is recorded as checked.';
  if (name === "how")
    return 'The self-review has no "How:" line, so there is no record of how anything was checked.';
  return 'The self-review has no "Unsure:" line; say what is still open, or "nothing".';
}

/** A worker that pastes the template back has not written a review: the placeholders are not answers. */
const PLACEHOLDER: Record<FieldName, readonly string[]> = {
  checked: ["what you checked"],
  how: ["how you checked it", "how you checked it (the command, the test, the file you read)"],
  unsure: ["what you are still unsure about", 'what you are still unsure about, or "nothing"'],
};

function isPlaceholder(name: FieldName, text: string): boolean {
  const plain = text.toLowerCase().replace(/[.]$/, "").trim();
  return PLACEHOLDER[name].some((phrase) => phrase === plain);
}

function templateLine(name: FieldName): string {
  return `The self-review's "${FIELD_NAME[name]}:" line repeats the template; write what you actually did.`;
}

function emptyLine(name: FieldName): string {
  // "Checked: nothing" would be a false record, so an empty line is refused rather than read as "nothing to check".
  if (name === "checked") return 'The self-review\'s "Checked:" line is empty; say what you checked.';
  if (name === "how")
    return 'The self-review\'s "How:" line is empty; name the command, test or file you checked it with.';
  return 'The self-review\'s "Unsure:" line is empty; say what is still open, or "nothing".';
}

/** The follow-up turn an unaccepted report gets: the reason, the shape, and an explicit "don't start over". */
export function reviewAsk(reason: string): string {
  return `Your report came back without a self-review the app can record. ${reason}

Don't redo the work, and don't send the report again: it is kept as it was. Reply with only this section, filled in from the checks you already ran:

${SELF_REVIEW_SHAPE}`;
}

/**
 * r82: the report a re-asked worker sent first, joined to the self-review it sent back, so the row keeps one report and
 * the chat never shows it twice. A reply that repeated its report anyway (an older agent) is kept as it came.
 */
export function withEarlierReport(earlier: string, reply: string): string {
  const first = earlier.trim();
  const second = reply.trim();
  if (!first) return second;
  if (!second) return first;
  const opening = first.slice(0, 80);
  if (second.includes(opening)) return second;
  // A broken "## Self-review" the first report ended with gives way to the one sent back.
  const lines = first.split("\n");
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (HEADING.test(lines[i]!)) { cut = i; break; }
  const body = second.split("\n").some((l) => HEADING.test(l)) ? lines.slice(0, cut).join("\n").trimEnd() : first;
  return `${body}\n\n${second}`;
}

/**
 * r67 (Critiquito on r66): the re-ask rendered as if Ash had typed it. It goes as a hidden app turn with this quiet
 * system line instead (the same card Self-repair and Hourly check notes use), so the chat never shows it as his message.
 */
export function reviewAskNote(): { kind: "message"; from: string; line: string } {
  return { kind: "message", from: "MonoCode", line: "Asked for the self-review the report came back without" };
}

/** A review read back from the row's stored JSON, when it is still the right shape. */
export function storedReview(json: string | null | undefined): WorkerReview | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as Partial<WorkerReview>;
    if (typeof value?.checked !== "string" || typeof value.how !== "string" || typeof value.unsure !== "string")
      return undefined;
    return { checked: value.checked, how: value.how, unsure: value.unsure };
  } catch {
    return undefined;
  }
}

/** Whether an "Unsure:" answer says there is nothing open. */
export function nothingOpen(unsure: string): boolean {
  return NOTHING_OPEN.test(unsure.trim());
}
