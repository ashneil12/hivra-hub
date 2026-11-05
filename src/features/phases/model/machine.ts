// WP-84: the phase documents for one task. Every change checks the version it read.

import { choosePath, pathLabel, readSettings, type PathId, type PhaseSettings, type TaskHint } from "./settings";

export type PhaseId = "product" | "technical" | "research-questions" | "research" | "design" | "outline" | "build";

export const DECISIONS = ["Looks right", "Change this", "Skip to building"] as const;
export type Decision = (typeof DECISIONS)[number];

const REVIEW = new Set<PhaseId>(["product", "research", "design"]);

const SKILL: Record<PhaseId, string> = {
  product: "product-document",
  technical: "technical-document",
  "research-questions": "research-questions",
  research: "research",
  design: "design-discussion",
  outline: "implement-outline",
  build: "implement-outline",
};

const ITERATE: Record<PhaseId, string> = {
  product: "iterate-product",
  technical: "iterate-technical",
  "research-questions": "iterate-research-questions",
  research: "iterate-research",
  design: "iterate-design",
  outline: "iterate-outline",
  build: "iterate-outline",
};

export type Comment = { id: string; text: string; used: boolean };

export type Doc = {
  number: number;
  phase: PhaseId;
  title: string;
  fileName: string;
  body: string;
  comments: Comment[];
};

export type Run = {
  id: string;
  phase: PhaseId;
  skill: string;
  sessionId: string;
  modelRole: "search" | "judgment";
  model: string;
  steering: string[];
  /** Comment ids this run marked used. A retry gives them back. */
  steeringIds?: string[];
  status: "running" | "done" | "retry";
  iterate: boolean;
  docNumber?: number;
};

export type Waiting = { phase: PhaseId; docNumber: number; options: readonly string[] };

export type Work = {
  version: number;
  taskId: string;
  path: PathId;
  why: string;
  cursor: PhaseId | "done";
  docs: Doc[];
  runs: Run[];
  waiting: Waiting | null;
  building: boolean;
  removed: boolean;
  taskComments: Comment[];
  settings: PhaseSettings;
  /** Set on each saved write, so two windows can tell equal versions apart. */
  stamp?: string;
};

export type FinishResult = { body?: string; timedOut?: boolean; unreachable?: boolean };

export function phasesFor(path: PathId): PhaseId[] {
  if (path === "straight") return [];
  const core: PhaseId[] = ["research-questions", "research", "design", "outline", "build"];
  return path === "product-first" ? ["product", "technical", ...core] : core;
}

export function phaseTitle(phase: PhaseId): string {
  switch (phase) {
    case "product":
      return "Product";
    case "technical":
      return "Technical";
    case "research-questions":
      return "Research questions";
    case "research":
      return "Research";
    case "design":
      return "Design";
    case "outline":
      return "Structure outline";
    case "build":
      return "Build";
  }
}

