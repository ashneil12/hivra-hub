// E7 (the audit scorecard, 22 Oct): the right model for the job. A worker is chosen from signals the app can see, never
// from reading the brief: the Lead's own `hard` and `heavy` marks, `redoes` (a second go at a task that failed or
// stopped), and the size of the scope it declares. A usual job runs on Sonnet; one of those signals makes it hard, which
// gets the strongest model the catalog lists and high effort when that model offers it.
//
// A project's own worker model (Ash's choice, saved in the Workers dialog) applies to every job, and an explicit
// per-task model or effort wins over every rule here. Deterministic: the same signals always get the same route, and no
// model call is made.
//
// Every existing default holds when the job is not routed: a route that changes nothing returns undefined.
import type { AgentModel } from "../../sessions/model/models";
import {
  modelEffortSetting,
  modelsFor,
  resolveModel,
} from "../../sessions/model/models";
import { isCustomModelId } from "../../sessions/model/customModels";
import type { HarnessId, Session } from "../../sessions/model/session";

/** What the app can see about a job, all of it declared on delegate_task. */
export type TaskSignals = {
  /** delegate_task `heavy`: the job runs heavy tests (full suites, e2e, builds). */
  heavy?: boolean;
  /** delegate_task `redoes`: a second go at a task that failed or stopped moving. */
  retry?: boolean;
  /** How many files or areas delegate_task `scope` declares. */
  scope?: number;
  /** delegate_task `hard`: the Lead says this job is hard (subtle, high-risk or wide). */
  hard?: boolean;
};

export type JobDifficulty = {
  level: "usual" | "hard";
  /** Plain-words reasons, in the order they counted ("a usual job" when none did). */
  reasons: string[];
};

export type WorkerRoute = {
  harness: HarnessId;
  model: string;
  /** The model's own effort setting, when the route names one. */
  effort?: string;
  /** One plain sentence, for the delegate result and the log. */
  why: string;
};

/** A project's own worker model (Ash's Settings choice): used for every worker the signals do not override. */
export type WorkerModel = { model: string; effort?: string };

/** A scope this large is a hard job: the worker has a lot to hold at once. */
export const LARGE_SCOPE = 8;

/**
 * How hard is this job? Deterministic and small: only the declared signals count (`hard`, `heavy`, `retry`, `scope`).
 * Any one of them makes it hard; none is a usual job for Sonnet.
 */
export function judgeTask(signals: TaskSignals): JobDifficulty {
  const reasons: string[] = [];
  if (signals.hard) reasons.push("marked hard");
  if (signals.heavy) reasons.push("a heavy job");
  if (signals.retry) reasons.push("a retry of a task that failed");
  const scope = signals.scope ?? 0;
  if (scope >= LARGE_SCOPE)
    reasons.push(`a declared scope of ${scope} files or areas`);
  return reasons.length
    ? { level: "hard", reasons }
    : { level: "usual", reasons: ["a usual job"] };
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

/** The model a project's workers run on: its saved choice, or the usual Sonnet. */
function projectModel(choice: WorkerModel): { harness: HarnessId; id: string; name: string; effort?: string } | undefined {
  if (isCustomModelId(choice.model))
    return {
      harness: "claude",
      id: choice.model,
      name: resolveModel("claude", choice.model).name,
      ...(choice.effort ? { effort: choice.effort } : {}),
    };
  const found = modelsFor("claude").find((model) => model.id === choice.model) ?? resolveModel("claude", choice.model);
  if (!found || found.harness !== "claude") return undefined;
  return { harness: "claude", id: found.id, name: found.name, ...(choice.effort ? { effort: choice.effort } : {}) };
}

function sameAsSource(source: Session, route: { harness: HarnessId; id: string }): boolean {
  return source.harness === route.harness && resolveModel(source.harness, source.model).id === route.id;
}

/**
 * The model a worker should run on, or undefined when nothing should change: no Sonnet-class model in the catalog, or a
 * route that lands on what would run anyway. A project's own model (`projectModel`) is used for any job; otherwise the
 * signals decide (judgeTask). The caller's own model or effort is applied before this and always wins.
 */
export function routeWorker(
  source: Session,
  difficulty: JobDifficulty,
  projectChoice?: WorkerModel,
): WorkerRoute | undefined {
  // The catalog's ladder is Claude's: another engine starts its workers its own way.
  if (source.harness !== "claude") return undefined;
  if (projectChoice) {
    const chosen = projectModelRoute(projectChoice);
    if (!chosen) return undefined;
    if (sameAsSource(source, chosen) && !chosen.effort) return undefined;
    const name = chosen.name.replace(/^Claude /, "");
    return {
      harness: chosen.harness,
      model: chosen.id,
      ...(chosen.effort ? { effort: chosen.effort } : {}),
      why: `This project's workers run on ${name}${chosen.effort ? ` at ${chosen.effort} effort` : ""}.`,
    };
  }
  // One of Ash's own models ("Other models") is his choice of route, not a rung on the ladder.
  if (isCustomModelId(source.model)) return undefined;
  const available = modelsFor("claude");
  const usual = pickModel(available, USUAL_MODEL_IDS, /^sonnet/i);
  if (!usual) return undefined;
  const chosen =
    difficulty.level === "hard" ? (pickModel(available, HARD_MODEL_IDS, /^(?:opus|fable)/i) ?? usual) : usual;
  const effort = difficulty.level === "hard" ? highEffort(chosen) : undefined;
  if (sameAsSource(source, { harness: "claude", id: chosen.id }) && !effort) return undefined;
  const name = chosen.name.replace(/^Claude /, "");
  const why =
    difficulty.level === "hard"
      ? `A hard job (${difficulty.reasons.join("; ")}), so ${name}${effort ? " at high effort" : ""}.`
      : `A usual job (${difficulty.reasons.join("; ")}), so ${name}.`;
  return { harness: "claude", model: chosen.id, ...(effort ? { effort } : {}), why };
}

/** A saved project model as a route, without the usual/hard rule (used for both). */
export function projectModelRoute(choice: WorkerModel): { harness: HarnessId; id: string; name: string; effort?: string } | undefined {
  return projectModel(choice);
}
