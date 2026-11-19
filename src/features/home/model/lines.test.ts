import { expect, it } from "vitest";
import {
  builderHoldLine,
  type HomeChat,
  type HomeDecision,
  type HomeDoc,
  type HomeProject,
  type HomeTask,
  hubProjectId,
  movingLines,
  namesFor,
  needsYouLines,
  type HomeLine,
  parseChat,
  parseDecision,
  parseDoc,
  parseTask,
  projectLines,
  recentLines,
  sanitizeProjects,
  taskReadKeys,
} from "./lines";

const crew: HomeProject = { id: "crew", name: "Crew", folder: "C:\\work\\crew" };
const notes: HomeProject = { id: "notes", name: "Notes", folder: null };
const name = namesFor([crew, notes]);

function task(over: Partial<HomeTask> = {}): HomeTask {
  return {
    id: "t1",
    projectId: "crew",
    title: "Write the notes",
    status: "In progress",
    source: "agent",
    assignee: "Ada",
    needsYou: false,
    trashedAt: null,
    createdAt: 10,
    ...over,
  };
}

function decision(over: Partial<HomeDecision> = {}): HomeDecision {
  return { project: "crew", decisionKey: "ship", question: "Should we ship?", state: "open", createdAt: 1, ...over };
}

it("needs you is open decisions, reviews and questions, oldest first, one line each", () => {
  const lines = needsYouLines(
    [
      decision({ createdAt: 30, decisionKey: "later", question: "Later?" }),
      decision({ createdAt: 5 }),
      decision({ state: "answered", decisionKey: "done", question: "Already answered?" }),
      decision({ decisionKey: "blank", question: "  \r\n  " }),
      decision(),
      decision({ project: "notes", decisionKey: "ship", question: "Same key, other project" }),
    ],
    [
      task({ id: "review", status: "In review", needsYou: true, title: "Read the spec", createdAt: 20 }),
      task({ id: "review", status: "In review", title: "A second copy", createdAt: 99 }),
      task({ id: "ask", needsYou: true, title: "Which font?", createdAt: 15, status: "In progress" }),
      task({ id: "gone", status: "In review", title: "Trashed", trashedAt: 1 }),
      task({ id: "empty", status: "In review", title: "" }),
      task({ id: "person", status: "Todo", needsYou: false, title: "Not waiting" }),
      task({ id: "flagged-string" as string, needsYou: false, title: "A string flag is not a question" }),
    ],
    name,
  );
  expect(lines.map((line) => line.text)).toEqual([
    "Notes · Same key, other project",
    "Crew · Should we ship?",
    "Crew · Which font?",
    "Crew · Read the spec",
    "Crew · Later?",
  ]);
  expect(lines.map((line) => line.kind)).toEqual(["decision", "decision", "question", "review", "decision"]);
  expect(lines.find((line) => line.kind === "review")?.target).toBe("review");
  expect(lines.filter((line) => line.target === "review")).toHaveLength(1);
});

it("a question in review is one review line and is not also moving", () => {
  const both = task({ status: "In review", needsYou: true, title: "Check this" });
  const needs = needsYouLines([], [both], name);
  expect(needs).toHaveLength(1);
  expect(needs[0].kind).toBe("review");
  expect(movingLines([both], name)).toEqual([]);
});

it("a line stays one line when the question has carriage returns", () => {
  const lines = needsYouLines([decision({ question: "First\r\nsecond\r third" })], [], name);
  expect(lines[0].text).toBe("Crew · First second third");
});

it("a missing project name falls back to the id, and a windows path is not rewritten", () => {
  const lines = needsYouLines([decision({ project: "C:\\work\\other", question: "Where?" })], [], namesFor([]));
  expect(lines[0].text).toBe("C:\\work\\other · Where?");
  expect(lines[0].projectId).toBe("C:\\work\\other");
});

it("moving now is an agent task in progress, with who is on it", () => {
  const lines = movingLines(
    [
      task({ createdAt: 2, assignee: "  " }),
      task({ id: "named", createdAt: 3, assignee: "Ada" }),
      task({ id: "named", title: "Duplicate" }),
      task({ id: "ask", needsYou: true, title: "A question" }),
      task({ id: "review", status: "In review", title: "In review" }),
      task({ id: "person", source: "person", title: "A person" }),
      task({ id: "gone", trashedAt: 4, title: "Trashed" }),
      task({ id: "blank", title: " \n " }),
      task({ id: "backlog", status: "Backlog", title: "Not started" }),
      task({ id: "folder", projectId: "C:\\work\\crew", title: "Filed under the folder" }),
    ],
    name,
  );
  expect(lines.map((line) => line.text)).toEqual([
    "Crew · Write the notes · No one yet",
    "Crew · Write the notes · Ada",
    "Crew · Filed under the folder · Ada",
  ]);
});

it("a task filed under the folder still names the project", () => {
  expect(hubProjectId("C:/work/crew", [crew])).toBe("crew");
  expect(hubProjectId("C:\\work\\crew", [crew])).toBe("crew");
  expect(hubProjectId("..\\outside", [crew])).toBe("..\\outside");
  expect(taskReadKeys([crew, notes, crew])).toEqual(["crew", "C:\\work\\crew", "notes"]);
});

