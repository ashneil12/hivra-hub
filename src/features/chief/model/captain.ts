// WP-215: the order a captain answers in. Steps 1 to 5 are plain code. No model call.
// The switch is the Autopilot per-project switch that already exists (WP-213's header reads it later).

import { foldDecisionKey } from "../../hub/model/decisionKey";
import { callText, redListCategory } from "../../autopilot/model/redList";
import { questionVeto } from "../../autopilot/model/reviewerRules";

export const TURN_CAP = 20;
export const HOUR_MS = 60 * 60 * 1000;
export const PASS_UP_MS = 10 * 60 * 1000;

const OWNER_PREFIXES = [
  "irreversible/",
  "fresh-eyes/",
  "fresh-eyes-start/",
  "fanout-again/",
  "gate/",
  "secret/",
  "security/",
  "security-review/",
];

/** A key only the owner answers, after the same fold the store uses. */
export function isOwnerKey(key: string | null | undefined): boolean {
  if (typeof key !== "string" || !key.trim()) return false;
  const folded = foldDecisionKey(key);
  if (folded === "charter" || folded === "captain-cap") return true;
  if (folded.startsWith("charter/") || folded.startsWith("captain-cap/") || folded.startsWith("budget/")) return true;
  return OWNER_PREFIXES.some((prefix) => folded.startsWith(prefix));
}

export type NamedAnswer = { answer: string; label: string };
export type CaptainRule = { when: string; answer: string };

export type CaptainTurn =
  | { pick: string; reason: string }
  | { passUp: true; suggest?: string; reason: string };

export type CaptainQuestion = {
  project: string;
  monoId: string;
  decisionKey?: string;
  question: string;
  options?: readonly string[];
  recommendation?: string;
  confident?: boolean;
  why?: string;
  /** Which first mate was confident. "The first mate" until a department is named. */
  department?: string;
  rules?: readonly CaptainRule[];
  standing?: NamedAnswer | null;
  /** Empty until WP-216. A row passed in is used, so the step is real. */
  learned?: NamedAnswer | null;
  moneyOverLimit?: boolean;
  /** Off sends the question to the owner, as today. */
  switchOn: boolean;
  now: number;
  pendingSince?: number;
  turns?: readonly number[];
  /** Step 6 only. Absent means the engine is down: no model call. */
  turn?: (input: { question: string; options: readonly string[] }) => CaptainTurn;
};

export type CaptainResult =
  | { kind: "ask-owner"; reason: string; suggest?: string; line?: string }
  | { kind: "answer"; answer: string; reason: string; answeredBy: string; step: 2 | 3 | 4 | 5 | 6; recordTurn?: boolean }
  | { kind: "waiting"; reason: string };

export function suggestLine(option: string): string {
  return `Chief of Staff suggests: ${option}`;
}

export function handoffLine(department: string, title: string): string {
  return `Handed to ${department}: ${title}`;
}

export function raiseCap(): never {
  throw new Error("The captain cannot raise its own turn cap.");
}

export function raiseBudget(): never {
  throw new Error("The captain cannot raise a budget.");
}

function recentTurns(turns: readonly number[] | undefined, now: number): number[] {
  return (turns ?? []).filter((at) => Number.isFinite(at) && at <= now && now - at < HOUR_MS);
}

function matched(options: readonly string[] | undefined, answer: string): string | null {
  const wanted = answer.trim();
  if (!wanted) return null;
  if (!options || options.length === 0) return wanted;
  return options.find((option) => option.trim().toLowerCase() === wanted.toLowerCase()) ?? null;
}

function firstRule(rules: readonly CaptainRule[] | undefined, question: string, key?: string): CaptainRule | null {
  if (!rules) return null;
  const hay = `${key ?? ""}\n${question}`.toLowerCase();
  for (const rule of rules) {
    const when = rule.when?.trim().toLowerCase();
    if (when && hay.includes(when)) return rule;
  }
  return null;
}

function passUp(reason: string, suggest?: string): CaptainResult {
  const option = suggest?.trim();
  return option
    ? { kind: "ask-owner", reason, suggest: option, line: suggestLine(option) }
    : { kind: "ask-owner", reason };
}

/**
 * One question, in the captain's order. Stops at the first step that applies.
 * The clock is `now`. Nothing here sleeps, and steps 1 to 5 never call `turn`.
 */
