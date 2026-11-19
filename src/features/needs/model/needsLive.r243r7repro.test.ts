// @vitest-environment happy-dom
// Review of PR #243 (WP-210), round 7: each test here fails on 57333ed5c and names one finding.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[], cards: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    ipc.calls.push({ cmd, args });
    if (cmd === "decisions_answer") return { applied: true, decision: null, released: [], releasedTasks: [] };
    if (cmd === "gate_cards") return ipc.cards;
    if (cmd === "decisions_list" || cmd === "pr_watch_list") return [];
    return null;
  }),
}));

import type { Decision } from "../../firstmate/model/steering";
import type { HomeSource } from "../../home/model/load";
import { loadNeedsYouCount } from "../../home/model/load";
import { mockHubData } from "../../hub/model/mockData";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubProject } from "../../hub/model/types";
import { noteChats, resetWaitingChats, setWaitingChatsHost, setWorkerQuestionRouter, waitingChats } from "../../hub/model/waitingChats";
import { StuckPanel } from "../../monos/ui/StuckPanel";
import { factsFromChats, factsFromParts, resetNeedsLiveForTest, type GateCard, type NeedsParts, type RemoteNeeds } from "./needsLive";
import { needsYouQuiet, type NeedsItem } from "./needsYou";

const NOW = 1_700_000_000_000;
const FOLDER = "/Users/ash/Projects/hivra";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const HUB_PROJECTS: HubProject[] = [{ id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder", folder: FOLDER }];
const PROJECTS = HUB_PROJECTS.map((project) => ({ id: project.id, name: project.name, folder: project.folder ?? null }));

function parts(remote: Partial<RemoteNeeds> = {}, extra: Partial<NeedsParts> = {}): NeedsParts {
  return {
    remote: { decisions: [], cards: [], watches: [], ...remote },
    rows: [],
    projects: PROJECTS,
    chats: [],
    pages: [],
    delegations: [],
    tasks: [],
    ...extra,
  };
}

function decision(key: string, question: string, options: string[], recommended: string | null): Decision {
  return {
    project: FOLDER, decisionKey: key, question, options, recommended,
    askedBy: "lead", askedByMono: null, waiting: [], state: "open", answer: null,
    answeredBy: null, answeredAt: null, createdAt: NOW, updatedAt: NOW, version: 1,
  };
}

const sent: string[] = [];
beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  resetNeedsLiveForTest();
  sent.length = 0;
  ipc.calls.length = 0;
  ipc.cards = [];
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

function only(d: Decision): NeedsItem {
  const items = needsYouQuiet(factsFromParts(parts({ decisions: [d] })), NOW);
  expect(items, d.decisionKey).toHaveLength(1);
  return items[0]!;
}

/** Run one button and return what it stored on the decision, if anything. */
async function tap(run: () => void): Promise<string[]> {
  ipc.calls.length = 0;
  run();
  await flush();
  return ipc.calls.filter((call) => call.cmd === "decisions_answer").map((call) => String(call.args.answer));
}

// HIGH (r7-1). A merge or approval decision whose options are Yes and No still puts fixed words over them: "Merge" and
// "Allow" (or "Allow once") send "Yes", "Not yet" and "Deny" send "No". The browser fixture's merge and npm publish rows
// are this shape. Round 6's fix was "show Merge / Not yet / Allow only when that literal option exists and send exactly
// it; otherwise Open".
it("a Yes or No decision's buttons say the option they send", async () => {
  const merge = decision("m217", "Ready to merge #217.", ["Yes", "No"], "Yes");
  const publish = decision("pub", "frank wants to run npm publish in nibbii-web.", ["Yes", "No"], "Yes");
  for (const d of [merge, publish]) {
    for (const action of only(d).actions) {
      for (const answer of await tap(action.run)) {
        expect(`${d.decisionKey}: ${action.label} -> ${answer}`).toBe(`${d.decisionKey}: ${answer} -> ${answer}`);
      }
    }
  }
});

// HIGH (r7-2). The first button on a merge or approval decision ignores the recommendation. With "Not yet" (or nothing)
// recommended, the blue Merge still merges; with "Deny" or "No" recommended, the first button still allows ("Allow always"
// is picked as the first allow word in the options). Round 6 said: no fallback to the first option or to Yes.
it("a decision row's first button sends only the recommended option", async () => {
  const cases = [
    decision("m1", "Ready to merge #217.", ["Merge", "Not yet"], "Not yet"),
    decision("m2", "Ready to merge #218.", ["Merge", "Not yet"], null),
    decision("m3", "Ready to merge #219.", ["Yes", "No"], "No"),
    decision("a1", "frank wants to run the prod migration.", ["Allow always", "Deny"], "Deny"),
    decision("a2", "frank wants to run the cleanup script.", ["Allow always", "Allow once", "No"], null),
    decision("a3", "frank wants to run npm publish in nibbii-web.", ["Yes", "No"], "No"),
  ];
  for (const d of cases) {
    const first = only(d).actions[0];
    if (!first) continue;
    for (const answer of await tap(first.run)) {
      expect(`${d.decisionKey}: ${first.label} -> ${answer}`).toBe(`${d.decisionKey}: ${first.label} -> ${d.recommended}`);
    }
  }
});

// HIGH (r7-3). A delivery check (gate/<run>) is person-only, and decisionFacts opens it. But the gate card's own row has
// Approve and Fix, and the collapse keeps the row with more buttons, so Home's blue Approve ships the work from one line
// (the card's finding and PR link are not on the row). The card alone has no Open at all.
it("a delivery check opens from Needs you and is never approved or fixed from the row", async () => {
  const gate = decision("gate/run-7", "The delivery check found 2 failing tests.", ["Approve", "Fix", "Skip"], null);
  const card: GateCard = { projectId: FOLDER, id: "card-7", line: "Check parked: 2 failing tests", decisionKey: "gate/run-7", state: "parked" };
  for (const remote of [{ decisions: [gate], cards: [card] }, { cards: [card] }]) {
    const items = needsYouQuiet(factsFromParts(parts(remote)), NOW);
    expect(items).toHaveLength(1);
    const row = items[0]!;
    expect(row.actions.length).toBeGreaterThan(0);
    for (const action of row.actions) {
      ipc.calls.length = 0;
      action.run();
      await flush();
      const answered = ipc.calls.filter((call) => call.cmd === "gate_respond" || call.cmd === "decisions_answer");
      expect(`${remote.decisions ? "decision+card" : "card"}: ${action.label} answers ${answered.length}`).toBe(
        `${remote.decisions ? "decision+card" : "card"}: ${action.label} answers 0`,
      );
    }
  }
});

// MED (r7-4). An option worded like the row's own way out takes its place: options ["Open", "Closed"] with "Open"
// recommended give one bordered "Open" that looks like every other row's Open but answers the decision. Ash taps it to
// look and the answer is stored; the row has no way to open the card.
it("an option worded Open is never a button named Open that answers", async () => {
  const d = decision("pr-231", "Should #231 stay Open or be Closed?", ["Open", "Closed"], "Open");
  const row = only(d);
  let wayOut = false;
  for (const action of row.actions) {
    const answers = await tap(action.run);
    if (answers.length === 0) wayOut = true;
    if (action.label === "Open") expect(`Open -> ${answers.join(", ") || "opens"}`).toBe("Open -> opens");
  }
  expect(wayOut).toBe(true);
});

// MED (r7-5). A red-line approval decision with literal allow options skips the red-line look: npm publish shows a blue
// "Allow always" and a bordered "Allow once", and no Deny, No or Open. Round 5 made a red line "Allow once" and "Deny".
it("a red-line approval decision never offers Allow always from the row, and keeps a way to refuse", async () => {
  const d = decision("pub2", "frank wants to run npm publish in nibbii-web.", ["Allow always", "Allow once", "No"], "Allow always");
  const row = only(d);
  expect(row.actions.map((action) => action.label)).not.toContain("Allow always");
  let refuse = false;
  for (const action of row.actions) {
    const answers = await tap(action.run);
    if (answers.length === 0 || answers.every((answer) => answer === "No")) refuse = true;
  }
  expect(refuse).toBe(true);
});

// MED (r7-6). The Mono panel lists the same one taps, but its buttons drop the full words. A chat pick over 80
// characters shows its first 77 and "..."; Home keeps the rest in the title and aria-label, the panel nowhere.
it("the Mono panel's one tap carries the full answer when its words are shortened", async () => {
  const pick = "Raise it to $9 for new customers from next month and keep the old price for everyone already on a plan.";
  const reply = `Needs Ash: Which price should the store show next month?\nMy pick: ${pick}`;
  noteChats([{
    id: "price", cwd: FOLDER, title: "Hivra lead", harness: "claude", busy: false, queuedMessages: [],
    blocks: [{ role: "user", text: "go", startedAt: 1 }, { role: "assistant", text: reply }],
  } as Parameters<typeof noteChats>[0][number]], 1000);
  const item = needsYouQuiet(factsFromChats(waitingChats()), NOW).find((row) => row.sentence.startsWith("Which price"));
  expect(item).toBeDefined();
  const shortened = item!.actions[0]!;
  expect(shortened.label.length).toBeLessThan(pick.length);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(StuckPanel, {
    anchor: { x: 0, y: 0 },
    title: "Hivra lead",
    stuck: [],
    asks: [{ id: item!.key, sentence: item!.sentence, actions: item!.actions }],
    now: NOW,
    onClose: () => {},
  })));
  const button = [...document.querySelectorAll<HTMLButtonElement>("[data-stuck-panel-ask] button")]
    .find((node) => node.textContent === shortened.label);
  expect(button).toBeDefined();
  const named = [button!.title, button!.getAttribute("aria-label") ?? ""];
  expect(named).toContain(pick);
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// LOW (r7-7). Home's opening count builds its decisions with no parked set, so a gate card and the open decision it
// parked are two items there and one item on the drawn list. The builder's matching test has no decision behind its card.
it("the quiet opening count counts a parked check and its own decision once", async () => {
  ipc.cards = [{ id: "card-7", line: "Check parked: 2 failing tests", decisionKey: "gate/run-7", state: "parked" }];
  const gate = decision("gate/run-7", "The delivery check found 2 failing tests.", ["Approve", "Fix", "Skip"], null);
  const source = {
    decisions: async () => [gate],
    tasks: async () => [],
    docs: async () => [],
    projects: () => PROJECTS,
    catalog: async () => [],
    disk: {},
    storage: {},
  } as unknown as HomeSource;
  const opening = await loadNeedsYouCount(source);
  const drawn = needsYouQuiet(factsFromParts(parts({
    decisions: [gate],
    cards: [{ projectId: FOLDER, id: "card-7", line: "Check parked: 2 failing tests", decisionKey: "gate/run-7", state: "parked" }],
  })), NOW);
  expect(drawn).toHaveLength(1);
  expect(opening).toBe(drawn.length);
});
