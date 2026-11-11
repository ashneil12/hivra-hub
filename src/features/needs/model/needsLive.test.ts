import { expect, it, vi } from "vitest";
import { tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import { setHomeOpener, type HomeOpenTarget } from "../../home/model/opener";
import type { WaitingChat } from "../../hub/model/waitingChats";
import { pendingOpenPage, takeOpenRequest, type Page } from "../../pages/model/pages";
import type { PrWatch } from "../../pr-watch/model/prWatches";
import { needsYou, needsYouQuiet, takeLatest } from "./needsYou";
import {
  cardsAfter,
  factsFromHome,
  factsFromParts,
  keepExampleMark,
  mergeRemote,
  type GateCard,
  type NeedsParts,
  type RemoteNeeds,
} from "./needsLive";

const NOW = 1_700_000_000_000;
const PROJECTS = [
  { id: "hivra", name: "Hivra", folder: "/Users/example/Projects/hivra" },
  { id: "vg-game", name: "EXO", folder: "/Users/example/Projects/vg-game" },
  { id: "nibbii", name: "Nibbii", folder: "/Users/example/Projects/nibbii" },
];

function decision(project: string, key: string, question: string): Decision {
  return {
    project, decisionKey: key, question, options: ["Yes", "No"], recommended: "Yes",
    askedBy: "lead", askedByMono: null, waiting: [], state: "open", answer: null,
    answeredBy: null, answeredAt: null, createdAt: NOW, updatedAt: NOW, version: 1,
  };
}

function chat(question: string, projectId = "hivra"): WaitingChat {
  return {
    sessionId: `chat-${projectId}`,
    cwd: "/Users/example/Projects/hivra",
    title: "Lead",
    askedAt: NOW,
    source: "marker",
    question,
    pick: "Yes",
    redLine: false,
    projectId,
    projectName: projectId,
    chatName: "Hivra lead",
  } as WaitingChat;
}

function watch(project: string, repo: string): PrWatch {
  return {
    id: `watch-${repo}`,
    ownerSession: "lead",
    ownerMono: null,
    ownerName: "Ada",
    repo,
    number: 4,
    url: "",
    title: "Review the landing page",
    project,
    worktree: null,
    repoRoot: null,
    askIds: [],
    state: "watching",
    endReason: null,
    status: {
      pr: "open", draft: false, required: true, checks: 1, pending: 0, failed: [], passed: false,
      mergeable: "unknown", reviewDecision: "REVIEW_REQUIRED",
    },
    headSha: null, headRef: "branch", baseRef: "main", mergeSha: null, readFailures: 0, lastError: null,
    lastReadAt: null, nextReadAt: 0, wakesTotal: 0, createdAt: NOW, updatedAt: NOW, endedAt: null,
  };
}

function parts(remote: Partial<RemoteNeeds> = {}, extra: Partial<NeedsParts> = {}): NeedsParts {
  return {
    remote: { decisions: [], cards: [], watches: [], ...remote },
    rows: [],
    projects: PROJECTS,
    chats: [],
    pages: [],
    delegations: [],
    ...extra,
  };
}

it("counts an open decision and a task that needs you, and skips a removed one", () => {
  const list = needsYouQuiet(factsFromHome(
    [{ project: "crew", decisionKey: "ship", question: "Should we ship?", state: "open", createdAt: 1 }],
    [
      { id: "ask", projectId: "crew", title: "Which font?", status: "In progress", source: "agent", assignee: null, needsYou: true, trashedAt: null, createdAt: 2 },
      { id: "gone", projectId: "crew", title: "Removed", status: "In review", source: "agent", assignee: null, needsYou: false, trashedAt: 1, createdAt: 3 },
    ],
    [{ id: "crew", name: "Crew", folder: null }],
  ), NOW);
  expect(list).toHaveLength(2);
  expect(needsYouQuiet(factsFromHome([], [], []), NOW)).toHaveLength(0);
});

it("keeps a ready-to-merge decision, and a chat asking the same thing is not a second item", () => {
  const list = needsYou(factsFromParts(parts(
    { decisions: [decision("hivra", "m217", "Ready to merge #217.")] },
    { chats: [chat("Ready to merge #217.")] },
  )), NOW);
  expect(list).toHaveLength(1);
  expect(list[0]?.kind).toBe("merge");
  expect(list[0]?.actions.map((action) => action.label)).toEqual(["Merge", "Not yet"]);
  const answer = vi.spyOn(tauriFirstMate, "answer").mockResolvedValue({ ok: true, version: 1 });
  list[0]?.actions[0]?.run();
  list[0]?.actions[1]?.run();
  expect(answer).toHaveBeenNthCalledWith(1, "hivra", "m217", "Yes");
  expect(answer).toHaveBeenNthCalledWith(2, "hivra", "m217", "No");
  answer.mockRestore();
});

it("reads a wants-to-run and an asks-to-read as approvals", () => {
  const list = needsYou(factsFromParts(parts({
    decisions: [
      decision("nibbii", "pub", "frank wants to run npm publish in nibbii-web."),
      decision("safetube", "weekly", "The Weekly views page asks to read YouTube stats."),
    ],
  }, { projects: [...PROJECTS, { id: "safetube", name: "SafeTube", folder: null }] })), NOW);
  expect(list.map((item) => item.kind)).toEqual(["approval", "approval"]);
  const labels = (key: string) => list.find((item) => item.key === key)?.actions.map((action) => action.label);
  expect(labels("approval:nibbii:pub")).toEqual(["Allow once", "Deny"]);
  expect(labels("approval:safetube:weekly")).toEqual(["Review"]);
});

it("uses Allow once and Deny for a red-line step, and Allow for a safe one", () => {
  const answer = vi.spyOn(tauriFirstMate, "answer").mockResolvedValue({ ok: true, version: 1 });
  const list = needsYou(factsFromParts(parts({
    decisions: [
      decision("nibbii", "pub", "frank wants to run npm publish in nibbii-web."),
      decision("nibbii", "send", "frank wants to run a send to the customers."),
      decision("hivra", "wipe", "frank wants to run a delete of the customer records."),
      decision("hivra", "money", "frank wants to run a refund for the customer."),
      decision("exo", "key", "frank wants to run a read of the api key."),
      decision("nibbii", "test", "frank wants to run npm test in nibbii-web."),
    ],
  })), NOW);
  const labels = (key: string) => list.find((item) => item.key === `approval:${key}`)?.actions.map((action) => action.label);
  expect(labels("nibbii:pub")).toEqual(["Allow once", "Deny"]);
  expect(labels("nibbii:send")).toEqual(["Allow once", "Deny"]);
  expect(labels("hivra:wipe")).toEqual(["Allow once", "Deny"]);
  expect(labels("hivra:money")).toEqual(["Allow once", "Deny"]);
  expect(labels("exo:key")).toEqual(["Allow once", "Deny"]);
  expect(labels("nibbii:test")).toEqual(["Allow", "Deny"]);
  list.find((item) => item.key === "approval:nibbii:pub")?.actions[0]?.run();
  list.find((item) => item.key === "approval:nibbii:pub")?.actions[1]?.run();
  list.find((item) => item.key === "approval:nibbii:test")?.actions[0]?.run();
  expect(answer).toHaveBeenNthCalledWith(1, "nibbii", "pub", "Yes");
  expect(answer).toHaveBeenNthCalledWith(2, "nibbii", "pub", "No");
  expect(answer).toHaveBeenNthCalledWith(3, "nibbii", "test", "Yes");
  answer.mockRestore();
});

it("opens a page or plugin access ask with Review and does not allow it from Home", () => {
  const opened: HomeOpenTarget[] = [];
  const stop = setHomeOpener((target) => { opened.push(target); });
  const answer = vi.spyOn(tauriFirstMate, "answer").mockResolvedValue({ ok: true, version: 1 });
  const projects = [...PROJECTS, { id: "safetube", name: "SafeTube", folder: null }];
  const page = {
    id: "weekly-page",
    projectId: "safetube",
    title: "Weekly views",
    spec: { kind: "bespoke", title: "Weekly views", html: "", permissions: ["youtube.read"] },
    permissions: [],
    keptAt: NOW,
  } as unknown as Page;
  try {
    const list = needsYou(factsFromParts(parts({
      decisions: [
        decision("safetube", "weekly", "The Weekly views page asks to read YouTube stats."),
        decision("safetube", "plugin", "The YouTube plugin asks to read your uploads."),
      ],
    }, { projects, pages: [page] })), NOW);
    const labels = (key: string) => list.find((item) => item.key === key)?.actions.map((action) => action.label);
    expect(labels("approval:safetube:weekly")).toEqual(["Review"]);
    expect(labels("approval:safetube:plugin")).toEqual(["Review"]);
    expect(labels("approval:weekly-page")).toEqual(["Review"]);
    list.find((item) => item.key === "approval:safetube:weekly")?.actions[0]?.run();
    list.find((item) => item.key === "approval:safetube:plugin")?.actions[0]?.run();
    list.find((item) => item.key === "approval:weekly-page")?.actions[0]?.run();
    expect(opened).toEqual([
      { kind: "inbox", projectId: "safetube", decisionKey: "weekly" },
      { kind: "inbox", projectId: "safetube", decisionKey: "plugin" },
    ]);
    expect(pendingOpenPage()).toBe("weekly-page");
    expect(answer).not.toHaveBeenCalled();
  } finally {
    takeOpenRequest();
    answer.mockRestore();
    stop();
  }
});

it("collapses a parked gate and the decision that names it into one check", () => {
  const card: GateCard = {
    projectId: "hivra", id: "card-1", line: "The Windows build needs a look.", decisionKey: "ship", state: "parked",
  };
  const list = needsYou(factsFromParts(parts({
    decisions: [decision("hivra", "ship", "Should we ship?")],
    cards: [card],
  })), NOW);
  expect(list).toHaveLength(1);
  expect(list[0]?.kind).toBe("check");
  expect(list[0]?.actions.map((action) => action.label)).toEqual(["Approve", "Fix"]);
});

it("leaves out a review on a repo that is not one of the projects", () => {
  const list = needsYou(factsFromParts(parts({
    watches: [watch("hivra", "ash/hivra"), watch("upstream", "upstream/monocode")],
  })), NOW);
  expect(list.map((item) => item.key)).toEqual(["review:watch-ash/hivra"]);
});

it("keeps a timed-out project's cards and the last remote when a read does not arrive", () => {
  const kept: GateCard = { projectId: "hivra", id: "old", line: "Keep this.", decisionKey: "old", state: "parked" };
  const added: GateCard = { projectId: "vg-game", id: "new", line: "A new one.", decisionKey: "new", state: "parked" };
  expect(cardsAfter([kept], [{ projectId: "hivra", got: undefined }])).toBeUndefined();
  expect(cardsAfter([kept], [
    { projectId: "hivra", got: undefined },
    { projectId: "vg-game", got: [{ id: "new", line: "A new one.", decisionKey: "new", state: "parked" }] },
  ])).toEqual([kept, added]);
  expect(cardsAfter([kept], [{ projectId: "hivra", got: null }])).toEqual([]);

  const previous: RemoteNeeds = { decisions: [decision("hivra", "q", "Which?")], cards: [kept], watches: [] };
  expect(mergeRemote(previous, undefined)).toBe(previous);
  expect(takeLatest(1, 2, mergeRemote(previous, { decisions: [] }), previous)).toBe(previous);
  expect(mergeRemote(previous, { watches: undefined })).toEqual(previous);
});

it("keeps an example mark on a plain stopped reason", () => {
  expect(keepExampleMark("Out of credits", "Example: Out of credits")).toBe("Example: Out of credits");
  expect(keepExampleMark("Example: Out of credits", "Example: Out of credits")).toBe("Example: Out of credits");
  expect(keepExampleMark("Out of credits", "402 at /x/y.json")).toBe("Out of credits");
  expect(keepExampleMark("Out of credits", "  Example: low balance  ")).toBe("Example: Out of credits");
  expect(keepExampleMark("Out of credits", "")).toBe("Out of credits");
});

it("puts the example mark back from the worker a stopped job carries", () => {
  const stuck = (error: string) => ({
    row: { id: "upload-build", error, errorClass: "billing", childSession: "example-worker-chat" },
    kind: "failed" as const,
    line: "Failed: billing",
    since: NOW,
    escalated: true,
    key: "upload-build:failed",
  });
  const job = (error: string) => ({
    id: "app:upload-build",
    projectId: "vg-game",
    who: "EXO lead",
    kind: "worker" as const,
    doing: "Upload the playtest build",
    minutes: 1,
    steps: [],
    stuck: "stuck" as const,
    stuckReason: "Out of credits",
    stuckWorker: stuck(error),
    lead: "vg-game-lead",
  });
  const sentence = (error: string) => needsYouQuiet(factsFromParts(parts({}, {
    rows: [{ key: "job:app:upload-build", lead: "vg-game-lead", projectId: "vg-game", job: job(error) }],
  })), NOW)[0]?.sentence;
  // The job's own reason is already the plain line. The seeded fault still sits on the worker it carries.
  expect(sentence("Example: Out of credits")).toBe("Example: Out of credits");
  expect(sentence("402 Payment Required")).toBe("Out of credits");
  const lone = needsYouQuiet(factsFromParts(parts({}, {
    rows: [{ key: "worker:upload-build:failed", lead: "vg-game-lead", projectId: "vg-game", worker: { ...stuck("Example: Out of credits"), line: "Out of credits" } }],
  })), NOW);
  expect(lone[0]?.sentence).toBe("Example: Out of credits");
});

it("keeps a decision key so Home can open the inbox", () => {
  const list = needsYouQuiet(factsFromParts(parts({
    decisions: [decision("hivra", "ship", "Should we ship?")],
  })), NOW);
  expect(list.map((item) => item.sentence)).toEqual(["Should we ship?"]);
  expect(list[0]?.decisionKey).toBe("ship");
  expect(list[0]?.kind).toBe("question");
  const approval = needsYouQuiet(factsFromParts(parts({
    decisions: [decision("hivra", "run", "Ada wants to run the tests")],
  })), NOW);
  expect(approval[0]?.kind).toBe("approval");
  expect(approval[0]?.decisionKey).toBeUndefined();
});
