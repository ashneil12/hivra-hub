// The evidence behind a done or fixed claim (board I5; Ash, 22 Oct: "don't say 'fixed' until it's tested, and say how
// confident you are"). A turn that says it is done has to carry what was actually run and how sure it is, and the app
// has to be able to see the difference between "a check ran and passed" and "it says so".
//
// The app already keeps everything this needs: a turn's tool blocks are the commands it ran, with their status. This
// reads them; it never runs anything and never spends a model call. A check the turn itself ran and that passed is
// `verified`; checks it only names, or a lower confidence it declares itself, are `likely`; anything else is `guess` —
// and a `guess` claim is what the cards show as not proven, so an untested "fixed" is visibly not-done.
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
  /** A claim with a passing check behind it: the app may show it as done. */
  backed: boolean;
  /** One plain line for a card or a Lead: what it says, what was seen, how sure that makes it. */
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

/** The checks the turn actually ran, one per command, with whether the app saw each finish cleanly. */
export function ranChecks(turn: readonly Block[]): RanCheck[] {
  const out: RanCheck[] = [];
  for (const block of turn) {
    if (!block.tool) continue;
    const command = commandOf(block);
    if (!command || !CHECK_COMMAND.test(command)) continue;
    // A command still running has not passed; a repeated command counts once (its last run wins).
    if (block.tool.status === "pending") continue;
    const short = shortCommand(command);
    const check: RanCheck = { command: short, passed: block.tool.status === "completed" };
    const at = out.findIndex((entry) => entry.command === short);
    if (at >= 0) out[at] = check;
    else out.push(check);
  }
  return out;
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

/**
 * What the turn's own claim is worth. Undefined when it makes no done/fixed claim, so an ordinary reply gets no card
 * line and no report noise.
 */
export function claimEvidenceOf(text: string, turn: readonly Block[] = []): ClaimEvidence | undefined {
  const claim = claimOf(text);
  if (!claim) return undefined;
  const ran = ranChecks(turn);
  const said = saidChecks(text);
  const declared = declaredConfidence(text);
  const failed = ran.filter((check) => !check.passed);
  const named = said.some((item) => ran.some((check) => about(check.command, item)));
  let confidence: ClaimConfidence;
  if (failed.length) confidence = "guess";
  else if (ran.length) confidence = "verified";
  else if (named || said.length || declared === "likely" || MENTIONS_CHECKS.test(text)) confidence = "likely";
  else confidence = "guess";
  const evidence = { claim, confidence, ran, said, ...(declared ? { declared } : {}), backed: confidence === "verified" };
  return { ...evidence, line: claimLine(evidence) };
}

/** One plain line: what it says, what the app saw it run, and what that makes it worth. */
export function claimLine(evidence: Omit<ClaimEvidence, "line">): string {
  const it = `Says it's ${evidence.claim}`;
  const failed = evidence.ran.find((check) => !check.passed);
  if (failed) return `${it}, but a check it ran failed (${failed.command}). Not proven.`;
  if (evidence.confidence === "verified") {
    const names = evidence.ran.map((check) => check.command);
    const many = names.length === 1 ? "1 check" : `${names.length} checks`;
    return `${it}: ${many} ran in this turn and passed (${names.join("; ")}).`;
  }
  if (evidence.confidence === "likely") {
    const named = evidence.said[0];
    if (named) return `${it} and names ${named}, but no test or type-check run was seen in this turn.`;
    if (evidence.declared === "likely") return `${it}, at the confidence it declares itself; no check the app can see ran.`;
    return `${it} and says the checks passed, but the app saw no test or type-check run in this turn.`;
  }
  return `${it}, but nothing the app can see was run to check it. Not proven.`;
}