export function counter(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function fileNameFor(number: number, phase: PhaseId): string {
  return `${String(number).padStart(2, "0")}-${phase}.md`;
}

function nextPhase(path: PathId, after: PhaseId): PhaseId | undefined {
  const phases = phasesFor(path);
  const index = phases.indexOf(after);
  if (index < 0 || index + 1 >= phases.length) return undefined;
  return phases[index + 1];
}

function clone(work: Work): Work {
  return {
    ...work,
    docs: work.docs.map((doc) => ({ ...doc, comments: doc.comments.map((comment) => ({ ...comment })) })),
    runs: work.runs.map((run) => ({ ...run, steering: [...run.steering] })),
    taskComments: work.taskComments.map((comment) => ({ ...comment })),
    waiting: work.waiting ? { ...work.waiting, options: [...work.waiting.options] } : null,
    settings: { ...work.settings, models: { ...work.settings.models } },
  };
}

function sameVersion(work: Work, expectedVersion: number): boolean {
  return Number.isInteger(expectedVersion) && work.version === expectedVersion;
}

/** Comments the next run has not seen yet. Marks them used on this copy only. */
function takeSteering(work: Work): { texts: string[]; ids: string[] } {
  const texts: string[] = [];
  const ids: string[] = [];
  const take = (comment: Comment) => {
    if (comment.used) return;
    comment.used = true;
    texts.push(comment.text);
    ids.push(comment.id);
  };
  for (const comment of work.taskComments) take(comment);
  for (const doc of work.docs) {
    if (!doc?.comments) continue;
    for (const comment of doc.comments) take(comment);
  }
  return { texts, ids };
}

/** A run that wrote nothing did not use these comments. */
function releaseSteering(work: Work, ids: readonly string[] | undefined): void {
  if (!ids?.length) return;
  const pending = new Set(ids);
  for (const comment of work.taskComments) if (pending.has(comment.id)) comment.used = false;
  for (const doc of work.docs) {
    if (!doc?.comments) continue;
    for (const comment of doc.comments) if (pending.has(comment.id)) comment.used = false;
  }
}

function startRun(work: Work, phase: PhaseId, iterate: boolean, docNumber: number | undefined, extra: string[], ids: () => string): Work {
  const role = phase === "research" ? "search" : "judgment";
  const steering = takeSteering(work);
  const run: Run = {
    id: ids(),
    phase,
    skill: iterate ? ITERATE[phase] : SKILL[phase],
    sessionId: ids(),
    modelRole: role,
    model: role === "search" ? work.settings.models.search : work.settings.models.judgment,
    steering: [...extra, ...steering.texts],
    steeringIds: steering.ids,
    status: "running",
    iterate,
    docNumber,
  };
  return { ...work, cursor: phase, runs: [...work.runs, run] };
}

function bump(work: Work, version: number): Work {
  return { ...work, version: version + 1 };
}

export function begin(taskId: string, task: TaskHint, settingsRaw: unknown, ids: () => string): Work {
  const settings = readSettings(settingsRaw);
  const choice = !taskId.trim() ? { path: "straight" as const, why: "This task has no id." } : choosePath(task, settings);
  const work: Work = {
    version: 1,
    taskId,
    path: choice.path,
    why: choice.why,
    cursor: "done",
    docs: [],
    runs: [],
    waiting: null,
    building: false,
    removed: false,
    taskComments: [],
    settings,
  };
  const first = phasesFor(choice.path)[0];
  if (!first) return work;
  return { ...startRun(work, first, false, undefined, [], ids), version: 1 };
}

export function finishRun(work: Work, expectedVersion: number, runId: string, result: FinishResult, ids: () => string): { stale: boolean; work: Work } {
  if (work.removed || !sameVersion(work, expectedVersion)) return { stale: true, work };
  const run = work.runs.find((item) => item.id === runId && item.status === "running");
  if (!run) return { stale: true, work };
  const next = clone(work);
  const index = next.runs.findIndex((item) => item.id === runId);
  if (result.timedOut || result.unreachable) {
    releaseSteering(next, next.runs[index].steeringIds);
    next.runs[index] = { ...next.runs[index], status: "retry" };
    return { stale: false, work: bump(next, work.version) };
  }
  const body = typeof result.body === "string" ? result.body.replace(/\r\n/g, "\n") : "";
  if (!body.trim() || next.path === "straight") {
    const wrote = Boolean(body.trim() && next.path === "straight");
    if (!wrote) releaseSteering(next, next.runs[index].steeringIds);
    next.runs[index] = { ...next.runs[index], status: wrote ? "done" : "retry" };
    return { stale: false, work: bump(next, work.version) };
  }
  if (run.iterate && run.docNumber != null) {
    next.docs = next.docs.map((doc) => (doc.number === run.docNumber ? { ...doc, body } : doc));
  } else {
    const number = next.docs.reduce((max, doc) => Math.max(max, doc.number), 0) + 1;
    next.docs = [...next.docs, { number, phase: run.phase, title: phaseTitle(run.phase), fileName: fileNameFor(number, run.phase), body, comments: [] }];
  }
  next.runs[index] = { ...next.runs[index], status: "done" };
  const review = REVIEW.has(run.phase) && !next.settings.continueWithoutWaiting;
  if (review) {
    const docNumber = run.iterate && run.docNumber != null ? run.docNumber : ([...next.docs].reverse().find((doc) => doc.phase === run.phase)?.number ?? 0);
    next.waiting = { phase: run.phase, docNumber, options: [...DECISIONS] };
    next.cursor = run.phase;
    return { stale: false, work: bump(next, work.version) };
  }
  if (run.phase === "build") {
    next.building = true;
    next.cursor = "done";
    next.waiting = null;
    return { stale: false, work: bump(next, work.version) };
  }
  const following = nextPhase(next.path, run.phase);
  next.waiting = null;
  if (!following) return { stale: false, work: bump({ ...next, cursor: "done" }, work.version) };
  return { stale: false, work: bump(startRun(next, following, false, undefined, [], ids), work.version) };
}

export function answer(work: Work, expectedVersion: number, choice: string, words: string, ids: () => string): { stale: boolean; refused?: boolean; work: Work } {
  if (work.removed || !sameVersion(work, expectedVersion) || !work.waiting) return { stale: true, work };
  if (choice === "Looks right") {
    const following = nextPhase(work.path, work.waiting.phase);
    const cleared = clone(work);
    cleared.waiting = null;
    if (!following) return { stale: false, work: bump({ ...cleared, cursor: "done" }, work.version) };
    return { stale: false, work: bump(startRun(cleared, following, false, undefined, [], ids), work.version) };
  }
  if (choice === "Change this") {
    const clean = words.replace(/\r\n/g, "\n").trim();
    if (!clean) return { stale: false, refused: true, work };
    const cleared = clone(work);
    cleared.waiting = null;
    return { stale: false, work: bump(startRun(cleared, work.waiting.phase, true, work.waiting.docNumber, [clean], ids), work.version) };
  }
  if (choice === "Skip to building") {
    const cleared = clone(work);
    cleared.waiting = null;
    return { stale: false, work: bump(startRun(cleared, "build", false, undefined, [], ids), work.version) };
  }
  return { stale: true, work };
}

export function addComment(
  work: Work,
  expectedVersion: number,
  target: { kind: "task" } | { kind: "doc"; docNumber: number },
  text: string,
  id: string,
): { stale: boolean; refused?: boolean; work: Work } {
  if (work.removed || !sameVersion(work, expectedVersion)) return { stale: true, work };
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean || !id.trim()) return { stale: false, refused: true, work };
  const known = work.taskComments.some((comment) => comment.id === id) || work.docs.some((doc) => doc.comments.some((comment) => comment.id === id));
  if (known) return { stale: false, work };
  const next = clone(work);
  if (target.kind === "task") {
    next.taskComments = [...next.taskComments, { id, text: clean, used: false }];
  } else {
    if (!next.docs.some((doc) => doc.number === target.docNumber)) return { stale: false, refused: true, work };
    next.docs = next.docs.map((doc) => (doc.number === target.docNumber ? { ...doc, comments: [...doc.comments, { id, text: clean, used: false }] } : doc));
  }
  return { stale: false, work: bump(next, work.version) };
}

