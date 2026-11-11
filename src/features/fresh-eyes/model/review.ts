// WP-144: run cheap reviewers that see only the plan and a short reading list.
// A timeout or an unreachable reviewer is not a pass and not a final failure.

import { roleModel, type Route } from "../../crew/model/resolve";
import { PERSONA_BRIEF, personasFor, type Persona } from "./personas";

export type Reading = { path: string; text: string };

export type Finding = {
  persona: Persona;
  summary: string;
  break: string;
};

/** What one reviewer is sent. History is always empty. */
export type ReviewerTurn = {
  persona: Persona;
  model: string | null;
  effort: string | null;
  prompt: string;
  history: readonly [];
  /** Round 7: the reviewed project's folder, which the crew gate judges the reviewer against. */
  folder?: string;
};

export type ReviewerPort = {
  ask(turn: ReviewerTurn): Promise<string>;
};

export class ReviewerTimeout extends Error {
  readonly kind = "timeout";
  constructor(message = "The reviewer did not answer in time.") {
    super(message);
    this.name = "ReviewerTimeout";
  }
}

/** A timeout or an unreachable reviewer can be asked again. It is not a finding and not a pass. */
export function isNotFinal(error: unknown): boolean {
  if (error instanceof ReviewerTimeout) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /timed out|timeout|unavailable|not available|could not start|econnrefused/i.test(message);
}

/** Drop paths that could escape the reading list. Duplicates and empty text are dropped. */
export function readingEntries(value: unknown): Reading[] {
  if (!Array.isArray(value)) return [];
  const out: Reading[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const path = cleanPath(row.path);
    if (!path || seen.has(path)) continue;
    if (typeof row.text !== "string") continue;
    // Trim again after the cut: a cut that ends in whitespace would otherwise change on a second pass, and the brief
    // would hash differently after a restart. Cleaning twice must give what cleaning once gave.
    const text = row.text.replace(/\0/g, "").replace(/\r\n/g, "\n").trim().slice(0, 8_000).trim();
    if (!text) continue;
    seen.add(path);
    out.push({ path, text });
    if (out.length === 8) break;
  }
  return out;
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\\/g, "/").trim();
  if (!text || text.length > 300 || /[\0\r\n]/.test(text)) return null;
  const parts = text.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

export function reviewerPrompt(input: { persona: Persona; plan: string; reading: readonly Reading[] }): string {
  const lines = [
    PERSONA_BRIEF[input.persona],
    "",
    "Reply with one or more findings. Each finding is two lines:",
    "FINDING: one sentence",
    "BREAK: what would go wrong",
    `If there is nothing to break, reply with exactly ${NO_CONCERNS} and nothing else. An empty reply is not an answer.`,
    "No other text.",
    "",
    "Plan:",
    input.plan,
  ];
  if (input.reading.length > 0) {
    lines.push("", "Reading list:");
    for (const item of input.reading) lines.push("", item.path, item.text);
  }
  return lines.join("\n");
}

/** The cheap model for a plan review. The work route's model is not used unless the person set one. */
export function reviewerChoice(
  route: { cli?: string | null; model?: string | null; effort?: string | null } | undefined,
  override: string | null,
): { model: string | null; effort: string | null } {
  if (override) return { model: override, effort: "low" };
  const base: Route = {
    cli: route?.cli || "claude",
    model: route?.model ?? null,
    effort: route?.effort ?? null,
    cliFrom: "default",
    modelFrom: "default",
    effortFrom: "default",
    ruleIndex: null,
    skipped: [],
    never: [],
    lock: false,
  };
  return roleModel("plan", base);
}

/** What a reviewer says when it finds nothing to break. Silence is not this. */
export const NO_CONCERNS = "NO CONCERNS";

/**
 * A reviewer's reply. Findings are findings. A reply with none is clean only when it is the explicit token (nothing else):
 * an empty, missing or unparseable reply is a reviewer that did not answer, never a pass, so a reviewer that died silently
 * or a brief written to keep reviewers quiet cannot approve itself.
 */
export function parseFindings(persona: Persona, text: string): { findings: Finding[]; readable: boolean } {
  const body = text.replace(/\r\n/g, "\n").trim();
  const findings: Finding[] = [];
  for (const block of body.split(/\n(?=FINDING:)/)) {
    const summary = /^FINDING:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    const broken = /^BREAK:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    if (!summary) continue;
    findings.push({ persona, summary: summary.slice(0, 400), break: broken.slice(0, 400) });
  }
  if (findings.length > 0) return { findings, readable: true };
  if (/^NO CONCERNS\.?$/i.test(body)) return { findings: [], readable: true };
  return { findings: [], readable: false };
}

/** Same summary twice is one finding. The first one is kept. */
export function mergeFindings(rows: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const row of rows) {
    const summary = row.summary.trim();
    if (!summary || out.some((have) => have.summary === summary)) continue;
    out.push({ persona: row.persona, summary, break: row.break.trim() });
  }
  return out;
}

export type ReviewRun = {
  status: "empty" | "pending" | "cleared" | "findings";
  findings: Finding[];
  failed: Persona[];
  retry: boolean;
  calls: ReviewerTurn[];
};

export async function runReview(input: {
  plan: string;
  reading: readonly Reading[];
  count: number;
  choice: { model: string | null; effort: string | null };
  port: ReviewerPort;
  folder?: string;
}): Promise<ReviewRun> {
  const plan = input.plan.replace(/\r\n/g, "\n").trim();
  if (!plan) return { status: "empty", findings: [], failed: [], retry: false, calls: [] };
  const calls: ReviewerTurn[] = [];
  const found: Finding[] = [];
  const failed: Persona[] = [];
  let retry = false;
  for (const persona of personasFor(input.count)) {
    const turn: ReviewerTurn = {
      persona,
      model: input.choice.model,
      effort: input.choice.effort,
      prompt: reviewerPrompt({ persona, plan, reading: input.reading }),
      history: [],
      ...(input.folder ? { folder: input.folder } : {}),
    };
    calls.push(turn);
    try {
      const text = await input.port.ask(turn);
      const parsed = parseFindings(persona, typeof text === "string" ? text : "");
      if (!parsed.readable) failed.push(persona);
      else found.push(...parsed.findings);
    } catch (error) {
      if (isNotFinal(error)) retry = true;
      else failed.push(persona);
    }
  }
  const findings = mergeFindings(found);
  if (retry) return { status: "pending", findings, failed, retry: true, calls };
  if (findings.length > 0) return { status: "findings", findings, failed, retry: false, calls };
  if (failed.length > 0) return { status: "pending", findings: [], failed, retry: false, calls };
  return { status: "cleared", findings: [], failed: [], retry: false, calls };
}
