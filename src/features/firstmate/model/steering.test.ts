import { describe, expect, it, vi } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import type { Block, Session } from "../../sessions/model/session";
import {
  askPerson,
  deliveredText,
  drainPending,
  planDelivery,
  RETRY_AFTER_MS,
  steerRequestId,
  taskMessage,
  type AskInput,
  type Decision,
  type DeliveryDeps,
  type FirstMateBackend,
  type SteerInput,
  type SteerMessage,
  type SteerOutcome,
} from "./steering";
import { decisionNeedId, decisionNeeds, delegationDecisions } from "../../hub/model/localHub/decisions";

/** A fake of src-tauri/src/steering.rs and decisions.rs: same rules for what moves. */
function fakeStore() {
  const messages: SteerMessage[] = [];
  const decisions: Decision[] = [];
  let n = 0;
  const backend: FirstMateBackend = {
    async record(input: SteerInput) {
      const same = messages.find((m) => m.ownerSession === input.ownerSession && m.requestId === input.requestId);
      if (same) return same;
      const m: SteerMessage = {
        id: `s-${++n}`,
        ownerSession: input.ownerSession,
        childSession: input.childSession,
        delegationId: input.delegationId ?? null,
        requestId: input.requestId,
        source: "first-mate",
        decisionKey: null,
        text: input.text,
        mode: input.mode ?? "auto",
        state: "pending",
        delivery: null,
        attempts: 0,
        error: null,
        heldAt: null,
        createdAt: n,
        updatedAt: n,
        deliveredAt: null,
      };
      messages.push(m);
      return m;
    },
    async pending() {
      return messages.filter((m) => m.state === "pending").map((m) => ({ ...m }));
    },
    async list({ childSession }) {
      return messages.filter((m) => !childSession || m.childSession === childSession).map((m) => ({ ...m }));
    },
    async settle(id: string, outcome: SteerOutcome) {
      const m = messages.find((x) => x.id === id);
      if (!m || m.state !== "pending") return { applied: false, message: m ?? null };
      if (outcome.kind === "delivered") Object.assign(m, { state: "delivered", delivery: outcome.delivery });
      else if (outcome.kind === "held") m.heldAt = 1;
      else {
        m.attempts++;
        m.error = outcome.error;
        m.updatedAt = 1_000;
        if (outcome.fatal || m.attempts >= 5) m.state = "failed";
      }
      return { applied: true, message: { ...m } };
    },
    async ask(input: AskInput) {
      const found = decisions.find((d) => d.project === (input.project ?? "") && d.decisionKey === input.key);
      if (found) {
        const added = (input.taskIds ?? []).filter((t) => !found.waiting.includes(t));
        found.waiting.push(...added);
        return { decision: { ...found }, created: false, added, released: [] };
      }
      const d: Decision = {
        project: input.project ?? "",
        decisionKey: input.key,
        question: input.question,
        options: input.options,
        recommended: input.recommended ?? null,
        askedBy: input.askedBy,
        askedByMono: input.askedByMono ?? null,
        waiting: input.taskIds ?? [],
        state: "open",
        answer: null,
        answeredBy: null,
        answeredAt: null,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      };
      decisions.push(d);
      return { decision: { ...d }, created: true, added: d.waiting, released: [] };
    },
    async answer(project, key, answer) {
      const d = decisions.find((x) => x.project === project && x.decisionKey === key);
      if (!d || d.state !== "open") return { applied: false, decision: d ?? null, released: [], releasedTasks: [] };
      Object.assign(d, { state: "answered", answer });
      return { applied: true, decision: { ...d }, released: [], releasedTasks: [...d.waiting] };
    },
    async decisions() {
      return decisions.map((d) => ({ ...d }));
    },
  };
  return { backend, messages, decisions };
}

type FakeChat = Pick<Session, "id" | "busy" | "blocks" | "queuedMessages" | "harness">;

