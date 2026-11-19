import { describe, expect, it } from "vitest";
import {
  DIFF_PRESENTATION_KEY,
  parseDiffPresentation,
  readDiffPresentation,
  writeDiffPresentation,
  type DiffPresentation,
} from "./diffPresentation";

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  const writes: string[] = [];
  const storage = {
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
      writes.push(`${key}=${value}`);
    },
  };
  return { storage, data, writes };
}

describe("parseDiffPresentation", () => {
  it("accepts only the two names", () => {
    expect(parseDiffPresentation("unified")).toBe("unified");
    expect(parseDiffPresentation("split")).toBe("split");
    for (const value of ["", "  ", "SPLIT", "split ", "side", null, 1, {}]) {
      expect(parseDiffPresentation(value)).toBe("unified");
    }
  });
});

describe("readDiffPresentation", () => {
  it("is unified when nothing is stored", () => {
    expect(readDiffPresentation(memoryStore().storage)).toBe("unified");
  });

  it("is unified for an empty or unknown stored value", () => {
    expect(readDiffPresentation(memoryStore({ [DIFF_PRESENTATION_KEY]: "" }).storage)).toBe(
      "unified",
    );
    expect(
      readDiffPresentation(memoryStore({ [DIFF_PRESENTATION_KEY]: "tree" }).storage),
    ).toBe("unified");
  });

  it("reads a stored split choice", () => {
    expect(
      readDiffPresentation(memoryStore({ [DIFF_PRESENTATION_KEY]: "split" }).storage),
    ).toBe("split");
  });

  it("is unified when the store throws", () => {
    const storage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(readDiffPresentation(storage)).toBe("unified");
  });
});

describe("writeDiffPresentation", () => {
  it("stores split and unified", () => {
    const { storage, data } = memoryStore();
    writeDiffPresentation("split", storage);
    expect(data[DIFF_PRESENTATION_KEY]).toBe("split");
    expect(readDiffPresentation(storage)).toBe("split");
    writeDiffPresentation("unified", storage);
    expect(data[DIFF_PRESENTATION_KEY]).toBe("unified");
  });

  it("does not write the same value again", () => {
    const { storage, writes } = memoryStore({ [DIFF_PRESENTATION_KEY]: "split" });
    writeDiffPresentation("split", storage);
    expect(writes).toEqual([]);
  });

  it("treats an unknown value as unified", () => {
    const { storage, data } = memoryStore();
    writeDiffPresentation("nope" as DiffPresentation, storage);
    expect(data[DIFF_PRESENTATION_KEY]).toBe("unified");
  });

  it("does not throw when the store rejects the write", () => {
    const storage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("full");
      },
    };
    expect(() => writeDiffPresentation("split", storage)).not.toThrow();
  });
});
