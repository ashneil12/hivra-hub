import { expect, it } from "vitest";
import {
  needsCount,
  needsListPublished,
  needsYou,
  needsYouQuiet,
  takeLatest,
  workingCount,
  type NeedsItem,
  type NeedsSources,
} from "./needsYou";

const NOW = 1_700_000_000_000;

function sources(over: NeedsSources = {}): NeedsSources {
  return {
    ownRepos: new Set(["ash/hivra", "ash/exo", "ash/nibbii"]),
    knownProjects: new Set(["hivra", "exo", "nibbii"]),
    ...over,
  };
}

function kinds(items: readonly NeedsItem[]): string[] {
  return items.map((item) => `${item.kind}:${item.projectId ?? "-"}`);
}

it("lists one item of every kind across three projects, and both counts agree", () => {
  const answered: string[] = [];
  const items = needsYou(sources({
    stopped: [{
      id: "win",
      projectId: "hivra",
      monoId: "hivra-lead",
      who: "Hivra lead",
      at: NOW - 50,
      sentence: "The Windows build stopped after 3 tries.",
      onOpen: () => answered.push("stopped"),
    }],
    questions: [{
      id: "flash",
      projectId: "exo",
      who: "EXO lead",
      at: NOW - 40,
      sentence: "Ship the hit flash?",
      fromDecision: true,
      onAnswer: () => answered.push("question"),
    }],
    approvals: [{
      id: "publish",
      projectId: "nibbii",
      who: "frank",
      at: NOW - 30,
      sentence: "frank wants to run npm publish in nibbii-web.",
      onAllow: () => answered.push("allow"),
      onDeny: () => answered.push("deny"),
    }],
    merges: [{
      id: "217",
      projectId: "hivra",
      who: "Coding team",
      at: NOW - 20,
      sentence: "Ready to merge #217.",
      onAnswer: () => answered.push("merge"),
    }],
    reviews: [{
      id: "pr-9",
      projectId: "exo",
      repo: "ash/exo",
      who: "EXO lead",
      at: NOW - 10,
      sentence: "Review the pull request in EXO.",
      onOpen: () => answered.push("review"),
    }],
    checks: [{
      id: "gate-1",
      gateKey: "weekly",
      projectId: "nibbii",
      who: "Coding team",
      at: NOW,
      sentence: "The delivery check needs a yes.",
      onApprove: () => answered.push("approve"),
      onFix: () => answered.push("fix"),
    }],
    running: [
      { id: "run-h", projectId: "hivra" },
      { id: "run-e", projectId: "exo" },
      { id: "run-e2", projectId: "exo" },
    ],
  }), NOW);

  expect(kinds(items)).toEqual([
    "check:nibbii",
    "question:exo",
    "approval:nibbii",
    "merge:hivra",
    "review:exo",
    "stopped:hivra",
  ]);
  expect(needsCount()).toBe(items.length);
  expect(needsCount("hivra")).toBe(2);
  expect(needsCount("exo")).toBe(2);
  expect(needsCount("nibbii")).toBe(2);
  expect(needsCount("missing")).toBe(0);
  expect(workingCount()).toBe(3);
  expect(workingCount("exo")).toBe(2);
  expect(workingCount("nibbii")).toBe(0);
  expect(items.every((item) => item.sentence.length <= 140)).toBe(true);
  expect(items.every((item) => item.actions.length <= 2)).toBe(true);
  expect(items.find((item) => item.kind === "merge")?.actions[0]?.label).toBe("Yes");
  expect(items.find((item) => item.kind === "stopped")?.actions[0]?.label).toBe("Open Hivra lead's chat");

  for (const item of items) item.actions[0]?.run();
  expect(answered).toEqual(["approve", "question", "allow", "merge", "review", "stopped"]);
});

