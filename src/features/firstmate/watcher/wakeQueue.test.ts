// Hivra WP-11: the app's side of the wake queue. One drained turn per owner, acknowledged when it goes out, the rest
// next; and queue survival across a simulated restart (a new window on the same store, its queue lost or kept).
import { describe, expect, it } from "vitest";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import type { Wake } from "./classifier";
import { WakeQueue, type Drained, type QueuedWake, type WakeQueueBackend } from "./wakeQueue";

/** watcher/queue.rs in memory, same rules: one wake per owner and key, the delivery ladder, drain and ack by seq. */
class MemoryQueue implements WakeQueueBackend {
  rows: QueuedWake[] = [];
  transcript = new Map<string, string[]>();
  async add(input: Parameters<WakeQueueBackend["add"]>[0]) {
    const found = this.rows.find((w) => w.ownerSession === input.ownerSession && w.key === input.key);
    if (found) return { wake: found, fresh: false };
    const seq = Math.max(0, ...this.rows.filter((w) => w.ownerSession === input.ownerSession).map((w) => w.seq)) + 1;
    const wake: QueuedWake = {
      id: `wake-${this.rows.length + 1}`,
      ownerSession: input.ownerSession,
      seq,
      kind: input.kind,
      key: input.key,
      delegationId: input.delegationId ?? null,
      generation: input.generation ?? null,
      title: input.title ?? null,
      text: input.text,
      delivery: "pending",
      deliveryMessage: null,
      createdAt: 0,
      updatedAt: 0,
    };
    this.rows.push(wake);
    return { wake, fresh: true };
  }
  async open() {
    return this.rows.filter((w) => w.delivery === "pending" || w.delivery === "queued");
  }
  async drain(owner: string): Promise<Drained | null> {
    const owed = this.rows.filter((w) => w.ownerSession === owner && (w.delivery === "pending" || w.delivery === "queued")).sort((a, b) => a.seq - b.seq);
    if (!owed.length) return null;
    const through = owed[owed.length - 1].seq;
    const messageId = `fm-wake-${owner}-${through}`;
    for (const w of owed) Object.assign(w, { delivery: "queued", deliveryMessage: messageId });
    return { ownerSession: owner, messageId, through, text: owed.map((w) => w.text).join("\n"), wakes: owed };
  }
  async delivered(messageId: string) {
    const [, owner, through] = /^fm-wake-(.+)-(\d+)$/.exec(messageId) ?? [];
    const moved = this.rows.filter((w) => w.ownerSession === owner && w.seq <= Number(through) && (w.delivery === "queued" || w.delivery === "delivered"));
    for (const w of moved) w.delivery = "acknowledged";
    return moved;
  }
  async setDelivery(messageId: string, delivery: "disposed") {
    const moved = this.rows.filter((w) => w.deliveryMessage === messageId && w.delivery !== "disposed" && w.delivery !== "acknowledged");
    for (const w of moved) w.delivery = delivery;
    return moved;
  }
  async disposeOwner(owner: string) {
    const moved = this.rows.filter((w) => w.ownerSession === owner && w.delivery !== "acknowledged" && w.delivery !== "disposed");
    for (const w of moved) w.delivery = "disposed";
    return moved.length;
  }
  async seen(owner: string, ids: string[]) {
    return ids.filter((id) => this.transcript.get(owner)?.includes(id));
  }
  async tick() {
    return { fired: [], pruned: 0 };
  }
  async timerSet(): Promise<never> {
    throw new Error("not here");
  }
  async timerCancel() {
    return null;
  }
  async timers() {
    return [];
  }
  async checkSet(): Promise<never> {
    throw new Error("not here");
  }
  async checkCancel() {
    return null;
  }
}

const stall = (key: string, owner = "lead"): Wake => ({ kind: "stall", route: "queue", ownerSession: owner, key, text: `quiet (${key})` });

