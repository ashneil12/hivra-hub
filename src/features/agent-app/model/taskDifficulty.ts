// E7 (the audit scorecard, 22 Oct): the right model for the job. A worker is judged from the job itself — how long the
// brief is, whether it lists steps, how many files it names, and whether it touches anything that goes wrong loudly (a
// migration, auth, payments, a deploy) — and runs on Sonnet unless that says hard. A hard job gets the strongest model
// the engine lists and high effort when that model offers it. No model call: the same brief always gets the same call.
//
// Only a Claude chat is routed. Another engine's ladder is its own, and one of Ash's own models (custom:) stays his.
// Every existing default holds when the job is not routed: an explicit model or effort from the caller always wins, and
// a route that changes nothing returns undefined.
import type { AgentModel } from "../../sessions/model/models";
import {
  modelEffortSetting,
  modelsFor,
  resolveModel,
} from "../../sessions/model/models";
import { isCustomModelId } from "../../sessions/model/customModels";
import type { HarnessId, Session } from "../../sessions/model/session";

export type JobDifficulty = {
  level: "usual" | "hard";
  /** 3 or more makes a job hard. */
  score: number;
  /** Plain-words reasons, in the order they counted. */
  reasons: string[];
};

export type WorkerRoute = {
  harness: HarnessId;
  model: string;
  /** "high", only when the chosen model offers it. */
  effort?: string;
  /** One plain sentence, for the delegate result and the log. */
  why: string;
};

/** Things that go wrong loudly when a small model gets them wrong: any one alone makes a job hard. */
const RISKS: ReadonlyArray<{ why: string; re: RegExp }> = [
  { why: "a migration or schema change", re: /\bmigrat(?:e|es|ed|ing|ion|ions)\b|\bschemas?\b/i },
  { why: "sign-in or permissions", re: /\bauth(?:entication|orization|enticate)?\b|\bpermissions?\b|\bRLS\b/i },
  { why: "security or secrets", re: /\bsecur(?:e|es|ed|ity)\b|\bsecrets?\b|\bprivate key|\bcredentials?\b|\bapi keys?\b/i },
  { why: "payments or billing", re: /\bpayments?\b|\bbilling\b|\brefunds?\b/i },
  { why: "a production deploy", re: /\bproduction\b|\bdeploy(?:s|ed|ing|ment)?\b/i },
  { why: "the risk of data loss", re: /\bdata loss\b|\bcorrupt(?:s|ed|ion)?\b|\birreversible\b|\bunrecoverable\b/i },
  { why: "concurrency", re: /\brac(?:e|es|ing)\b|\bconcurren(?:t|cy)\b|\bdeadlocks?\b/i },
];

/** Broad changes: two of these, or one plus length or steps, make a job hard. */
const SCOPE: ReadonlyArray<{ why: string; re: RegExp }> = [
  { why: "a rewrite or refactor", re: /\brewrite\w*\b|\brefactor\w*\b|\brebuild\w*\b|\bre-?design\w*\b/i },
  { why: "work across the whole app", re: /\bwhole codebase\b|\bacross (?:the )?codebase\b|\bentire codebase\b|\bthroughout\b|\bevery (?:module|page|screen|file)\b/i },
];

const PATH = /(?:^|[\s("'`])((?:\/)?(?:[\w.@-]+\/)+[\w.@-]+|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|rs|py|go|sql|json|md|css))(?=$|[\s)"'`,.:;])/g;
const SEQUENCE = /\b(first|next|then|after that|finally|lastly)\b/gi;

/** Distinct files and paths a brief names ("/api/v1/users." at the end of a sentence is the path, not a dot). */
export function namedFiles(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH)) found.add(match[1].replace(/[.:;,]+$/, ""));
  return [...found];
}

/** A brief that lays its work out in order: a list of three or more, or three different step words. */
function listsSteps(text: string): boolean {
  const items = text.split("\n").filter((line) => /^\s*(?:\d+[.)]|[-*])\s+\S/.test(line)).length;
  if (items >= 3) return true;
  return new Set((text.match(SEQUENCE) ?? []).map((word) => word.toLowerCase())).size >= 3;
}

