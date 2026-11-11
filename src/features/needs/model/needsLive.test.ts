import { expect, it } from "vitest";
import type { Decision } from "../../firstmate/model/steering";
import type { WaitingChat } from "../../hub/model/waitingChats";
import type { PrWatch } from "../../pr-watch/model/prWatches";
import { needsYou, needsYouQuiet, takeLatest } from "./needsYou";
import {
  cardsAfter,
  factsFromHome,
  factsFromParts,
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
  expect(list[0]?.actions.map((action) => action.label)).toEqual(["Yes"]);
});

it("reads a wants-to-run and an asks-to-read as approvals", () => {
  const list = needsYou(factsFromParts(parts({
    decisions: [
      decision("nibbii", "pub", "frank wants to run npm publish in nibbii-web."),
      decision("safetube", "weekly", "The Weekly views page asks to read YouTube stats."),
    ],
  }, { projects: [...PROJECTS, { id: "safetube", name: "SafeTube", folder: null }] })), NOW);
  expect(list.map((item) => item.kind)).toEqual(["approval", "approval"]);
  expect(list[0]?.actions.map((action) => action.label)).toEqual(["Allow", "Deny"]);
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
