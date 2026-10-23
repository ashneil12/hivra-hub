// The evidence behind a done or fixed claim (board I5; Ash, 22 Oct: "don't say 'fixed' until it's tested, and say how
// confident you are"). A turn that says it is done has to carry what was actually run and how sure it is, and the app
// has to be able to see the difference between "a check ran and passed" and "it says so".
//
// The app already keeps everything this needs: a turn's tool blocks are the commands it ran, with their status. This
// reads them; it never runs anything and never spends a model call. A check the turn itself ran and that passed counts
// only when it is evidence FOR THIS CHANGE: it has to come after the turn's last edit, and a check aimed at particular
// files has to name the files the turn changed (a project-wide `npm test` covers any change). A stale or unrelated run
// is not evidence — that is how an unrelated tool call used to manufacture confidence. Checks the reply only names, or
// a lower confidence it declares itself, are `likely`; anything else is `guess`. A claim that is not verified is shown
// as "not yet confirmed", says what is missing (the check that did not run, the file never read, the test never run),
// and stays open.
//
// Nothing here retries, blocks or rewrites a reply: it only describes it. The surfaces that use it are the check card
// (ui/CheckTurnCard.tsx), a worker's report to its Lead (monos/model/monoSessionCompletion.ts) and a coding team's
// report (monos/ui/TeamReportCard.tsx).
import type { Block } from "../../sessions/model/session";

/** How much the app can stand behind a claim. */
export type ClaimConfidence = "verified" | "likely" | "guess";

/** One check-like command the turn ran, and whether it passed. */
export type RanCheck = {
  /** The command as the turn ran it: one line, shortened. */
  command: string;
  /** The app saw it finish cleanly. */
  passed: boolean;
};

export type ClaimEvidence = {
  /** The claim's own word: fixed, done, finished, shipped, works, working. */
  claim: string;
  /**
   * verified: a check the app can see ran in this turn and passed. likely: the reply names checks, or says it is only
   * likely, and the app saw none. guess: neither — nothing behind the claim that the app can see.
   */
  confidence: ClaimConfidence;
  /** What the turn actually ran that counts as a check. */
  ran: RanCheck[];
  /** Checks the reply says it ran, in its own words ("Checks: npx vitest run src/x (7 passed)"). */
  said: string[];
  /** A confidence the reply declared itself ("Confidence: likely"). */
  declared?: ClaimConfidence;
  /** The checks that count as evidence for this claim: they passed after the last change and cover what it changed. */
  counted: RanCheck[];
  /** A claim with a passing check behind it, after the last change: the app may show it as done. */
  backed: boolean;
  /** What would make it confirmed, in plain words: the check that didn't run, the file never read. Empty when backed. */
  missing: string[];
  /** One plain line for a card or a Lead: what it says, what was seen, how sure that makes it, what is missing. */
  line: string;
};

const CONFIDENCE = /^(verified|likely|guess)$/i;

/** The last thing the chat said in a turn: its answer, not a tool call or a hidden note. */
export function lastReply(turn: readonly Block[]): string {
  for (let i = turn.length - 1; i > 0; i--) {
    const block = turn[i];
    if (block.role === "assistant" && !block.tool && !block.internal && block.text.trim()) return block.text.trim();
  }
  return "";
}

