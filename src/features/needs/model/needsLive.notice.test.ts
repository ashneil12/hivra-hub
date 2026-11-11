// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import {
  noteChats,
  resetWaitingChats,
  setWaitingChatsHost,
  setWorkerQuestionRouter,
  waitingChats,
  type WaitingChat,
} from "../../hub/model/waitingChats";
import { factsFromParts, resetNeedsLiveForTest, type NeedsParts } from "./needsLive";
import { needsYou } from "./needsYou";
import { noteOneTapRefusal, oneTapRefusal, resetOneTapRefusal } from "./oneTapNotice";

const NOW = 1_700_000_000_000;
const GONE = "That isn't waiting any more.";
const CHANGED = "That changed while you were looking.";
const SECRET = "Only the person can approve a secret run. Ask them on their card.";

function decision(question: string): Decision {
  return {
    project: "/work/hivra", decisionKey: "font", question, options: ["Yes", "No"], recommended: "Yes",
    askedBy: "lead", askedByMono: null, waiting: [], state: "open", answer: null,
    answeredBy: null, answeredAt: null, createdAt: NOW, updatedAt: NOW, version: 1,
  };
}

function parts(extra: Partial<NeedsParts> = {}): NeedsParts {
  return {
    remote: { decisions: [], cards: [], watches: [] },
    rows: [],
    projects: [{ id: "hivra", name: "Hivra", folder: "/work/hivra" }],
    chats: [],
    pages: [],
    delegations: [],
    tasks: [],
    ...extra,
  };
}

function tap(question = "Which font should the landing page use?") {
  const [item] = needsYou(factsFromParts(parts({
    remote: { decisions: [decision(question)], cards: [], watches: [] },
  })), NOW);
  const button = item?.actions.find((action) => action.label === "Yes");
  expect(button, "the row should offer the recommended option").toBeTruthy();
  return button!;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  resetNeedsLiveForTest();
  setWorkerQuestionRouter(undefined);
});

afterEach(() => {
  resetOneTapRefusal();
  resetNeedsLiveForTest();
  resetWaitingChats();
  vi.restoreAllMocks();
});

it("shows why a decision tap was refused, not that it changed", async () => {
  const answer = vi.spyOn(tauriFirstMate, "answer");
  answer.mockResolvedValueOnce({ applied: false, decision: null, released: [], releasedTasks: [] });
  tap().run();
  await flush();
  expect(oneTapRefusal()).toBe(GONE);

  answer.mockRejectedValueOnce(SECRET);
  tap().run();
  await flush();
  expect(oneTapRefusal()).toBe(SECRET);

  answer.mockResolvedValueOnce({
    applied: false,
    decision: { ...decision("Which font should the landing page use?"), state: "answered" },
    released: [],
    releasedTasks: [],
  });
  tap().run();
  await flush();
  expect(oneTapRefusal()).toBe(CHANGED);
});

it("shows why a chat tap was refused, not that it changed", async () => {
  const chat = {
    sessionId: "font",
    cwd: "/work/hivra",
    title: "Hivra lead",
    askedAt: NOW,
    source: "marker",
    question: "Which font should the landing page use?",
    pick: "Inter",
    redLine: false,
    more: 0,
    projectId: "hivra",
    projectName: "Hivra",
    chatName: "Hivra lead",
  } as WaitingChat;
  const [item] = needsYou(factsFromParts(parts({ chats: [chat] })), NOW);
  const button = item?.actions.find((action) => action.label === "Inter");
  expect(button).toBeTruthy();
  button!.run();
  await flush();
  expect(oneTapRefusal()).toBe("That chat isn't waiting any more.");
});

it("clears the notice when the next tap goes through", async () => {
  vi.spyOn(tauriFirstMate, "answer").mockResolvedValue({ applied: true, decision: null, released: [], releasedTasks: [] });
  noteOneTapRefusal("That chat isn't waiting any more.");
  expect(oneTapRefusal()).toBeTruthy();
  tap().run();
  await flush();
  expect(oneTapRefusal()).toBeUndefined();
});

it("a late refusal does not replace a newer tap that went through", async () => {
  let finishFirst: (out: { applied: boolean; decision: null; released: []; releasedTasks: [] }) => void = () => undefined;
  const first = new Promise<{ applied: boolean; decision: null; released: []; releasedTasks: [] }>((resolve) => {
    finishFirst = resolve;
  });
  let calls = 0;
  vi.spyOn(tauriFirstMate, "answer").mockImplementation(() => {
    calls += 1;
    if (calls === 1) return first;
    return Promise.resolve({ applied: true, decision: null, released: [], releasedTasks: [] });
  });
  const button = tap();
  button.run();
  button.run();
  await flush();
  expect(oneTapRefusal()).toBeUndefined();
  finishFirst({ applied: false, decision: null, released: [], releasedTasks: [] });
  await flush();
  expect(oneTapRefusal()).toBeUndefined();
});

it("clears the notice when a chat tap goes through", async () => {
  setWaitingChatsHost({
    liveQuestion: () => undefined,
    respond: () => undefined,
    send: async () => true,
    open: () => undefined,
  });
  noteChats([{
    id: "price",
    cwd: "/work/hivra",
    title: "Hivra lead",
    harness: "claude",
    busy: false,
    queuedMessages: [],
    blocks: [
      { role: "user", text: "go", startedAt: 1 },
      { role: "assistant", text: "Needs Ash: Which price should the store show?\nMy pick: Raise it to $9." },
    ],
  }], 1000);
  const chats = waitingChats();
  const [item] = needsYou(factsFromParts(parts({ chats })), NOW);
  const button = item?.actions.find((action) => action.label === "Raise it to $9.");
  expect(button, chats.map((chat) => chat.pick).join(",")).toBeTruthy();
  noteOneTapRefusal("That chat isn't waiting any more.");
  button!.run();
  await flush();
  expect(oneTapRefusal()).toBeUndefined();
});