export function captainDecide(input: CaptainQuestion): CaptainResult {
  if (!input || input.switchOn !== true) return { kind: "ask-owner", reason: "The switch is off." };
  const question = typeof input.question === "string" ? input.question : "";
  const options = (input.options ?? []).filter((option): option is string => typeof option === "string");
  const recommendation = typeof input.recommendation === "string" ? input.recommendation : "";
  const why = typeof input.why === "string" ? input.why.trim() : "";
  const text = callText(question, recommendation, why, ...options);

  // 1. Always the owner's, even when a later step would answer.
  if (isOwnerKey(input.decisionKey) || input.decisionKey === "charter") {
    return { kind: "ask-owner", reason: "This one is only the owner's." };
  }
  if (input.moneyOverLimit === true) return { kind: "ask-owner", reason: "Money is past the owner's limit." };
  if (redListCategory(text) || questionVeto({ question, recommendation, options })) {
    return { kind: "ask-owner", reason: "This one is on the red list." };
  }

  const by = `captain:${input.monoId}`;

  // 2. A rule the owner set.
  const rule = firstRule(input.rules, question, input.decisionKey);
  if (rule) {
    const answer = matched(options, rule.answer);
    if (answer) return { kind: "answer", answer, reason: `rule: ${rule.when.trim()}`, answeredBy: by, step: 2 };
  }

  // 3. A standing answer.
  if (input.standing) {
    const answer = matched(options, input.standing.answer);
    if (answer) {
      return { kind: "answer", answer, reason: `standing answer: ${input.standing.label}`, answeredBy: by, step: 3 };
    }
  }

  // 4. A learned preference. The table is empty until WP-216, so this is a no-op unless a row is passed in.
  if (input.learned) {
    const answer = matched(options, input.learned.answer);
    if (answer) {
      return { kind: "answer", answer, reason: `learned preference: ${input.learned.label}`, answeredBy: by, step: 4 };
    }
  }

  // 5. A first mate's pick, marked confident, and already off the red list.
  if (input.confident === true && recommendation.trim()) {
    // The mate's own words are the answer, even when they are not one of the options. Step 6 is the one that must pick from the list.
    const answer = matched(options, recommendation) ?? recommendation.trim();
    if (answer) {
      const who = (input.department ?? "The first mate").trim() || "The first mate";
      return {
        kind: "answer",
        answer,
        reason: why ? `${who} was confident: ${why}` : `${who} was confident`,
        answeredBy: by,
        step: 5,
      };
    }
  }

  // 6. One short turn, or pass it up. No model call unless `turn` is passed in.
  const now = input.now;
  const pendingSince = Number.isFinite(input.pendingSince) ? (input.pendingSince as number) : now;
  if (now - pendingSince >= PASS_UP_MS) {
    return passUp("The captain did not answer within 10 minutes.", recommendation);
  }
  if (recentTurns(input.turns, now).length >= TURN_CAP) {
    return passUp("The captain is out of turns this hour.", recommendation);
  }
  if (!input.turn) {
    return { kind: "waiting", reason: "The engine is down. It passes up if it is still open in 10 minutes." };
  }
  let picked: CaptainTurn;
  try {
    picked = input.turn({ question, options });
  } catch {
    return { kind: "waiting", reason: "The captain's turn did not finish. It passes up if it is still open in 10 minutes." };
  }
  if (!picked || typeof picked !== "object" || ("passUp" in picked && picked.passUp)) {
    const suggest = picked && "suggest" in picked && typeof picked.suggest === "string" ? picked.suggest : recommendation;
    const reason = picked && "reason" in picked && typeof picked.reason === "string" && picked.reason.trim() ? picked.reason.trim() : "Passed up.";
    return passUp(reason, suggest);
  }
  const answer = "pick" in picked && typeof picked.pick === "string" ? matched(options, picked.pick) : null;
  if (!answer) return passUp("The captain's pick was not one of the options.", recommendation);
  const reason = "reason" in picked && typeof picked.reason === "string" && picked.reason.trim() ? picked.reason.trim() : "one line";
  return { kind: "answer", answer, reason: `captain turn: ${reason}`, answeredBy: by, step: 6, recordTurn: true };
}

/** Questions left with the captain long enough to pass up. Duplicates are returned once. */
export function passUpDue(pending: readonly { id: string; since: number }[], now: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of pending) {
    if (!row || typeof row.id !== "string" || seen.has(row.id)) continue;
    if (Number.isFinite(row.since) && now - row.since >= PASS_UP_MS) {
      seen.add(row.id);
      out.push(row.id);
    }
  }
  return out;
}

/**
 * A captain pass-up waits for the owner. A delivery that failed (the chat is busy or gone) does not:
 * that one is tried again. So is a captain that is still waiting (the engine is down, or its turn did not finish).
 */
export function captainAnswerHeld(reason: string): boolean {
  return /red line|waits for the owner|chief of staff suggests|passed up|out of turns|owner's limit|only the owner|on the red list|did not answer within|not one of the options|switch is off/i.test(
    reason,
  );
}

/**
 * Marks one step-6 turn, or refuses when the hour already holds the cap.
 * The check and the write are one assignment, with no wait between them.
 * Two windows still meet in the store, which counts the same cap inside one transaction.
 */
export function claimTurn(ledger: { turns: number[] }, now: number, cap = TURN_CAP): boolean {
  const recent = ledger.turns.filter((at) => Number.isFinite(at) && at <= now && now - at < HOUR_MS);
  if (recent.length >= cap) {
    ledger.turns = recent;
    return false;
  }
  recent.push(now);
  ledger.turns = recent;
  return true;
}