it("keeps an item with no project in the total only", () => {
  const items = needsYou(sources({
    questions: [{ id: "app", who: "Hivra lead", at: NOW, sentence: "Which account?", fromDecision: true }],
    stopped: [{ id: "local", projectId: "hivra", who: "Hivra lead", at: NOW, sentence: "The build stopped." }],
  }), NOW);
  expect(items).toHaveLength(2);
  expect(needsCount()).toBe(2);
  expect(needsCount("hivra")).toBe(1);
});

it("collapses a worker question and that worker's stopped row into the question", () => {
  const items = needsYou(sources({
    stopped: [{ id: "job-1", about: "worker-7", projectId: "hivra", who: "frank", at: NOW, sentence: "frank stopped." }],
    questions: [{
      id: "ask-7",
      about: "worker-7",
      projectId: "hivra",
      who: "Hivra lead",
      at: NOW,
      sentence: "frank asked which font, and the Lead passed it on.",
    }],
  }), NOW);
  expect(items).toHaveLength(1);
  expect(items[0]?.kind).toBe("question");
  expect(items[0]?.key).toBe("question:ask-7");
  expect(needsCount("hivra")).toBe(1);
});

it("collapses a gate key in the decision store and the gate log into one check", () => {
  const items = needsYou(sources({
    questions: [{
      id: "chat-gate",
      gateKey: "ship-check",
      projectId: "exo",
      who: "EXO lead",
      at: NOW - 5,
      sentence: "Approve the delivery check?",
      onAnswer: () => undefined,
    }],
    checks: [{
      id: "card-1",
      gateKey: "ship-check",
      projectId: "exo",
      who: "Coding team",
      at: NOW,
      sentence: "The delivery check needs a yes.",
      onApprove: () => undefined,
      onFix: () => undefined,
    }],
  }), NOW);
  expect(items).toHaveLength(1);
  expect(items[0]?.kind).toBe("check");
  expect(items[0]?.key).toBe("check:ship-check");
  expect(items[0]?.actions.map((action) => action.label)).toEqual(["Approve", "Fix"]);
});

it("keeps the decision when a chat asks the same question in the same project", () => {
  const items = needsYou(sources({
    questions: [
      { id: "chat-1", projectId: "exo", who: "EXO lead", at: NOW, sentence: "Ship the hit flash?" },
      { id: "dec-1", projectId: "exo", who: "EXO lead", at: NOW - 1, sentence: "Ship the hit flash?", fromDecision: true },
    ],
  }), NOW);
  expect(items).toHaveLength(1);
  expect(items[0]?.key).toBe("question:dec-1");
});

it("drops a chat routed to its Lead and a grey waiting worker", () => {
  const items = needsYou(sources({
    questions: [{ id: "routed", projectId: "hivra", who: "frank", at: NOW, sentence: "Which font?", routedToLead: true }],
    stopped: [{ id: "grey", projectId: "hivra", who: "frank", at: NOW, sentence: "Retrying the build.", forAsh: false }],
  }), NOW);
  expect(items).toEqual([]);
  expect(needsCount()).toBe(0);
});

it("leaves out a review on a repo that is not one of the projects' repos", () => {
  const items = needsYou(sources({
    reviews: [
      { id: "ours", repo: "ash/hivra", projectId: "hivra", who: "Hivra lead", at: NOW, sentence: "Review the Hivra pull request." },
      { id: "theirs", repo: "upstream/monocode", who: "someone", at: NOW, sentence: "Review someone else's pull request." },
    ],
  }), NOW);
  expect(items.map((item) => item.key)).toEqual(["review:ours"]);
});

it("takes nothing from the mock stores", () => {
  const items = needsYou(sources({
    hubWork: [{ id: "w1", stuck: "stuck" }],
    hubBuilds: [{ id: "b1", status: "failed" }],
    proposals: [{ id: "p1", title: "Add a Mono" }],
  }), NOW);
  expect(items).toEqual([]);
  expect(needsCount()).toBe(0);
  expect(workingCount()).toBe(0);
});