/** The brief says how its own result is checked, which makes a job safer to hand to the usual worker. */
function namesProof(text: string): boolean {
  return /\btests?\b|\bspecs?\b|\.test\.|\bvitest\b|\bcargo test\b|\bprove it\b/i.test(text);
}

/**
 * How hard is this job? Deterministic and small: the brief (and its finish line) is all it reads.
 * Risk alone (3) is hard; scope (2 each), a long brief, several steps and many named files add up to it.
 */
export function judgeBrief(brief: string, goal?: string): JobDifficulty {
  const job = goal ? `${brief}\n${goal}` : brief;
  const reasons: string[] = [];
  let score = 0;
  for (const risk of RISKS)
    if (risk.re.test(job)) {
      score += 3;
      reasons.push(risk.why);
    }
  for (const scope of SCOPE)
    if (scope.re.test(job)) {
      score += 2;
      reasons.push(scope.why);
    }
  if (brief.trim().split(/\s+/).filter(Boolean).length >= 140) {
    score += 1;
    reasons.push("a long brief");
  }
  if (listsSteps(brief)) {
    score += 1;
    reasons.push("several steps in order");
  }
  if (namedFiles(job).length >= 4) {
    score += 1;
    reasons.push("many files named");
  }
  if (!reasons.length) reasons.push(namesProof(job) ? "a short brief that says how to check it" : "a short brief");
  return { level: score >= 3 ? "hard" : "usual", score, reasons };
}

/** A usual job: Sonnet handles these well. In the catalog's own order. */
const USUAL_MODEL_IDS = ["claude:sonnet-5", "claude:sonnet-4.6"];
/** A hard job: the strongest Claude models, the way the catalog ranks them. */
const HARD_MODEL_IDS = ["claude:opus-5-5", "claude:opus-5", "claude:fable-5", "claude:opus-4.6", "claude:opus-4.5"];

function pickModel(available: readonly AgentModel[], preferred: readonly string[], family: RegExp): AgentModel | undefined {
  for (const id of preferred) {
    const found = available.find((model) => model.id === id);
    if (found) return found;
  }
  return available.find((model) => family.test(model.id.slice(model.id.indexOf(":") + 1)));
}

function highEffort(model: AgentModel): string | undefined {
  const setting = modelEffortSetting(model);
  const offered = setting?.options.some((option) => option.value === "high" && !option.unsupported);
  return offered ? "high" : undefined;
}

/**
 * The model a worker should run on, or undefined when nothing should change: another engine, one of Ash's own models,
 * no Sonnet-class model in the catalog, or a route that lands on what would run anyway.
 */
export function routeWorker(source: Session, difficulty: JobDifficulty): WorkerRoute | undefined {
  if (source.harness !== "claude") return undefined;
  if (isCustomModelId(source.model)) return undefined;
  const available = modelsFor("claude");
  const usual = pickModel(available, USUAL_MODEL_IDS, /^sonnet/i);
  if (!usual) return undefined;
  const chosen =
    difficulty.level === "hard" ? (pickModel(available, HARD_MODEL_IDS, /^(?:opus|fable)/i) ?? usual) : usual;
  const effort = difficulty.level === "hard" ? highEffort(chosen) : undefined;
  if (resolveModel("claude", source.model).id === chosen.id && !effort) return undefined;
  const name = chosen.name.replace(/^Claude /, "");
  const why =
    difficulty.level === "hard"
      ? `A hard job (${difficulty.reasons.join("; ")}), so ${name}${effort ? " at high effort" : ""}.`
      : `A usual job (${difficulty.reasons.join("; ")}), so ${name}.`;
  return { harness: "claude", model: chosen.id, ...(effort ? { effort } : {}), why };
}
