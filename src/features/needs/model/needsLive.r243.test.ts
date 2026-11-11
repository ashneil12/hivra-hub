// @vitest-environment happy-dom
// Review of PR #243 (WP-210), round 1: each test here fails on the PR head and names one finding.
import { beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    ipc.calls.push({ cmd, args });
    if (cmd === "decisions_answer") return { applied: true, decision: null, released: [], releasedTasks: [] };
    if (cmd === "decisions_list" || cmd === "pr_watch_list" || cmd === "gate_cards") return [];
    return null;
  }),
}));

import type { Decision } from "../../firstmate/model/steering";
import { mockHubData } from "../../hub/model/mockData";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubProject } from "../../hub/model/types";
import {
  noteChats,
  openRows,
  resetWaitingChats,
  setWaitingChatsHost,
  setWorkerQuestionRouter,
  waitingChats,
  type WaitingChat,
} from "../../hub/model/waitingChats";
import type { Page } from "../../pages/model/pages";
import { describeCapability, type Capability } from "../../pages/model/pageSpec";
import type { PrWatch } from "../../pr-watch/model/prWatches";
import { loadNeedsYouCount, type HomeSource } from "../../home/model/load";
import { factsFromChats, factsFromParts, type GateCard, type NeedsParts, type RemoteNeeds } from "./needsLive";
import { needsYou, needsYouQuiet } from "./needsYou";

const NOW = 1_700_000_000_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const HUB_PROJECTS: HubProject[] = [
  { id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/Users/ash/Projects/tally" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder", folder: "/Users/ash/Projects/hivra" },
];
const PROJECTS = HUB_PROJECTS.map((project) => ({ id: project.id, name: project.name, folder: project.folder ?? null }));

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

function decision(key: string, question: string, options: string[], recommended: string | null, state: "open" | "answered" = "open"): Decision {
  return {
    project: "/Users/ash/Projects/hivra", decisionKey: key, question, options, recommended,
    askedBy: "lead", askedByMono: null, waiting: [], state, answer: null,
    answeredBy: null, answeredAt: null, createdAt: NOW, updatedAt: NOW, version: 1,
  };
}

const sent: string[] = [];
beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  sent.length = 0;
  ipc.calls.length = 0;
  setHubDataSource({ ...mockHubData, listProjects: () => HUB_PROJECTS });
  setWorkerQuestionRouter(undefined);
  setWaitingChatsHost({
    liveQuestion: () => undefined,
    respond: () => {},
    send: async (_id, text) => (sent.push(text), true),
    open: () => {},
    note: async (_id, message) => (sent.push(message.text), true),
  });
});

// HIGH 1. A card with several "Needs Ash" decisions is one item per row, but every row's button is the whole chat's
// handler: one tap sends the last row's pick for all of them and drops every row, the red-line one included.
it("one row of a card with several decisions answers that row only", async () => {
  const reply = [
    "Needs Ash: Publish the privacy page now, or wait for your wording?",
    "My pick: Wait for my wording.",
    "",
    "Needs Ash: Keep the beta price, or move to the new one?",
    "My pick: Keep the beta price.",
    "",
    "Needs Ash: Send the store reply as drafted, or hold it?",
    "My pick: Hold it.",
  ].join("\n");
  noteChats([{
    id: "lead1", cwd: "/Users/ash/Projects/tally", title: "Tally lead", harness: "claude", busy: false, queuedMessages: [],
    blocks: [{ role: "user", text: "here's my list", startedAt: 1 }, { role: "assistant", text: reply }],
  } as Parameters<typeof noteChats>[0][number]], 1000);
  const items = needsYou(factsFromChats(waitingChats()), NOW);
  const price = items.find((item) => item.sentence.startsWith("Keep the beta price"))!;
  expect(price).toBeDefined();
  price.actions[0]!.run();
  await flush();
  // The tap answered the price row with the price row's own answer, nothing else.
  expect(sent.join("\n")).not.toContain("Hold it");
  expect(openRows(waitingChats("tally")[0]!).map((row) => row.question)).toEqual([
    "Publish the privacy page now, or wait for your wording?",
    "Send the store reply as drafted, or hold it?",
  ]);
});

// HIGH 2. A decision row's one tap answers `recommended ?? options[0] ?? "Yes"` under the label "Answer", "Yes" or
// "Allow". The decision's own door (FirstMateInbox, localHub answerDecision) needs Ash to pick an option. For a
// fresh-eyes review with findings (person-only key, no recommendation) and a delivery check whose card is not loaded,
// options[0] is "Approve", which the store records as the person's and relays to the gate.
it("a decision row never commits an option its button does not name", async () => {
  const review = decision("fresh-eyes/req-1", "Fresh eyes found 2 problems in the plan.", ["Approve", "Edit plan", "Skip once"], null);
  const gate = decision("gate/run-1", "The check needs a decision: tests fail on Windows", ["Approve", "Fix", "Skip"], null);
  for (const d of [review, gate]) {
    const [item] = needsYouQuiet(factsFromParts(parts({ decisions: [d] })), NOW);
    expect(item).toBeDefined();
    for (const action of item!.actions) {
      ipc.calls.length = 0;
      action.run();
      await flush();
      const answered = ipc.calls.filter((call) => call.cmd === "decisions_answer").map((call) => call.args.answer);
      for (const answer of answered) expect(`${d.decisionKey}: ${action.label} -> ${String(answer)}`).toBe(`${d.decisionKey}: ${String(answer)} -> ${String(answer)}`);
    }
  }
});

