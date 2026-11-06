import { afterEach, expect, it } from "vitest";
import { begin, counter } from "./machine";
import {
  bindCrew,
  changePath,
  commentId,
  commitWork,
  holdForeignLock,
  noteTaskComment,
  phaseFor,
  plantPhaseRaw,
  setPhaseBuild,
  setPhaseCrew,
  setPhaseFiles,
  startPhaseWork,
  taskForCrew,
  workFor,
  writePhaseRaw,
} from "./store";

afterEach(() => {
  setPhaseCrew(undefined);
  setPhaseFiles(undefined);
  setPhaseBuild(undefined);
});

it("keeps the first write when a second window still has the old version", () => {
  const work = begin("task-cas", { weight: "small" }, {}, counter());
  const first = commitWork({ ...work, why: "first window" }, 0);
  expect(first.stale).toBe(false);
  const second = commitWork({ ...work, why: "second window" }, 0);
  expect(second.stale).toBe(true);
  expect(second.work.why).toBe("first window");
  expect(workFor("task-cas")?.why).toBe("first window");
});

it("reads garbage as no phase work", () => {
  writePhaseRaw("task-garbage", "{");
  expect(workFor("task-garbage")).toBeUndefined();
  writePhaseRaw("task-garbage", "{\"path\":\"sideways\"}");
  expect(workFor("task-garbage")).toBeUndefined();
});

it("does not open a task whose saved documents are broken", () => {
  writePhaseRaw("task-null", JSON.stringify({ taskId: "task-null", version: 1, path: "straight", why: "x", docs: [null], runs: [] }));
  expect(workFor("task-null")).toBeUndefined();
  expect(() => phaseFor("task-null")).not.toThrow();
  expect(phaseFor("task-null")).toBeUndefined();
});

it("takes the other window's write when the version matches but the stamp does not", () => {
  const work = begin("task-stamp", { weight: "small" }, {}, counter());
  const first = commitWork({ ...work, why: "kept" }, 0);
  expect(first.stale).toBe(false);
  plantPhaseRaw("task-stamp", JSON.stringify({ ...first.work, why: "from the other window", stamp: "other-window" }));
  expect(workFor("task-stamp")?.why).toBe("from the other window");
});

it("does not overwrite a record another window is writing", () => {
  const work = begin("task-lock", { weight: "small" }, {}, counter());
  const first = commitWork({ ...work, why: "kept" }, 0);
  expect(first.stale).toBe(false);
  holdForeignLock("task-lock");
  const second = commitWork({ ...first.work, version: first.work.version + 1, why: "lost" }, first.work.version);
  expect(second.stale).toBe(true);
  expect(workFor("task-lock")?.why).toBe("kept");
});

it("keeps two comments when each has its own id", () => {
  const work = begin("task-comments", { weight: "small" }, {}, counter());
  commitWork(work, 0);
  noteTaskComment("task-comments", "first", commentId());
  noteTaskComment("task-comments", "second", commentId());
  expect(workFor("task-comments")?.taskComments.map((comment) => comment.text)).toEqual(["first", "second"]);
  const ids = new Set(Array.from({ length: 20 }, () => commentId()));
  expect(ids.size).toBe(20);
  expect(ids.has("phase-1")).toBe(false);
});

it("writes research, then design, and waits, and saves each document", async () => {
  const written: string[] = [];
  setPhaseFiles({ root: "/tmp/hivra-tasks", write: (path) => written.push(path) });
  setPhaseCrew((run) => {
    if (run.phase === "research-questions") return { body: "Which line does the save drop?" };
    if (run.phase === "research") return { body: "The save drops the last line." };
    if (run.phase === "design") return { body: "Keep the last line." };
    return { body: "not yet" };
  });
  const work = await startPhaseWork("task-drive", { weight: "costly" }, {}, commentId);
  expect(work?.waiting?.phase).toBe("research");
  expect(work?.docs.map((doc) => doc.phase)).toEqual(["research-questions", "research"]);
  expect(written.some((path) => path.endsWith("01-research-questions.md"))).toBe(true);
  expect(written.some((path) => path.endsWith("02-research.md"))).toBe(true);
});

it("tries a timed-out phase again, then stops when the crew stays quiet", async () => {
  let calls = 0;
  setPhaseCrew(() => {
    calls += 1;
    return { timedOut: true };
  });
  const work = await startPhaseWork("task-quiet", { weight: "costly" }, {}, commentId);
  expect(work?.docs).toEqual([]);
  expect(work?.waiting).toBeNull();
  expect(work?.runs.at(-1)?.status).toBe("retry");
  expect(calls).toBeLessThanOrEqual(2);
  expect(calls).toBeGreaterThan(0);
});

it("finishes a run that a path change started", async () => {
  const work = begin("task-path", { weight: "small" }, {}, counter());
  commitWork(work, 0);
  setPhaseCrew((run) => (run.phase === "research-questions" ? { body: "Which line?" } : { body: "Later." }));
  await changePath("task-path", "research-plan-build", commentId);
  const saved = workFor("task-path");
  expect(saved?.docs.map((doc) => doc.phase)).toContain("research-questions");
  expect(saved?.runs.some((run) => run.status === "running")).toBe(false);
});

it("remembers which task a crew row moves", () => {
  bindCrew("crew-1", "task-crew");
  expect(taskForCrew("crew-1")).toBe("task-crew");
  expect(taskForCrew("crew-1", "named")).toBe("named");
  expect(taskForCrew("crew-1", "  ")).toBe("task-crew");
  expect(taskForCrew("missing")).toBe("");
});

it("records the build once the last phase is written", async () => {
  const built: string[] = [];
  setPhaseBuild((work) => built.push(work.taskId));
  setPhaseCrew(() => ({ body: "Ready." }));
  const work = await startPhaseWork("task-build", { weight: "costly" }, { continueWithoutWaiting: true }, commentId);
  expect(work?.building).toBe(true);
  expect(built).toEqual(["task-build"]);
});
