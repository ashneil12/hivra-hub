// Putting an ask under a project from the "You asked" board (askBoard.ts): the store keeps it, another window reads it,
// and it survives a restart. Example data only.
import { describe, expect, it } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { createAskStore } from "./askStore";

const T0 = 1_800_000_000_000;

async function heardOne() {
  const disk = memoryDisk();
  const store = createAskStore(disk, () => T0);
  await store.load();
  await store.hear({
    mateId: "chief-of-staff",
    sessionId: "chief-chat",
    blockId: "blk-a",
    list: { asks: [{ quote: "Example: find out why the sign-in emails land in spam", summary: "Sign-in emails land in spam", kind: "do" }], maybes: [] },
    by: "model",
    now: T0,
  });
  return { disk, store, id: store.doc().asks[0].id };
}

describe("placing an ask in a project", () => {
  it("is kept, told to whoever watches, and read back after a restart", async () => {
    const { disk, store, id } = await heardOne();
    let told = 0;
    const off = store.subscribe(() => {
      told += 1;
    });
    await store.place(id, "safetube");
    off();
    expect(store.doc().asks[0].project).toBe("safetube");
    expect(told).toBeGreaterThan(0);
    const next = createAskStore(disk, () => T0 + 1000);
    await next.load();
    expect(next.doc().asks[0].project).toBe("safetube");
  });

  it("is taken back with null, and an ask it does not hold changes nothing", async () => {
    const { store, id } = await heardOne();
    await store.place(id, "safetube");
    const revision = store.doc().revision;
    await store.place("no-such-ask", "exo");
    expect(store.doc().revision).toBe(revision);
    await store.place(id, null);
    expect(store.doc().asks[0].project).toBeUndefined();
  });
});