// MED 3. An errand only Ash can do (a key he has to make) had no Approve/Deny and no Take the pick on its old card
// (r65). Here it gets Allow ("Approved, this once: …") or a one-tap pick.
it("an errand only Ash can do offers no Allow, Deny or pick", () => {
  const errand = {
    sessionId: "lead-key", cwd: "/Users/ash/Projects/hivra", title: "Hivra lead", askedAt: NOW, source: "marker",
    question: "Create a Stripe API key for prod", provide: "a Stripe API key for prod", flag: "provide", pick: "Done",
    redLine: true, more: 0, projectId: "hivra", projectName: "Hivra", chatName: "Hivra lead",
  } as WaitingChat;
  const items = needsYou(factsFromChats([errand, { ...errand, sessionId: "lead-key-2", redLine: false }]), NOW);
  expect(items).toHaveLength(2);
  for (const item of items) expect(item.actions.map((action) => action.label)).toEqual(["Open"]);
});

// MED 4. Ownership is circular: ownRepos is every repo a watch filed under a project has, and a review filed under a
// known project passes on its project alone. A PR watch on upstream lands under the owner's only project.
it("a review on an upstream repo filed under one of the projects is left out", () => {
  const watch = (repo: string): PrWatch => ({
    id: `watch-${repo}`, ownerSession: "lead", ownerMono: null, ownerName: "Ada", repo, number: 4, url: "",
    title: `Review ${repo}#4`, project: "hivra", worktree: null, repoRoot: null, askIds: [], state: "watching",
    endReason: null,
    status: { pr: "open", draft: false, required: true, checks: 1, pending: 0, failed: [], passed: false, mergeable: "unknown", reviewDecision: "REVIEW_REQUIRED" },
    headSha: null, headRef: "b", baseRef: "main", mergeSha: null, readFailures: 0, lastError: null, lastReadAt: null,
    nextReadAt: 0, wakesTotal: 0, createdAt: NOW, updatedAt: NOW, endedAt: null,
  } as PrWatch);
  const live = needsYouQuiet(factsFromParts(parts({ watches: [watch("hardbeat920/monocode")] })), NOW);
  expect(live.map((item) => item.key)).toEqual([]);
  const pure = needsYouQuiet({
    ownRepos: new Set(["ashneil12/hivra-hub"]),
    knownProjects: new Set(["hivra"]),
    reviews: [{ id: "up", projectId: "hivra", repo: "hardbeat920/monocode", who: "Ada", at: NOW, sentence: "Review upstream #4." }],
  }, NOW);
  expect(pure).toEqual([]);
});

// MED 5. A check answered with its own handler stays on every count: gate_respond emits no change event, nothing
// re-reads the store, and the card stays "parked" after the answer (the run moves on later), with no look at
// whether its decision is still open.
it("an answered check leaves the list, and opening the card does not answer the gate", async () => {
  const card: GateCard = { projectId: "/Users/ash/Projects/hivra", id: "card-1", line: "Tests fail on Windows.", decisionKey: "gate/run-1", state: "parked" };
  const answered = decision("gate/run-1", "The check needs a decision: tests fail on Windows", ["Approve", "Fix", "Skip"], null, "answered");
  expect(needsYouQuiet(factsFromParts(parts({ decisions: [answered], cards: [card] })), NOW)).toEqual([]);

  const [check] = needsYouQuiet(factsFromParts(parts({ cards: [card] })), NOW);
  check!.actions[0]!.run();
  await flush();
  await flush();
  const after = ipc.calls.slice(ipc.calls.findIndex((call) => call.cmd === "gate_respond") + 1).map((call) => call.cmd);
  // Limit. A gate card is Open only, so the row does not answer it and does not re-read the store.
  expect(after.some((cmd) => cmd === "gate_cards" || cmd === "decisions_list")).toBe(false);
});

// Limit. Tracker tasks now come from the live read. These steps build the list with no tasks and no
// live read, so it cannot see the task the opening count sees. The live path is tested beside this file.
it("an empty parts list does not include the task the opening count reads", async () => {
  const source = {
    projects: () => [{ id: "hivra", name: "Hivra", folder: "/Users/ash/Projects/hivra" }],
    decisions: async () => [],
    tasks: async (key: string) => (key === "hivra"
      ? [{ id: "t1", projectId: "hivra", title: "Which font for the landing page?", status: "In progress", source: "agent", needsYou: true, createdAt: 1 }]
      : []),
  } as unknown as HomeSource;
  const opening = await loadNeedsYouCount(source);
  const list = needsYouQuiet(factsFromParts(parts()), NOW);
  expect(opening).not.toBe(list.length);
});

// MED 7. The Page's own Allow sits under the list of what it grants ("This page asks to: …"). The row grants every
// ask (answering agents, taking picks, stopping work) from "<title> asks for access." with no list.
it("a page's access ask is not granted from a row that does not say what it grants", () => {
  const asks: Capability[] = ["agents.answer", "agents.pick", "agents.stop"];
  const page = {
    id: "page-1", projectId: "hivra", title: "Example: Weekly views", request: "", by: "lead",
    spec: { kind: "bespoke", title: "Weekly views", html: "<p></p>", permissions: asks },
    permissions: [], keptAt: NOW, removed: false,
  } as Page;
  const [item] = needsYouQuiet(factsFromParts(parts({}, { pages: [page] })), NOW);
  expect(item).toBeDefined();
  if (item!.actions.some((action) => action.label === "Allow")) {
    for (const ask of asks) expect(item!.sentence).toContain(describeCapability(ask));
  }
});