it("answering through each kind's own handler removes that item on the next read", () => {
  const state = {
    stopped: true,
    question: true,
    approval: true,
    merge: true,
    review: true,
    check: true,
  };
  const read = () => needsYou(sources({
    stopped: state.stopped ? [{ id: "s", projectId: "hivra", who: "Hivra lead", at: NOW, sentence: "Stopped.", onOpen: () => { state.stopped = false; } }] : [],
    questions: state.question ? [{ id: "q", projectId: "exo", who: "EXO lead", at: NOW, sentence: "Which one?", onAnswer: () => { state.question = false; } }] : [],
    approvals: state.approval ? [{ id: "a", projectId: "nibbii", who: "frank", at: NOW, sentence: "Allow the publish?", onAllow: () => { state.approval = false; } }] : [],
    merges: state.merge ? [{ id: "m", projectId: "hivra", who: "Coding team", at: NOW, sentence: "Ready to merge.", onAnswer: () => { state.merge = false; } }] : [],
    reviews: state.review ? [{ id: "r", repo: "ash/exo", projectId: "exo", who: "EXO lead", at: NOW, sentence: "Review it.", onOpen: () => { state.review = false; } }] : [],
    checks: state.check ? [{ id: "c", projectId: "nibbii", who: "Coding team", at: NOW, sentence: "Check the gate.", onApprove: () => { state.check = false; } }] : [],
  }), NOW);

  expect(read()).toHaveLength(6);
  for (const key of ["stopped", "question", "approval", "merge", "review", "check"] as const) {
    const before = needsCount();
    const item = read().find((row) => row.kind === key);
    item?.actions[0]?.run();
    const after = read();
    expect(after.find((row) => row.kind === key)).toBeUndefined();
    expect(needsCount()).toBe(before - 1);
    expect(needsCount()).toBe(after.length);
  }
  expect(needsCount()).toBe(0);
});

it("uses a name, never a raw id, and never an em dash or the word Stuck", () => {
  const items = needsYou({
    stopped: [{
      id: "s",
      who: "worker-9f3a",
      at: NOW,
      sentence: "Stuck — the Windows build stopped.",
    }],
    questions: [{ id: "q", who: "", at: NOW, sentence: "  Which   font?  " }],
  }, NOW);
  expect(items.map((item) => item.who)).toEqual(["Coding team", "Coding team"]);
  expect(items.map((item) => item.sentence).join(" ")).not.toMatch(/Stuck|[—–]/);
  expect(items.map((item) => item.sentence)).toContain("Which font?");
  expect(items.map((item) => item.sentence)).toContain("stopped, the Windows build stopped.");
});

it("drops an empty id, a blank sentence, and a duplicate key", () => {
  const items = needsYou({
    questions: [
      { id: " ", who: "Ada", at: NOW, sentence: "Which?" },
      { id: "same", who: "Ada", at: NOW - 2, sentence: "First wording." },
      { id: "same", who: "Ada", at: NOW - 1, sentence: "Second wording." },
      { id: "blank", who: "Ada", at: NOW, sentence: "   " },
    ],
  }, NOW);
  expect(items).toHaveLength(1);
  expect(items[0]?.sentence).toBe("First wording.");
});

it("a quiet read does not replace the list the counts are showing", () => {
  needsYou(sources({ questions: [{ id: "one", who: "Ada", at: NOW, sentence: "Which font?" }] }), NOW);
  expect(needsListPublished()).toBe(true);
  expect(needsCount()).toBe(1);
  const quiet = needsYouQuiet(sources({
    questions: [
      { id: "one", who: "Ada", at: NOW, sentence: "Which font?" },
      { id: "two", who: "Ada", at: NOW, sentence: "Which colour?" },
    ],
  }), NOW);
  expect(quiet).toHaveLength(2);
  expect(needsCount()).toBe(1);
});

it("keeps the last good list when a later read is stale or timed out", () => {
  const first = { n: 1 };
  const second = { n: 2 };
  expect(takeLatest(1, 2, second, first)).toBe(first);
  expect(takeLatest(2, 2, undefined, first)).toBe(first);
  expect(takeLatest(2, 2, second, first)).toBe(second);
});