/** The reply's own done/fixed claim, if it makes one: "Fixed: ...", "Done — ...", "It's working now". */
export function claimOf(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw
      .trim()
      .replace(/^#{1,6}\s*/, "")
      .replace(/\*\*/g, "")
      .replace(/^[-*+•>]\s+/, "")
      .replace(/^[*_`~]+/, "");
    const leads = line.match(/^(fixed|done|finished|shipped|works|working)\b(?=[\s:.!,;—–-]|$)/i);
    if (leads) return leads[1].toLowerCase();
    const says = line.match(/^(?:it(?:'s| is)|this is|that's|now)\s+(fixed|done|working)\b/i);
    if (says) return says[1].toLowerCase();
  }
  return undefined;
}

/** A confidence the reply declared itself, if any. */
export function declaredConfidence(text: string): ClaimConfidence | undefined {
  const found = text.match(/^\s*confidence\s*[:\-—]\s*(\w+)/im);
  const word = found?.[1] && CONFIDENCE.test(found[1]) ? found[1].toLowerCase() : undefined;
  return word as ClaimConfidence | undefined;
}

/** The checks the reply says it ran, one item each: "Checks: npx vitest run src/a (7 passed); tsc" gives two. */
export function saidChecks(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const found = raw.trim().match(/^(?:checks?|ran|tested|tests?)\s*[:\-—]\s*(.+)$/i);
    if (!found) continue;
    for (const part of found[1].split(/;\s*|\s+\|\s+/)) {
      const item = part.trim().replace(/^[-*•]\s*/, "");
      if (item && !/^(none|nothing|n\/a)\b/i.test(item)) out.push(item);
    }
  }
  return out;
}

/**
 * A command that is a check: a test runner, a type check, a linter, a build check. Deliberately narrow — a read or a
 * git command is not evidence that anything works.
 */
const CHECK_COMMAND =
  /(?:^|[\s;&|(])(?:npx\s+)?(?:vitest|jest|pytest|playwright|cypress|tsc|eslint|biome|ruff|mypy)\b|(?:^|[\s;&|(])cargo\s+(?:test|check|clippy|nextest)\b|(?:^|[\s;&|(])go\s+test\b|(?:^|[\s;&|(])swift\s+test\b|(?:^|[\s;&|(])make\s+(?:test|check|verify)\b|(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|[\w:-]*:test|[\w:-]*:check)\b/i;

/** The command behind a tool block, as the app records it (an execute tool's title is the command itself). */
function commandOf(block: Block): string {
  const tool = block.tool;
  if (!tool) return "";
  const shell = tool.preview?.kind === "shell" ? tool.preview.title : undefined;
  return (tool.title ?? shell ?? "").trim();
}

function shortCommand(command: string): string {
  const one = command.split("\n")[0].replace(/\s+/g, " ").trim();
  return one.length > 90 ? `${one.slice(0, 89).trimEnd()}…` : one;
}

/** A check the turn ran, and where in the turn it ran (so it can be compared with the last change). */
type CheckRun = RanCheck & { at: number };

function checkRuns(turn: readonly Block[]): CheckRun[] {
  const out: CheckRun[] = [];
  turn.forEach((block, at) => {
    if (!block.tool) return;
    const command = commandOf(block);
    if (!command || !CHECK_COMMAND.test(command)) return;
    // A command still running has not passed; a repeated command counts once (its last run wins).
    if (block.tool.status === "pending") return;
    const short = shortCommand(command);
    const check: CheckRun = { command: short, passed: block.tool.status === "completed", at };
    const seen = out.findIndex((entry) => entry.command === short);
    if (seen >= 0) out[seen] = check;
    else out.push(check);
  });
  return out;
}

/** The checks the turn actually ran, one per command, with whether the app saw each finish cleanly. */
export function ranChecks(turn: readonly Block[]): RanCheck[] {
  return checkRuns(turn).map(({ command, passed }) => ({ command, passed }));
}

/** Whether a tool block changed a file: an edit or a write, however the provider labels it. */
function changedSomething(block: Block): boolean {
  const tool = block.tool;
  if (!tool) return false;
  return (
    tool.kind === "edit" ||
    tool.kind === "write" ||
    tool.preview?.kind === "write" ||
    /^(?:edit|write|multi_?edit|apply_?patch|create|delete|move|rename)\b/i.test(tool.title ?? "")
  );
}

/** A token that names a file ("src/save.ts", "./a/b.tsx"): a slash and an extension. */
const LOOKS_LIKE_PATH = /^[\w@./\\-]*[/\\][\w@./\\-]*\.[a-z0-9]{1,6}$/i;

/** The files a tool block names, as written (absolute or relative). */
function filesOf(block: Block): string[] {
  const out = new Set<string>();
  for (const path of block.tool?.paths ?? []) out.add(path);
  if (block.tool?.preview?.path) out.add(block.tool.preview.path);
  for (const token of (block.tool?.title ?? "").split(/\s+/)) {
    const clean = token.replace(/^["'`(\[]+|["'`)\].,;:]+$/g, "");
    if (LOOKS_LIKE_PATH.test(clean)) out.add(clean);
  }
  return [...out];
}

/** The name a path is really about: "src/save.test.ts" → "save". */
function stem(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path;
  return name
    .replace(/\.(?:test|spec)(?=\.[^.]+$)/i, "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
}

/** The file name of a path, for a plain-English line: "/a/b/save.ts" → "save.ts". */
function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** A path token shortened for a line, so one long command can't fill it. */
function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text;
}

/**
 * A check aimed at particular files ("npx vitest run src/a.test.ts"), not the whole project ("npm test"). A path with no
 * extension (a directory, or an executable like /opt/homebrew/bin/npm) counts as the whole project: the app must not
 * narrow a check on a guess about what a bare word means.
 */
const NARROW_CHECK = /(?:^|\s)(?:\.{0,2}\/)?[\w@.-]*[/\\][\w./\\@-]*\.[a-z0-9]{1,6}\b|(?:^|\s)[\w-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/i;

/**
 * Whether a check is about the files this turn changed. A project-wide check (npm test, tsc --noEmit, cargo test)
 * covers any change; a check aimed at particular files counts only when it names the same file the turn changed.
 */
function aboutChange(command: string, changed: readonly string[]): boolean {
  if (!changed.length || !NARROW_CHECK.test(command)) return true;
  const commandStems = command.split(/\s+/).map((token) => stem(token));
  return changed.some((file) => commandStems.includes(stem(file)));
}

/** Files the reply names in backticks or as plain paths ("read `src/save.ts`"), for what was never opened. */
function filesNamedIn(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.split(/[\s,;()<>[\]"'`]+/)) {
    const clean = word.replace(/[.:!?]+$/, "");
    if (LOOKS_LIKE_PATH.test(clean) && !/^https?:/i.test(clean)) out.add(clean);
  }
  return [...out];
}

/** A reply that says checks passed in its own words, without a `Checks:` line: "12 tests pass", "lint is clean". */
const MENTIONS_CHECKS =
  /\b\d+\s+tests?\b|\btests?\s+(?:pass|passes|passed|are green|is green)\b|\btype[- ]?checks?\b|\blint(?:s|ed)?\s+(?:is\s+)?clean\b/i;

const words = (text: string) => text.toLowerCase().match(/[a-z0-9][a-z0-9._:/-]{2,}/g) ?? [];

/** Whether a named check and a run command are about the same thing (a shared path or tool name). */
function about(command: string, said: string): boolean {
  const mine = new Set(words(command));
  return words(said).some((word) => mine.has(word));
}

/** The changed files in one short phrase: "save.ts, route.ts". */
function changedNames(changed: readonly string[]): string {
  const names = [...new Set(changed.map(baseName))];
  if (!names.length) return "the change";
  return names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2} more` : "");
}

/** "a", "a and b", "a, b and c". */
function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What would make an unconfirmed claim confirmed, in plain words. A failed check needs a passing run; a change needs a
 * check after it that covers it; a named check needs to actually run; a file the reply talks about needs to have been
 * read. Empty only when the claim is backed.
 */
function whatMissing(input: {
  text: string;
  turn: readonly Block[];
  runs: readonly CheckRun[];
  said: readonly string[];
  lastChange: number;
  changed: readonly string[];
}): string[] {
  const { text, turn, runs, said, lastChange, changed } = input;
  const missing: string[] = [];
  const failed = runs.find((check) => !check.passed);
  if (failed) missing.push(`a passing run of ${clip(failed.command)}`);
  else if (lastChange >= 0 && !runs.some((check) => check.passed && check.at > lastChange)) {
    const file = filesOf(turn[lastChange])[0];
    missing.push(file ? `a check after the last edit (${baseName(file)})` : "a check after the last edit");
  } else if (lastChange >= 0) {
    // Checks ran after the change, but each was aimed at other files: none of them covers it.
    missing.push(`a check for what changed (${changedNames(changed)})`);
  } else if (said.length) {
    missing.push(`a run of ${clip(said[0])}`);
  } else {
    missing.push("a test run, a type check or a build in this turn");
  }
  // A file the reply names that the turn never opened reads like evidence it did not have.
  const opened = new Set(turn.flatMap(filesOf).map(stem));
  const unread = filesNamedIn(text).find((file) => !opened.has(stem(file)));
  if (unread) missing.push(`reading ${baseName(unread)}`);
  return missing.slice(0, 2);
}

/**
 * What the turn's own claim is worth. Undefined when it makes no done/fixed claim, so an ordinary reply gets no card
 * line and no report noise.
 */
export function claimEvidenceOf(text: string, turn: readonly Block[] = []): ClaimEvidence | undefined {
  const claim = claimOf(text);
  if (!claim) return undefined;
  const runs = checkRuns(turn);
  const said = saidChecks(text);
  const declared = declaredConfidence(text);
  const failed = runs.filter((check) => !check.passed);
  // The turn's last change, and the files it changed. Only a check after it can be evidence for what it did; a check
  // that ran before the edit says nothing about the edited code.
  const lastChange = turn.reduce((last, block, at) => (changedSomething(block) ? at : last), -1);
  const changed = [...new Set(turn.flatMap((block) => (changedSomething(block) ? filesOf(block) : [])))];
  const counted = runs.filter(
    (check) => check.passed && check.at > lastChange && aboutChange(check.command, changed),
  );
  const named = said.some((item) => runs.some((check) => about(check.command, item)));
  let confidence: ClaimConfidence;
  if (failed.length) confidence = "guess";
  else if (counted.length) confidence = "verified";
  else if (named || said.length || declared === "likely" || MENTIONS_CHECKS.test(text)) confidence = "likely";
  else confidence = "guess";
  const backed = confidence === "verified";
  const ran = runs.map(({ command, passed }) => ({ command, passed }));
  const missing = backed ? [] : whatMissing({ text, turn, runs, said, lastChange, changed });
  const evidence = {
    claim,
    confidence,
    ran,
    counted: counted.map(({ command, passed }) => ({ command, passed })),
    said,
    ...(declared ? { declared } : {}),
    backed,
    missing,
  };
  return { ...evidence, line: claimLine(evidence) };
}

/** One plain line: what it says, what the app saw it run, what that makes it worth, and what is still missing. */
export function claimLine(evidence: Omit<ClaimEvidence, "line">): string {
  const it = `Says it's ${evidence.claim}`;
  const failed = evidence.ran.find((check) => !check.passed);
  if (failed) return `${it}, but a check it ran failed (${failed.command}). Not proven. Missing: ${joinWords(evidence.missing)}.`;
  if (evidence.backed) {
    const names = evidence.counted.map((check) => check.command);
    const many = names.length === 1 ? "1 check" : `${names.length} checks`;
    return `${it}: ${many} ran in this turn and passed (${names.join("; ")}).`;
  }
  const named = evidence.said[0];
  const prose =
    evidence.confidence === "likely"
      ? named
        ? `${it} and names ${clip(named)}, but no test or type-check run was seen in this turn.`
        : evidence.declared === "likely"
          ? `${it}, at the confidence it declares itself; no check the app can see ran.`
          : `${it} and says the checks passed, but the app saw no test or type-check run in this turn.`
      : `${it}, but nothing the app can see was run to check it.`;
  // A guess is not proven; a likely claim is not yet confirmed. Both name what would settle it.
  const verdict = evidence.confidence === "guess" ? "Not proven." : "Not yet confirmed.";
  return `${prose} ${verdict} Missing: ${joinWords(evidence.missing)}.`;
}