function setup(store = new MemoryQueue(), firstMates = new Set(["lead"])) {
  const chats = new Map<string, Session>([["lead", { id: "lead", queuedMessages: [] } as unknown as Session]]);
  const queued: { owner: string; message: QueuedMessage }[] = [];
  const queue = new WakeQueue(store, {
    isFirstMate: (id) => firstMates.has(id),
    load: async (id) => chats.get(id) ?? null,
    queueWake: async (owner, message) => {
      queued.push({ owner, message });
      const chat = chats.get(owner)!;
      chat.queuedMessages = [...(chat.queuedMessages ?? []), message];
    },
  });
  /** The first mate's next turn takes the head of its queue. */
  const dispatch = async (owner = "lead") => {
    const chat = chats.get(owner)!;
    const [head, ...rest] = chat.queuedMessages ?? [];
    chat.queuedMessages = rest;
    store.transcript.set(owner, [...(store.transcript.get(owner) ?? []), head.id]);
    await queue.delivered(head.id);
    return head;
  };
  return { store, chats, queued, queue, dispatch };
}

describe("WakeQueue", () => {
  it("adds only queue wakes for a first mate, once per key", async () => {
    const { queue, store } = setup();
    expect(await queue.add(stall("a"))).toBe(true);
    expect(await queue.add(stall("a"))).toBe(false);
    expect(await queue.add({ ...stall("b"), route: "report" })).toBe(false);
    expect(await queue.add(stall("c", "plain-chat"))).toBe(false);
    expect(store.rows).toHaveLength(1);
  });

  it("drains what an owner is owed into one hidden app turn, acknowledged when it goes out; later ones go next", async () => {
    const { queue, store, queued, dispatch } = setup();
    await queue.add(stall("a"));
    await queue.add(stall("b"));
    expect(await queue.deliver()).toMatchObject({ queued: 1 });
    expect(queued).toHaveLength(1);
    expect(queued[0].message).toMatchObject({ id: "fm-wake-lead-2", monoSessionCompletion: { title: "Watcher" } });
    // A wake while that turn waits doesn't double it: it waits for the next turn.
    await queue.add(stall("c"));
    await queue.deliver();
    expect(queued).toHaveLength(1);
    await dispatch();
    // delivered() acknowledges through 2, then drains the rest.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.rows.map((w) => w.delivery)).toEqual(["acknowledged", "acknowledged", "queued"]);
    expect(queued.map((q) => q.message.id)).toEqual(["fm-wake-lead-2", "fm-wake-lead-3"]);
  });

  it("survives a restart: a turn lost with the window is drained again once; one already read is acknowledged", async () => {
    const store = new MemoryQueue();
    const before = setup(store);
    await before.queue.add(stall("a"));
    await before.queue.deliver();
    // The app dies before the owner's queue was saved: the new window's chat has an empty queue.
    const after = setup(store);
    await after.queue.add(stall("a")); // the watcher says it again after the restart: still one wake
    await after.queue.deliver();
    expect(after.queued.map((q) => q.message.id)).toEqual(["fm-wake-lead-1"]);
    await after.queue.deliver();
    expect(after.queued).toHaveLength(1);
    // This time the turn went out, and the app died before the acknowledgement.
    await after.queue.add(stall("b"));
    const third = setup(store);
    await third.queue.deliver();
    const read = setup(store);
    const sent = third.queued[0].message.id;
    store.transcript.set("lead", [sent]);
    await read.queue.deliver();
    expect(store.rows.every((w) => w.delivery === "acknowledged")).toBe(true);
    expect(read.queued).toHaveLength(0);
  });

  it("waits for a busy first mate, so the turn says only what is still true when it can take it", async () => {
    const { queue, queued, chats } = setup();
    await queue.add(stall("a"));
    chats.get("lead")!.busy = true;
    await queue.deliver();
    expect(queued).toHaveLength(0);
    chats.get("lead")!.busy = false;
    await queue.deliver();
    expect(queued).toHaveLength(1);
  });

  it("an owner whose chat is gone owes nothing; one removed from the queue is disposed", async () => {
    const { queue, store, chats } = setup();
    await queue.add(stall("a"));
    chats.delete("lead");
    expect(await queue.deliver()).toMatchObject({ dropped: 1 });
    expect(store.rows[0].delivery).toBe("disposed");
    const second = setup();
    await second.queue.add(stall("x"));
    await second.queue.deliver();
    second.queue.discarded("fm-wake-lead-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.store.rows[0].delivery).toBe("disposed");
  });
});