function chats(...list: Array<Partial<FakeChat> & { id: string }>) {
  const map = new Map<string, FakeChat>(
    list.map((c) => [c.id, { busy: false, blocks: [], queuedMessages: [], harness: "claude", ...c } as FakeChat]),
  );
  return map;
}

function delivery(store: ReturnType<typeof fakeStore>, map: Map<string, FakeChat>, canSteer = true) {
  const submitted: Array<{ id: string; text: string; steer: boolean; appRequestId: string }> = [];
  const deps: DeliveryDeps = {
    backend: store.backend,
    chat: async (id) => map.get(id),
    canSteer: () => canSteer,
    submit: async (id, text, options) => {
      submitted.push({ id, text, ...options });
      const chat = map.get(id)!;
      chat.blocks = [...chat.blocks, { role: "user", text, appRequestId: options.appRequestId } as Block];
      if (!options.steer) chat.busy = true;
      return true;
    },
    now: () => 2_000,
  };
  return { deps, submitted };
}

const row = (over: Partial<Delegation> = {}) =>
  ({ id: "t-1", childSession: "w1", ownerSession: "fm", state: "running", ...over }) as Delegation;

describe("planDelivery", () => {
  it("starts an idle chat, steers a busy one that can take it, holds otherwise", () => {
    const chat = { busy: false, canSteer: true, alreadyIn: false };
    expect(planDelivery({ mode: "auto", heldAt: null }, chat)).toEqual({ kind: "start" });
    expect(planDelivery({ mode: "auto", heldAt: null }, { ...chat, busy: true })).toEqual({ kind: "steer" });
    expect(planDelivery({ mode: "queue", heldAt: null }, { ...chat, busy: true })).toEqual({ kind: "hold" });
    expect(planDelivery({ mode: "steer", heldAt: null }, { ...chat, busy: true, canSteer: false })).toEqual({ kind: "hold" });
    expect(planDelivery({ mode: "auto", heldAt: null }, undefined)).toEqual({ kind: "fail", error: "The worker's chat is gone." });
    // Already in its chat (the delivery wasn't recorded before a quit): recorded, never sent twice.
    expect(planDelivery({ mode: "auto", heldAt: null }, { ...chat, alreadyIn: true })).toEqual({ kind: "done", delivery: "started" });
  });
});

