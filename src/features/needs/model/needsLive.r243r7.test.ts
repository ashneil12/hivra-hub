// @vitest-environment happy-dom
// Review of PR #243 (WP-210), round 7. The round 6 files stay as they are.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  cards: [] as unknown[],
  watches: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    ipc.calls.push({ cmd, args });
    if (cmd === "decisions_answer") return { applied: true, decision: null, released: [], releasedTasks: [] };
    if (cmd === "decisions_list") return [];
    if (cmd === "pr_watch_list") return ipc.watches;
    if (cmd === "gate_cards") return ipc.cards;
    return null;
  }),
}));

import type { Decision } from "../../firstmate/model/steering";
import type { HomeSource } from "../../home/model/load";
import { loadNeedsYouCount } from "../../home/model/load";
import { mockHubData } from "../../hub/model/mockData";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubProject } from "../../hub/model/types";
import type { PrWatch } from "../../pr-watch/model/prWatches";
import {
  answerPermission,
  answerRow,
  noteChats,
  resetWaitingChats,
  setWaitingChatsHost,
  setWorkerQuestionRouter,
  takePick,
  waitingChats,
} from "../../hub/model/waitingChats";
import { allKeptPages, keepPage, resetPagesForTest, type Page } from "../../pages/model/pages";
import { currentNeedsYouRows } from "../../hub/model/useNeedsYouRows";
import type { Delegation } from "../../monos/model/delegations";
import { delegationRows, resetDelegationStore, setDelegationRows } from "../../monos/model/delegationStore";
import { factsFromParts, resetNeedsLiveForTest, type NeedsParts, type RemoteNeeds } from "./needsLive";
import { needsYouQuiet } from "./needsYou";

const NOW = 1_700_000_000_000;
const CHANGED = "That changed while you were looking. Open the chat to see where it stands.";

const HUB_PROJECTS: HubProject[] = [
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder", folder: "/work/hivra" },
];

function parts(remote: Partial<RemoteNeeds> = {}, extra: Partial<NeedsParts> = {}): NeedsParts {
  return {
    remote: { decisions: [], cards: [], watches: [], ...remote },
    rows: [],
    projects: [{ id: "hivra", name: "Hivra", folder: "/work/hivra" }],
    chats: [],
    pages: [],
    delegations: [],
    tasks: [],
    ...extra,
  };
}

function decision(key: string, question: string, options: string[], recommended: string | null, askedBy = "lead"): Decision {
  return {
    project: "/work/hivra", decisionKey: key, question, options, recommended,
    askedBy, askedByMono: null, waiting: [], state: "open", answer: null,
    answeredBy: null, answeredAt: null, createdAt: NOW, updatedAt: NOW, version: 1,
  };
}

