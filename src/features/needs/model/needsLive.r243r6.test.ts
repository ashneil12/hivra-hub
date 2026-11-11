// @vitest-environment happy-dom
// Review of PR #243 (WP-210), round 6: each test here fails on f892dbdb4 and names one finding.
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
  resetWaitingChats,
  setWaitingChatsHost,
  setWorkerQuestionRouter,
  waitingChats,
  type WaitingChat,
} from "../../hub/model/waitingChats";
import { factsFromChats, factsFromParts, type NeedsParts, type RemoteNeeds } from "./needsLive";
import { needsYou, needsYouQuiet, type NeedsItem } from "./needsYou";

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
    tasks: [],
    ...extra,
  };
}

function decision(key: string, question: string, options: string[], recommended: string | null, askedBy = "lead"): Decision {
  return {
    project: "/Users/ash/Projects/hivra", decisionKey: key, question, options, recommended,
    askedBy, askedByMono: null, waiting: [], state: "open", answer: null,
    answeredBy: null, answeredAt: null, createdAt: NOW, updatedAt: NOW, version: 1,
  };
}

const sent: string[] = [];
function fresh() {
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
}
beforeEach(fresh);

function lead(id: string, reply: string) {
  return {
    id, cwd: "/Users/ash/Projects/tally", title: "Tally lead", harness: "claude", busy: false, queuedMessages: [],
    blocks: [{ role: "user", text: "here's my list", startedAt: 1 }, { role: "assistant", text: reply }],
  } as Parameters<typeof noteChats>[0][number];
}

/** What a person reads on the row: its sentence and its button words. */
function shown(item: NeedsItem): string {
  return [item.sentence, ...item.actions.map((action) => action.label)].join(" | ");
}

// HIGH. A decision's Merge, Not yet, Allow and Allow once buttons are fixed words, but each sends whichever option the
// decision recommends (or the first other option). With "Not yet" recommended, Merge sends "Not yet" and Not yet sends
// "Merge". On a red-line run, "Allow once" sends a recommended "Allow always".
it("a merge or approval decision's buttons send only the option they name", async () => {
  const merge = decision("m217", "Ready to merge #217.", ["Merge", "Not yet"], "Not yet");
  const publish = decision("pub", "frank wants to run npm publish in nibbii-web.", ["Allow always", "Allow once", "No"], "Allow always");
  for (const d of [merge, publish]) {
    const [item] = needsYouQuiet(factsFromParts(parts({ decisions: [d] })), NOW);
    expect(item).toBeDefined();
    for (const action of item!.actions) {
      ipc.calls.length = 0;
      action.run();
      await flush();
      for (const call of ipc.calls.filter((c) => c.cmd === "decisions_answer")) {
        // A button whose words are one of the decision's options sends that option, never another one.
        if (d.options.includes(action.label)) {
          expect(`${d.decisionKey}: ${action.label} -> ${String(call.args.answer)}`).toBe(`${d.decisionKey}: ${action.label} -> ${action.label}`);
        }
      }
    }
  }
});

// HIGH. A chat row's one tap sends the agent's pick, but the row never shows it: "Answer" sends "Go with your pick:
// Raise it to $9.", a ready-to-merge chat's "Allow once" sends "Approved, this once: Rebase it onto main first and wait a
// day.", a red-line chat's "Allow once" approves "Delete them now.", and a card's red-line row's "Approve once" does too.
it("a chat row's one tap sends only an answer the row shows", async () => {
  const card = [
    "Needs Ash: Which font should the landing page use?",
    "My pick: Inter.",
    "",
    "Needs Ash (red line): What should happen to the old backups?",
    "My pick: Delete them now.",
  ].join("\n");
  const cases = [
    ["price", "Needs Ash: Which price should the store show next month?\nMy pick: Raise it to $9.", "Which price", "Raise it to $9"],
    ["merge", "Needs Ash: PR #217 is ready to merge. What should I do with it?\nMy pick: Rebase it onto main first and wait a day.", "PR #217", "Rebase it onto main first"],
    ["backups", "Needs Ash (red line): The old backups take 40 GB. What should happen to them?\nMy pick: Delete them now.", "The old backups", "Delete them now"],
    ["card", card, "What should happen to the old backups", "Delete them now"],
  ] as const;
  for (const [id, reply, asks, pick] of cases) {
    fresh();
    noteChats([lead(id, reply)], 1000);
    const item = needsYou(factsFromChats(waitingChats()), NOW).find((row) => row.sentence.startsWith(asks));
    expect(item, id).toBeDefined();
    for (const action of item!.actions) {
      sent.length = 0;
      action.run();
      await flush();
      if (sent.some((text) => text.includes(pick))) expect(`${id}: ${shown(item!)}`).toContain(pick);
    }
  }
});

// MED. Deviation (b): a decision and a chat with the same words in the same project merge even when the chat is not
// the one that asked the decision. The other chat's ask leaves the list and every count; the row answers only the
// decision, so that chat never hears back.
it("a chat's ask stays when a decision from another chat uses the same words", () => {
  const fromA = decision("ship-win", "Ship the Windows build?", ["Yes", "No"], "Yes", "lead-a");
  const fromB = {
    sessionId: "lead-b", cwd: "/Users/ash/Projects/hivra", title: "Hivra builder", askedAt: NOW, source: "marker",
    question: "Ship the Windows build?", pick: "No", redLine: false, more: 0,
    projectId: "hivra", projectName: "Hivra", chatName: "Hivra builder",
  } as WaitingChat;
  const keys = needsYouQuiet(factsFromParts(parts({ decisions: [fromA] }, { chats: [fromB] })), NOW).map((item) => item.key);
  expect(keys).toContain("question:/Users/ash/Projects/hivra:ship-win");
  expect(keys.some((key) => key.includes("lead-b"))).toBe(true);
  // The chat that asked the decision itself is still one item.
  const same = { ...fromB, sessionId: "lead-a" } as WaitingChat;
  expect(needsYouQuiet(factsFromParts(parts({ decisions: [fromA] }, { chats: [same] })), NOW)).toHaveLength(1);
});
