import { expect, it } from "vitest";
import { addComment, answer, begin, counter, currentFacts, finishRun, phaseBrief, removeTask, running, setPath } from "./machine";
import { choosePath, readSettings } from "./settings";

function costly() {
  const ids = counter();
  let work = begin("task-4", { weight: "costly" }, {}, ids);
  const questions = running(work);
  if (!questions) throw new Error("no questions run");
  work = finishRun(work, work.version, questions.id, { body: "Which line does the save drop?" }, ids).work;
  const research = running(work);
  if (!research) throw new Error("no research run");
  work = finishRun(work, work.version, research.id, { body: "The save drops the last line." }, ids).work;
  return { work, ids };
}

it("sends a small task straight through and writes no phase document", () => {
  const work = begin("task-1", { weight: "small" }, {}, counter());
  expect(work.path).toBe("straight");
  expect(work.docs).toEqual([]);
  expect(work.runs).toEqual([]);
  expect(work.why).toContain("small");
});

it("lets the person pick a phased path even for a small task", () => {
  const work = begin("task-1", { weight: "small", path: "research-plan-build" }, {}, counter());
  expect(work.path).toBe("research-plan-build");
  expect(work.runs[0]?.skill).toBe("research-questions");
  expect(work.why).toBe("The person set this path.");
});

it("ignores an unknown path and an unknown project default", () => {
  expect(choosePath({ path: "sideways", weight: "small" }, {}).path).toBe("straight");
  expect(choosePath({}, { defaultPath: "yolo" }).path).toBe("straight");
  expect(choosePath({}, { defaultPath: "product-first" }).path).toBe("product-first");
});

it("writes research, then design, and waits for the person after each", () => {
  const { work: researched, ids } = costly();
  expect(researched.waiting?.phase).toBe("research");
  expect(researched.waiting?.options).toEqual(["Looks right", "Change this", "Skip to building"]);
  expect(researched.docs.map((doc) => doc.phase)).toEqual(["research-questions", "research"]);
  const designed = answer(researched, researched.version, "Looks right", "", ids);
  const designRun = running(designed.work);
  expect(designRun?.skill).toBe("design-discussion");
  expect(designRun?.modelRole).toBe("judgment");
  const held = finishRun(designed.work, designed.work.version, designRun!.id, { body: "Keep the last line." }, ids).work;
  expect(held.waiting?.phase).toBe("design");
  expect(held.docs.map((doc) => doc.phase)).toEqual(["research-questions", "research", "design"]);
  expect(held.docs[1].number).toBeLessThan(held.docs[2].number);
  expect(new Set(held.runs.map((run) => run.sessionId)).size).toBe(held.runs.length);
  expect(phaseBrief(held)).toContain("## Research");
  expect(phaseBrief(begin("task-1", { weight: "small" }, {}, counter()))).toBeUndefined();
});

it("runs the iterate skill on the same document when the person says change this", () => {
  const { work: researched, ids } = costly();
  const agreed = answer(researched, researched.version, "Looks right", "", ids).work;
  const designRun = running(agreed)!;
  const held = finishRun(agreed, agreed.version, designRun.id, { body: "Keep the last line." }, ids).work;
  const before = held.docs.length;
  const number = held.waiting?.docNumber;
  const changed = answer(held, held.version, "Change this", "use the queue", ids).work;
  expect(changed.docs).toHaveLength(before);
  expect(running(changed)?.skill).toBe("iterate-design");
  expect(running(changed)?.docNumber).toBe(number);
  const again = finishRun(changed, changed.version, running(changed)!.id, { body: "Keep the last line, through the queue." }, ids).work;
  expect(again.docs).toHaveLength(before);
  expect(again.docs.find((doc) => doc.number === number)?.body).toContain("use the queue");
  expect(again.waiting?.phase).toBe("design");
});

it("refuses an empty change and keeps the same version", () => {
  const { work, ids } = costly();
  const result = answer(work, work.version, "Change this", "  ", ids);
  expect(result.refused).toBe(true);
  expect(result.work.version).toBe(work.version);
  expect(result.work.docs).toHaveLength(work.docs.length);
});

it("carries a comment on the design document into the next run", () => {
  const { work: researched, ids } = costly();
  const agreed = answer(researched, researched.version, "Looks right", "", ids).work;
  const held = finishRun(agreed, agreed.version, running(agreed)!.id, { body: "Keep the last line." }, ids).work;
  const noted = addComment(held, held.version, { kind: "doc", docNumber: held.waiting!.docNumber }, "check the lock", "c1").work;
  const next = answer(noted, noted.version, "Looks right", "", ids).work;
  expect(running(next)?.steering.join("\n")).toContain("check the lock");
  const onTask = addComment(next, next.version, { kind: "task" }, "and the blank line", "c2").work;
  const built = finishRun(onTask, onTask.version, running(onTask)!.id, { body: "Outline." }, ids).work;
  expect(running(built)?.steering.join("\n")).toContain("and the blank line");
});