function watch(project: string, repo: string): PrWatch {
  return {
    id: `watch-${project}-${repo}`,
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

const sent: string[] = [];
const decided: [string, number, string][] = [];

function fresh() {
  localStorage.clear();
  resetWaitingChats();
  resetNeedsLiveForTest();
  resetPagesForTest();
  sent.length = 0;
  decided.length = 0;
  ipc.calls.length = 0;
  ipc.cards = [];
  ipc.watches = [];
  resetDelegationStore();
  setHubDataSource({ ...mockHubData, listProjects: () => HUB_PROJECTS });
  setWorkerQuestionRouter(undefined);
  setWaitingChatsHost({
    liveQuestion: () => undefined,
    respond: () => {},
    send: async (_id, text) => (sent.push(text), true),
    open: () => {},
    note: async (_id, message) => (sent.push(message.text), true),
    decide: (id, requestId, choice) => void decided.push([id, requestId, choice]),
  });
}
beforeEach(fresh);
afterEach(() => {
  resetPagesForTest();
  resetNeedsLiveForTest();
  resetDelegationStore();
});

function lead(id: string, reply: string) {
  return {
    id, cwd: "/work/hivra", title: "Hivra lead", harness: "claude", busy: false, queuedMessages: [],
    blocks: [{ role: "user", text: "go", startedAt: 1 }, { role: "assistant", text: reply }],
  } as Parameters<typeof noteChats>[0][number];
}

it("refuses a one tap when the question changed after the row was drawn", async () => {
  noteChats([lead("price", "Needs Ash: Which price should the store show?\nMy pick: Raise it to $9.")], 1000);
  const chat = waitingChats().find((row) => row.sessionId === "price");
  expect(chat?.pick).toBe("Raise it to $9.");
  const stale = await takePick("price", { by: "ash", seen: { requestId: chat?.requestId, question: "Which price was it?", pick: chat?.pick } });
  expect(stale).toMatchObject({ ok: false, reason: CHANGED });
  expect(sent).toEqual([]);
  const taken = await takePick("price", { by: "ash", seen: { requestId: chat?.requestId, question: chat!.question, pick: chat?.pick } });
  expect(taken.ok).toBe(true);

  fresh();
  const card = [
    "Needs Ash: Which font should the landing page use?",
    "My pick: Inter.",
    "",
    "Needs Ash (red line): What should happen to the old backups?",
    "My pick: Delete them now.",
  ].join("\n");
  noteChats([lead("card", card)], 1000);
  const rows = waitingChats().find((row) => row.sessionId === "card")?.rows ?? [];
  const font = rows.find((row) => row.question.includes("font"));
  expect(font).toBeDefined();
  const moved = await answerRow("card", font!, font!.pick ?? "Inter.", "pick", {
    requestId: 99,
    question: font!.question,
    pick: "Something else",
  });
  expect(moved).toMatchObject({ ok: false, reason: CHANGED });
  expect(sent).toEqual([]);

  fresh();
  const held = {
    id: "team1",
    cwd: "/work/hivra",
    title: "claude · Health board",
    harness: "claude",
    busy: true,
    blocks: [
      { role: "user", text: "build the health board", startedAt: 1 },
      { role: "tool", text: "", approval: { requestId: 7, call: { tool: "Bash", command: "git worktree add ../tally-health-board" } } },
    ],
  } as Parameters<typeof noteChats>[0][number];
  noteChats([held], 1000);
  const permission = waitingChats().find((row) => row.sessionId === "team1");
  expect(permission?.source).toBe("permission");
  expect(answerPermission("team1", "allow", { requestId: 99, question: permission?.question })).toMatchObject({ ok: false, reason: CHANGED });
  expect(decided).toEqual([]);
  expect(answerPermission("team1", "allow", { requestId: permission?.requestId, question: permission?.question })).toMatchObject({ ok: true, sent: "Allowed" });
  expect(decided).toEqual([["team1", 7, "allow"]]);
});

it("keeps a review only when it is that project's own repo", () => {
  const projects = [
    { id: "hivra", name: "Hivra", folder: "/work/hivra", origin: "https://github.com/ashneil12/hivra-hub.git" },
    { id: "exo", name: "EXO", folder: "/work/exo", origin: "https://github.com/ash/exo.git" },
  ];
  const keys = (repo: string, project: string) => needsYouQuiet(
    factsFromParts(parts({ watches: [watch(project, repo)] }, { projects })),
    NOW,
  ).map((item) => item.key);
  expect(keys("ash/exo", "hivra")).toEqual([]);
  expect(keys("ash/exo", "exo")).toEqual(["review:watch-exo-ash/exo"]);
  expect(keys("ASHNEIL12/HIVRA-HUB", "hivra")).toEqual(["review:watch-hivra-ASHNEIL12/HIVRA-HUB"]);
  expect(keys("ashneil12/monocode-hub", "hivra")).toEqual(["review:watch-hivra-ashneil12/monocode-hub"]);
});

it("keeps two questions that only match for the first 140 characters", () => {
  const stem = `${"Which build should ship when the window closes and the notes are still open for review by the team that asked. ".repeat(2)}`;
  expect(stem.length).toBeGreaterThan(140);
  const list = needsYouQuiet(factsFromParts(parts({}, {
    chats: [
      {
        sessionId: "lead-a", cwd: "/work/hivra", title: "A", askedAt: NOW, source: "marker",
        question: `${stem} alpha stays`, pick: "The first", redLine: false, more: 0,
        projectId: "hivra", projectName: "Hivra", chatName: "A",
      },
      {
        sessionId: "lead-b", cwd: "/work/hivra", title: "B", askedAt: NOW, source: "marker",
        question: `${stem} beta stays`, pick: "The second", redLine: false, more: 0,
        projectId: "hivra", projectName: "Hivra", chatName: "B",
      },
    ],
  })), NOW);
  expect(list).toHaveLength(2);
});

// Limit. An option worded Open is not a one tap, so the row's Open looks and does not answer.
it("an option named Open is the way out and it does not send Open", async () => {
  const [item] = needsYouQuiet(factsFromParts(parts({
    decisions: [decision("open-it", "Which Windows build should ship?", ["Open", "No"], "Open")],
  })), NOW);
  expect(item?.actions.map((action) => action.label)).toEqual(["Open"]);
  item?.actions[0]?.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const answers = ipc.calls.filter((call) => call.cmd === "decisions_answer");
  expect(answers.map((call) => call.args.answer)).toEqual([]);
});

// Limit. A parked card is Open only, so the row does not approve it from Needs you.
it("a parked decision does not answer under the name Approve", async () => {
  const parked = decision("ship-win", "Ship the Windows build?", ["Yes", "No"], "Yes");
  const [item] = needsYouQuiet(factsFromParts(parts({
    decisions: [parked],
    cards: [{ projectId: "hivra", id: "card-1", line: "Ship the Windows build?", decisionKey: "ship-win", state: "parked" }],
  })), NOW);
  expect(item?.kind).toBe("check");
  expect(item?.actions.map((action) => action.label)).not.toEqual(["Approve", "Fix"]);
  item?.actions[0]?.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ipc.calls.some((call) => call.cmd === "decisions_answer")).toBe(false);
  expect(ipc.calls.some((call) => call.cmd === "gate_respond" && call.args.answer === "Approve")).toBe(false);
});

it("the opening count includes a page that still asks for access", async () => {
  const source = {
    decisions: async () => [],
    tasks: async () => [],
    docs: async () => [],
    projects: () => [{ id: "hivra", name: "Hivra", folder: "/work/hivra" }],
    catalog: async () => [],
    disk: {},
    storage: {},
  } as HomeSource;
  expect(await loadNeedsYouCount(source)).toBe(0);
  const page: Page = {
    id: "weekly",
    projectId: "hivra",
    title: "Weekly views",
    request: "",
    by: "lead",
    spec: { kind: "bespoke", title: "Weekly views", html: "<p></p>", permissions: ["agents.answer"] },
    permissions: [],
  };
  expect(await keepPage(page, NOW, { allow: false })).toBe(true);
  expect(await loadNeedsYouCount(source)).toBe(1);
});

it("the quiet opening count matches the drawn list for a stopped worker, a check, a page and a review", async () => {
  const settled = Date.now() - 60_000;
  const row: Delegation = {
    id: "t-stop",
    ownerSession: "lead-chat",
    ownerMono: "exo",
    batchId: null,
    parentId: null,
    rootId: "t-stop",
    childSession: "w-stop",
    requestId: "r-stop",
    generation: 1,
    project: "hivra",
    title: "Upload the playtest build",
    brief: null,
    goal: null,
    askIds: [],
    state: "failed",
    errorClass: "billing",
    error: "402 Payment Required",
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: settled,
    updatedAt: settled,
    settledAt: settled,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
  };
  setDelegationRows([row]);
  const page: Page = {
    id: "weekly",
    projectId: "hivra",
    title: "Weekly views",
    request: "",
    by: "lead",
    spec: { kind: "bespoke", title: "Weekly views", html: "<p></p>", permissions: ["agents.answer"] },
    permissions: [],
  };
  expect(await keepPage(page, NOW, { allow: false })).toBe(true);
  ipc.cards = [{ id: "card-win", line: "The Windows tests are still red.", decisionKey: "gate/win", state: "parked" }];
  ipc.watches = [{
    id: "watch-land", state: "watching", repo: "", number: 4, title: "Review the landing page",
    project: "hivra", ownerSession: "lead", ownerMono: null, ownerName: "Ada",
    status: { reviewDecision: "REVIEW_REQUIRED" }, updatedAt: NOW,
  }];
  const source = {
    decisions: async () => [],
    tasks: async () => [],
    docs: async () => [],
    projects: () => [{ id: "hivra", name: "Hivra", folder: "/work/hivra" }],
    catalog: async () => [],
    disk: {},
    storage: {},
  } as HomeSource;
  const opening = await loadNeedsYouCount(source);
  const drawn = needsYouQuiet(factsFromParts({
    remote: {
      decisions: [],
      cards: [{ projectId: "/work/hivra", id: "card-win", line: "The Windows tests are still red.", decisionKey: "gate/win", state: "parked" }],
      watches: [watch("hivra", "")],
    },
    rows: currentNeedsYouRows(),
    projects: [{ id: "hivra", name: "Hivra", folder: "/work/hivra" }],
    chats: waitingChats(),
    pages: allKeptPages(),
    delegations: delegationRows().map((item) => ({ id: item.id, state: item.state, project: item.project })),
    tasks: [],
  }), Date.now());
  expect(opening).toBe(drawn.length);
  expect(drawn.map((item) => item.kind).sort()).toEqual(["approval", "check", "review", "stopped"]);
});
