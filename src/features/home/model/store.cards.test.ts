// G5: the order Home's cards were dragged into is part of Home's saved arrangement (the local hub store's `home`
// document), so a reload, another window and a restore agree. The order one window kept before is read once.
import { expect, it } from "vitest";
import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { parseArrangement, withCardOrder } from "./arrangement";
import { HOME_DOC_KEY, OLD_CARD_ORDER_KEY, adoptOldCardOrder, changeHome, readHome, type HomeStorage } from "./store";

function storage(seed: Record<string, string> = {}): HomeStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
}

it("a reload keeps the order the cards were dragged into", async () => {
  const disk = memoryDisk();
  const written = await changeHome(disk, storage(), (doc) => ({ ...doc, arrangement: withCardOrder(doc.arrangement, ["automations", "recent", "needs-you"]) }), () => 5);
  expect(written).not.toBeNull();
  const reloaded = await readHome(disk, storage());
  expect(reloaded.doc.arrangement.cards).toEqual(["automations", "recent", "needs-you"]);
  // Only the order changed: that is still a change worth writing.
  const again = await changeHome(disk, storage(), (doc) => ({ ...doc, arrangement: withCardOrder(doc.arrangement, ["recent"]) }), () => 6);
  expect(again!.rev).toBeGreaterThan(written!.rev);
  expect((await readHome(disk, storage())).doc.arrangement.cards).toEqual(["recent"]);
});

it("a saved order is untrusted: bad, duplicate and path-like keys go", () => {
  expect(parseArrangement({ cards: ["recent", "recent", " needs-you ", "../x", 3, "", "panel:p:board"] }).cards).toEqual([
    "recent",
    "needs-you",
    "panel:p:board",
  ]);
  expect(parseArrangement({}).cards).toBeUndefined();
});

it("reads the order this window kept before once, then lets it go", async () => {
  const disk = memoryDisk();
  const box = storage({ [OLD_CARD_ORDER_KEY]: JSON.stringify(["recent", "needs-you"]) });
  expect(await adoptOldCardOrder(disk, box, () => 9)).toBe(true);
  expect(box.values.has(OLD_CARD_ORDER_KEY)).toBe(false);
  expect((await readHome(disk, storage())).doc.arrangement.cards).toEqual(["recent", "needs-you"]);
  const rev = (await disk.readDoc(HOME_DOC_KEY)).rev;
  expect(await adoptOldCardOrder(disk, box)).toBe(false);
  expect((await disk.readDoc(HOME_DOC_KEY)).rev).toBe(rev);
});

it("an order already saved wins over the old one, which is still let go", async () => {
  const disk = memoryDisk();
  await changeHome(disk, storage(), (doc) => ({ ...doc, arrangement: withCardOrder(doc.arrangement, ["automations"]) }));
  const box = storage({ [OLD_CARD_ORDER_KEY]: JSON.stringify(["recent"]) });
  await adoptOldCardOrder(disk, box);
  expect((await readHome(disk, storage())).doc.arrangement.cards).toEqual(["automations"]);
  expect(box.values.has(OLD_CARD_ORDER_KEY)).toBe(false);
});

it("a store that does not answer keeps the old order for the next try", async () => {
  const down: LocalHubDisk = {
    read: async () => {
      throw new Error("timeout");
    },
    readDoc: async () => {
      throw new Error("timeout");
    },
    write: async () => {
      throw new Error("timeout");
    },
  };
  const box = storage({ [OLD_CARD_ORDER_KEY]: JSON.stringify(["recent"]) });
  expect(await adoptOldCardOrder(down, box)).toBe(false);
  expect(box.values.get(OLD_CARD_ORDER_KEY)).toBe(JSON.stringify(["recent"]));
});