it("recent is the last few opened docs and chats, newest first", () => {
  const docs: HomeDoc[] = [
    { id: "d1", title: "Plan", lastOpenedAt: 100, trashedAt: null },
    { id: "d1", title: "Copy", lastOpenedAt: 999, trashedAt: null },
    { id: "d2", title: "  ", lastOpenedAt: 80, trashedAt: null },
    { id: "gone", title: "Gone", lastOpenedAt: 200, trashedAt: 1 },
    { id: "never", title: "Never opened", lastOpenedAt: null, trashedAt: null },
  ];
  const chats: HomeChat[] = [
    { id: "c1", title: "Lead\r\nchat", projectId: "crew", openedAt: 90 },
    { id: "c1", title: "Older copy", projectId: "crew", openedAt: 1 },
  ];
  for (let i = 0; i < 6; i++) docs.push({ id: `extra-${i}`, title: `Extra ${i}`, lastOpenedAt: 70 - i, trashedAt: null });
  const lines = recentLines(docs, chats);
  expect(lines).toHaveLength(7);
  expect(lines.map((line) => line.text)).toEqual([
    "Plan",
    "Lead chat",
    "Untitled",
    "Extra 0",
    "Extra 1",
    "Extra 2",
    "Extra 3",
  ]);
  expect(lines[0].kind).toBe("doc");
  expect(lines[1].kind).toBe("chat");
});

it("empty, missing and untrusted rows are dropped", () => {
  expect(needsYouLines([], [], name)).toEqual([]);
  expect(movingLines([], name)).toEqual([]);
  expect(recentLines([], [])).toEqual([]);
  expect(parseTask(null)).toBeNull();
  expect(parseTask({ id: "  ", title: "No id" })).toBeNull();
  expect(parseTask({ id: "t", title: "Hi\r\nthere", needsYou: "true", trashedAt: "1", createdAt: "2" })).toMatchObject({
    title: "Hi there",
    needsYou: false,
    trashedAt: null,
    createdAt: 0,
  });
  expect(parseDecision({ question: "No key" })).toBeNull();
  expect(parseDecision({ decisionKey: "k", question: "Line\r\nbreak", state: "open" })?.question).toBe("Line break");
  expect(parseDoc({ title: "No id" })).toBeNull();
  expect(parseDoc({ id: "d", title: "Kept", lastOpenedAt: 3, trashedAt: null })?.title).toBe("Kept");
  expect(parseChat({ id: "../secret", openedAt: 1, title: "No" })).toBeNull();
  expect(parseChat({ id: "c", title: "Hi\r\nthere" })).toBeNull();
  expect(parseChat({ id: "c", title: "", openedAt: 4 })).toMatchObject({ title: "Untitled", openedAt: 4 });
  expect(sanitizeProjects([{ id: "a", name: "A\r\nB" }, { id: "a", name: "dup" }, { name: "no id" }, null, { id: "win", folder: "C:\\work\\hivra" }])).toEqual([
    { id: "a", name: "A B", folder: null },
    { id: "win", name: "win", folder: "C:\\work\\hivra" },
  ]);
  expect(sanitizeProjects("nope")).toEqual([]);
});

it("the held-builders line is about the machine: it names the free space and has no project in front", () => {
  const line = builderHoldLine({
    id: "builders-disk",
    text: "New builders are waiting:  24 GB free, under the 30 GB floor\n",
    action: "Free up space",
    freeGb: 24,
    floorGb: 30,
  });
  expect(line).toEqual({
    id: "builders:builders-disk",
    kind: "builders",
    text: "New builders are waiting: 24 GB free, under the 30 GB floor",
    projectId: "",
    target: "builders-disk",
    at: 0,
  });
  expect(line.text).not.toContain("·");
});

it("gives each project one line: needs you first, else its first moving task, else just its name", () => {
  const projects: HomeProject[] = [
    { id: "crew", name: "Crew", folder: null },
    { id: "site", name: "Site\nnew", folder: "/work/site" },
    { id: "notes", name: "Notes", folder: null },
    { id: "crew", name: "Crew again", folder: null },
  ];
  const name = namesFor(projects);
  const tasks: HomeTask[] = [
    { id: "q", projectId: "crew", title: "Which font?", status: "In progress", source: "person", assignee: null, needsYou: true, trashedAt: null, createdAt: 1 },
    { id: "w", projectId: "site", title: "Write the notes", status: "In progress", source: "agent", assignee: "Ada", needsYou: false, trashedAt: null, createdAt: 2 },
    { id: "c", projectId: "crew", title: "Crew task", status: "In progress", source: "agent", assignee: "Ada", needsYou: false, trashedAt: null, createdAt: 3 },
  ];
  const needs = needsYouLines([], tasks, name);
  const moving = movingLines(tasks, name);
  const lines = projectLines(projects, needs, moving, tasks);
  expect(lines.map((line) => line.text)).toEqual(["Crew · 1 needs you", "Site new · Write the notes", "Notes"]);
  expect(lines.map((line) => [line.kind, line.projectId, line.target])).toEqual([
    ["project", "crew", "crew"],
    ["project", "site", "site"],
    ["project", "notes", "notes"],
  ]);
  expect(lines[0]?.text).not.toContain("· needs you");
});

it("counts Needs you items on the project line, and a machine hold is not one of them", () => {
  const projects: HomeProject[] = [
    { id: "hivra", name: "Hivra", folder: null },
    { id: "vg-game", name: "EXO", folder: null },
    { id: "notes", name: "Notes", folder: null },
  ];
  const needs: HomeLine[] = [
    { id: "q1", kind: "decision", text: "Example: Ready to merge.", projectId: "hivra", target: "q1", at: 1 },
    { id: "q2", kind: "question", text: "Example: Which font?", projectId: "hivra", target: "q2", at: 2 },
    { id: "s1", kind: "stopped", text: "Example: Out of credits", projectId: "vg-game", target: "s1", at: 3 },
    { id: "hold", kind: "builders", text: "New builders are waiting", projectId: "", target: "builders-disk", at: 0 },
  ];
  expect(projectLines(projects, needs, [], []).map((line) => line.text)).toEqual([
    "Hivra · 2 need you",
    "EXO · 1 needs you",
    "Notes",
  ]);
});
