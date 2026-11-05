import { afterEach, expect, test } from "vitest";
import { readIds, toggledIds, writeIds } from "./useCollapsedGroups";

type Store = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };

function install(store: Store): void {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: store },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("a missing, broken or non-array value reads as no collapsed groups", () => {
  install({
    getItem: (key) => (key === "bad" ? "{" : key === "num" ? "3" : key === "obj" ? "{}" : null),
    setItem: () => {},
  });
  expect(readIds("missing")).toEqual([]);
  expect(readIds("bad")).toEqual([]);
  expect(readIds("num")).toEqual([]);
  expect(readIds("obj")).toEqual([]);
});

test("only strings are kept, and a throw while reading is empty", () => {
  install({
    getItem: (key) => (key === "mixed" ? JSON.stringify(["a", 1, null, "b"]) : ""),
    setItem: () => {
      throw new Error("blocked");
    },
  });
  expect(readIds("mixed")).toEqual(["a", "b"]);
  install({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {},
  });
  expect(readIds("denied")).toEqual([]);
});

test("toggling adds an id and removes it again, including a duplicate", () => {
  expect(toggledIds([], "status")).toEqual(["status"]);
  expect(toggledIds(["status"], "status")).toEqual([]);
  expect(toggledIds(["a", "a"], "a")).toEqual([]);
  expect(toggledIds(["a"], "")).toEqual(["a", ""]);
});

test("a blocked write still returns, and a good write stores the ids", () => {
  const saved: Record<string, string> = {};
  install({
    getItem: (key) => saved[key] ?? null,
    setItem: (key, value) => {
      saved[key] = value;
    },
  });
  writeIds("groups", ["status", "café"]);
  expect(saved.groups).toBe(JSON.stringify(["status", "café"]));
  install({
    getItem: () => null,
    setItem: () => {
      throw new Error("full");
    },
  });
  expect(() => writeIds("groups", ["status"])).not.toThrow();
});