describe("steering delivery", () => {
  it("holds a steer to a busy worker whose CLI can't take it, and replays it as its next turn", async () => {
    const store = fakeStore();
    const map = chats({ id: "w1", busy: true });
    const { deps, submitted } = delivery(store, map, false);
    const stored = await store.backend.record({ ownerSession: "fm", childSession: "w1", requestId: "r1", text: "Use the v2 API." });
    expect(store.messages[0].state).toBe("pending");

    await drainPending(deps);
    expect(submitted).toEqual([]);
    expect(store.messages[0]).toMatchObject({ state: "pending", heldAt: 1 });

    // Still busy: nothing new happens.
    await drainPending(deps);
    expect(submitted).toEqual([]);

    // The worker's turn ended: it goes in as a new turn, under its own request id.
    map.get("w1")!.busy = false;
    await drainPending(deps);
    expect(submitted).toEqual([
      { id: "w1", text: deliveredText(stored), steer: false, appRequestId: steerRequestId(stored) },
    ]);
    expect(store.messages[0]).toMatchObject({ state: "delivered", delivery: "started" });
  });

  it("steers into the running turn when the CLI can", async () => {
    const store = fakeStore();
    const map = chats({ id: "w1", busy: true });
    const { deps, submitted } = delivery(store, map, true);
    await store.backend.record({ ownerSession: "fm", childSession: "w1", requestId: "r1", text: "Stop: wrong file." });
    await drainPending(deps);
    expect(submitted[0].steer).toBe(true);
    expect(store.messages[0]).toMatchObject({ state: "delivered", delivery: "steered" });
  });

  it("survives a restart: a message stored before the quit goes in on the next start, once", async () => {
    const store = fakeStore();
    await store.backend.record({ ownerSession: "fm", childSession: "w1", requestId: "r1", text: "Rebase first." });
    // A new window (the app restarted) with the worker idle.
    const map = chats({ id: "w1" });
    const { deps, submitted } = delivery(store, map);
    await drainPending(deps);
    await drainPending(deps);
    expect(submitted).toHaveLength(1);
    expect(store.messages[0].state).toBe("delivered");

    // It went in but the quit came before it was recorded: found in the transcript, recorded, not sent again.
    const lost = await store.backend.record({ ownerSession: "fm", childSession: "w2", requestId: "r2", text: "Also docs." });
    const again = chats({ id: "w2", blocks: [{ role: "user", text: "x", appRequestId: steerRequestId(lost) } as Block] });
    const second = delivery(store, again);
    await drainPending(second.deps);
    expect(second.submitted).toEqual([]);
    expect(store.messages[1].state).toBe("delivered");
  });

  it("keeps a worker's messages in order and fails one whose chat is gone", async () => {
    const store = fakeStore();
    const map = chats({ id: "w1" });
    const { deps, submitted } = delivery(store, map, true);
    await store.backend.record({ ownerSession: "fm", childSession: "w1", requestId: "a", text: "first" });
    await store.backend.record({ ownerSession: "fm", childSession: "w1", requestId: "b", text: "second" });
    await store.backend.record({ ownerSession: "fm", childSession: "gone", requestId: "c", text: "lost" });
    await drainPending(deps);
    // The first started a turn; the second waits for the next pass, then steers into that turn.
    expect(submitted.map((s) => s.text.split("\n").pop())).toEqual(["first"]);
    await drainPending(deps);
    expect(submitted.map((s) => s.text.split("\n").pop())).toEqual(["first", "second"]);
    expect(store.messages[2]).toMatchObject({ state: "failed", error: "The worker's chat is gone." });
  });

  it("waits before retrying a failed try", async () => {
    const store = fakeStore();
    const map = chats({ id: "w1" });
    const { deps } = delivery(store, map);
    deps.submit = async () => false;
    await store.backend.record({ ownerSession: "fm", childSession: "w1", requestId: "a", text: "go" });
    await drainPending(deps);
    expect(store.messages[0].attempts).toBe(1);
    await drainPending(deps);
    expect(store.messages[0].attempts).toBe(1);
    deps.now = () => 1_000 + RETRY_AFTER_MS;
    await drainPending(deps);
    expect(store.messages[0].attempts).toBe(2);
  });
});

describe("task_message", () => {
  it("stores the message before anything delivers it, and says what happened", async () => {
    const store = fakeStore();
    const settled = vi.fn(async (m: SteerMessage) => ({ ...m, heldAt: 5 }));
    const out = await taskMessage({ id: "fm" }, "req-1", { text: "Cover the empty list." }, row(), {
      backend: store.backend,
      settled,
    });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ childSession: "w1", delegationId: "t-1", requestId: "req-1" });
    expect(out).toMatchObject({ taskId: "t-1", state: "pending", held: true });
    expect(String(out.note)).toContain("next turn");
  });

  it("refuses a finished task and a bad whenBusy", async () => {
    const store = fakeStore();
    await expect(taskMessage({ id: "fm" }, "r", { text: "x" }, row({ state: "completed" }), { backend: store.backend })).rejects.toThrow(
      "no longer running",
    );
    await expect(taskMessage({ id: "fm" }, "r", { text: "x", whenBusy: "later" }, row(), { backend: store.backend })).rejects.toThrow(
      "whenBusy",
    );
    expect(store.messages).toEqual([]);
  });
});