export function setPath(work: Work, expectedVersion: number, path: string, ids: () => string): { stale: boolean; work: Work } {
  if (work.removed || !sameVersion(work, expectedVersion)) return { stale: true, work };
  if (path !== "straight" && path !== "research-plan-build" && path !== "product-first") return { stale: true, work };
  if (path === work.path) return { stale: false, work };
  const next = clone(work);
  next.path = path;
  next.why = "The person set this path.";
  next.waiting = null;
  next.runs = next.runs.map((run) => (run.status === "running" ? { ...run, status: "retry" } : run));
  if (path === "straight") return { stale: false, work: bump({ ...next, cursor: "done", building: false }, work.version) };
  const upcoming = phasesFor(path).find((phase) => !next.docs.some((doc) => doc.phase === phase));
  if (!upcoming) return { stale: false, work: bump({ ...next, cursor: "done" }, work.version) };
  return { stale: false, work: bump(startRun(next, upcoming, false, undefined, [], ids), work.version) };
}

export function removeTask(work: Work, expectedVersion: number): { stale: boolean; work: Work } {
  if (!sameVersion(work, expectedVersion)) return { stale: true, work };
  const next = clone(work);
  next.removed = true;
  next.waiting = null;
  return { stale: false, work: bump(next, work.version) };
}

/** The later document wins. For how the code behaves today, the code beats every document. */
export function currentFacts(docs: readonly { number: number; body: string }[], codeNow?: string): string {
  if (codeNow !== undefined) return codeNow;
  const ordered = [...docs].sort((a, b) => a.number - b.number);
  return ordered.length === 0 ? "" : ordered[ordered.length - 1].body;
}

/** For a phased task, these documents are the brief. A straight build keeps today's brief. */
export function phaseBrief(work: Work): string | undefined {
  if (work.path === "straight" || work.docs.length === 0) return undefined;
  return [...work.docs]
    .sort((a, b) => a.number - b.number)
    .map((doc) => `## ${doc.title}\n${doc.body}`)
    .join("\n\n");
}

export function phaseView(work: Work): {
  pathLabel: string;
  why: string;
  pathId: PathId;
  documents: { number: number; title: string; body: string }[];
  waiting: boolean;
} {
  return {
    pathLabel: pathLabel(work.path),
    why: work.why,
    pathId: work.path,
    documents: (Array.isArray(work.docs) ? work.docs : [])
      .filter((doc) => doc && Number.isInteger(doc.number))
      .sort((a, b) => a.number - b.number)
      .map((doc) => ({ number: doc.number, title: doc.title, body: doc.body })),
    waiting: work.waiting != null,
  };
}

export function running(work: Work): Run | undefined {
  return [...work.runs].reverse().find((run) => run.status === "running");
}

/** Starts the phase again after a timeout or a dead crew. A run that finished is left alone. */
export function rearm(work: Work, ids: () => string): Work {
  if (work.removed || work.waiting || running(work)) return work;
  const last = work.runs[work.runs.length - 1];
  if (!last || last.status !== "retry") return work;
  const extra = last.iterate ? last.steering.slice(0, 1) : [];
  return startRun(work, last.phase, last.iterate, last.docNumber, extra, ids);
}