it("ignores an empty comment and a duplicate id", () => {
  const { work } = costly();
  const empty = addComment(work, work.version, { kind: "task" }, " \r\n ", "c1");
  expect(empty.refused).toBe(true);
  expect(empty.work.version).toBe(work.version);
  const once = addComment(work, work.version, { kind: "task" }, "hello\r\nthere", "c1").work;
  expect(once.taskComments[0].text).toBe("hello\nthere");
  const twice = addComment(once, once.version, { kind: "task" }, "again", "c1");
  expect(twice.work.version).toBe(once.version);
  expect(twice.work.taskComments).toHaveLength(1);
});

it("drops a late result, and a timeout does not move the phase on", () => {
  const ids = counter();
  const work = begin("task-4", { weight: "costly" }, {}, ids);
  const run = running(work)!;
  const late = finishRun(work, work.version - 1, run.id, { body: "too late" }, ids);
  expect(late.stale).toBe(true);
  expect(late.work.docs).toEqual([]);
  const unknown = finishRun(work, work.version, "other", { body: "no" }, ids);
  expect(unknown.stale).toBe(true);
  const timed = finishRun(work, work.version, run.id, { timedOut: true }, ids).work;
  expect(timed.docs).toEqual([]);
  expect(timed.runs.find((item) => item.id === run.id)?.status).toBe("retry");
  expect(timed.cursor).toBe(work.cursor);
  const gone = removeTask(timed, timed.version).work;
  const after = finishRun(gone, gone.version, run.id, { body: "back" }, ids);
  expect(after.stale).toBe(true);
  expect(after.work.docs).toEqual([]);
});

it("keeps the first of two writes and lets the later document lose to the code", () => {
  const { work, ids } = costly();
  const first = answer(work, work.version, "Looks right", "", ids).work;
  const second = answer(work, work.version, "Skip to building", "", ids);
  expect(first.version).toBe(work.version + 1);
  expect(second.work.version).toBe(work.version + 1);
  expect(second.work.runs.at(-1)?.skill).toBe("implement-outline");
  const facts = currentFacts(
    [
      { number: 1, body: "old" },
      { number: 3, body: "newer" },
      { number: 2, body: "middle" },
    ],
    "the code keeps the last line",
  );
  expect(facts).toBe("the code keeps the last line");
  expect(currentFacts([{ number: 1, body: "old" }, { number: 2, body: "newer" }])).toBe("newer");
  expect(currentFacts([])).toBe("");
});

it("stops writing documents when the person switches to a straight build", () => {
  const ids = counter();
  const work = begin("task-4", { weight: "costly" }, {}, ids);
  const run = running(work)!;
  const straight = setPath(work, work.version, "straight", ids).work;
  expect(straight.waiting).toBeNull();
  const late = finishRun(straight, straight.version, run.id, { body: "should not land" }, ids);
  expect(late.stale).toBe(true);
  expect(late.work.docs).toEqual([]);
});

it("waits on a product document, and can continue when the project says so", () => {
  const ids = counter();
  const work = begin("task-9", { weight: "product" }, {}, ids);
  expect(running(work)?.skill).toBe("product-document");
  const held = finishRun(work, work.version, running(work)!.id, { body: "A person can read this." }, ids).work;
  expect(held.waiting?.phase).toBe("product");
  const moving = begin("task-8", { weight: "costly" }, { continueWithoutWaiting: true }, ids);
  const questions = finishRun(moving, moving.version, running(moving)!.id, { body: "Questions." }, ids).work;
  const researched = finishRun(questions, questions.version, running(questions)!.id, { body: "Facts." }, ids).work;
  expect(researched.waiting).toBeNull();
  expect(running(researched)?.skill).toBe("design-discussion");
});

it("falls back when settings are garbage, and uses the cheap model only for research", () => {
  const settings = readSettings({ defaultPath: 4, continueWithoutWaiting: "yes", models: { search: "claude:made-up", judgment: "" } });
  expect(settings.defaultPath).toBe("straight");
  expect(settings.continueWithoutWaiting).toBe(false);
  expect(settings.models.search).toBe("claude:haiku-4.5");
  expect(settings.models.judgment).toBe("claude:opus-5-5");
  const ids = counter();
  const work = begin("task-4", { weight: "costly" }, { models: { search: "claude:sonnet-5", judgment: "claude:opus-5-5" } }, ids);
  expect(running(work)?.modelRole).toBe("judgment");
  const next = finishRun(work, work.version, running(work)!.id, { body: "Questions." }, ids).work;
  expect(running(next)?.model).toBe("claude:sonnet-5");
  expect(running(next)?.modelRole).toBe("search");
});

it("treats an unreachable crew as something to retry", () => {
  const ids = counter();
  const work = begin("task-4", { weight: "costly" }, {}, ids);
  const retried = finishRun(work, work.version, running(work)!.id, { unreachable: true }, ids).work;
  expect(retried.docs).toEqual([]);
  expect(retried.runs[0].status).toBe("retry");
});