describe("ask_person and the decision Needs", () => {
  const input = {
    key: "retention",
    question: "Keep deleted sessions 30 days?",
    options: ["Keep 30 days", "Delete for good"],
    recommended: "Keep 30 days",
  };

  it("asks once per key and shows one Needs row, answered from its sheet", async () => {
    const store = fakeStore();
    const host = { backend: store.backend };
    const first = await askPerson({ id: "fm" }, input, { project: "hivra" }, [row()], host);
    expect(first).toMatchObject({ created: true, state: "open" });
    const second = await askPerson({ id: "fm" }, input, { project: "hivra" }, [row({ id: "t-2" })], host);
    expect(second).toMatchObject({ created: false, waiting: ["t-1", "t-2"] });
    expect(store.decisions).toHaveLength(1);

    const needs = decisionNeeds(await store.backend.decisions());
    expect(needs.projects).toEqual([{ projectId: "hivra", shown: [expect.objectContaining({ actionType: "see_options", title: input.question })] }]);
    const source = delegationDecisions(async () => [], store.backend);
    const id = decisionNeedId({ project: "hivra", decisionKey: "retention" });
    const sheet = (await source.act("question", { id })) as Record<string, unknown>;
    expect(sheet).toMatchObject({ options: [{ label: "Keep 30 days" }, { label: "Delete for good" }], recommendation: { optionIndex: 0 } });
    expect(await source.act("answer", { id, choice: 0 })).toEqual({ receipt: "Sent. 2 waiting tasks carry on.", rowDone: true });
    expect(store.decisions[0]).toMatchObject({ state: "answered", answer: "Keep 30 days" });
    expect((await source.needs()) as { projects: unknown[] }).toEqual({ projects: [], setup: [] });
    await expect(source.act("question", { id: "decision::nope" })).rejects.toThrow("isn't waiting on you");
  });

  it("records an answer the person gave in chat, and an answered key gives the answer back", async () => {
    const store = fakeStore();
    const host = { backend: store.backend };
    await askPerson({ id: "fm" }, input, { project: "hivra" }, [row()], host);
    const told = await askPerson({ id: "fm" }, { ...input, answer: "Keep them 30 days" }, { project: "hivra" }, [], host);
    expect(told).toMatchObject({ state: "answered", released: ["t-1"] });
    const again = await askPerson({ id: "fm" }, input, { project: "hivra" }, [], host);
    expect(again).toMatchObject({ state: "answered", answer: "Keep them 30 days" });
    expect(String(again.note)).toContain("don't ask again");
  });

  it("passes match words through and returns a standing answer as guidance", async () => {
    const store = fakeStore();
    let seen: AskInput | undefined;
    const ask = store.backend.ask.bind(store.backend);
    store.backend.ask = async (input) => {
      seen = input;
      return ask(input);
    };
    const host = { backend: store.backend };
    await askPerson(
      { id: "fm" },
      { ...input, keys: ["Session", 1], force: true, reason: "This one is about staging." },
      { project: "hivra" },
      [],
      host,
    );
    expect(seen).toMatchObject({ keys: ["Session"], force: true, reason: "This one is about staging." });

    store.backend.ask = async () => ({
      decision: {
        project: "hivra",
        decisionKey: "retention",
        question: input.question,
        options: input.options,
        recommended: input.recommended,
        askedBy: "fm",
        askedByMono: null,
        waiting: [],
        state: "answered",
        answer: "Keep 30 days",
        answeredBy: "user",
        answeredAt: 3,
        createdAt: 1,
        updatedAt: 3,
        version: 2,
        standingId: "S-4",
      },
      created: false,
      added: [],
      released: [],
      matched: true,
      standingId: "S-4",
    });
    const matched = await askPerson({ id: "fm" }, input, { project: "hivra" }, [row()], host);
    expect(matched).toMatchObject({ state: "answered", matched: true, standingId: "S-4", answer: "Keep 30 days" });
    expect(String(matched.note)).toContain(
      "A standing answer S-4 to a similar question: guidance, not permission",
    );
    expect(String(matched.note)).not.toMatch(/[—–]/);
    expect(store.decisions).toHaveLength(1);
  });
});
