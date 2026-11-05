import { expect, test } from "vitest";
import { keyBetween } from "./order";

test("an empty board gets one key, and a key lands after or before a neighbour", () => {
  expect(keyBetween(null, null)).toBe("V");
  expect(keyBetween("", "")).toBe("V");
  const after = keyBetween("00000008", null);
  expect(after && after > "00000008").toBe(true);
  const before = keyBetween(null, "00000001");
  expect(before && before < "00000001").toBe(true);
});

test("a key between two neighbours stays between them, including adjacent numbers", () => {
  const between = keyBetween("00000001", "00000002");
  expect(between && between > "00000001" && between < "00000002").toBe(true);
  const wide = keyBetween("a", "z");
  expect(wide && wide > "a" && wide < "z").toBe(true);
});

test("equal, reversed, or exhausted keys do not invent an order", () => {
  expect(keyBetween("b", "b")).toBeNull();
  expect(keyBetween("b", "a")).toBeNull();
  expect(keyBetween("same", "same")).toBeNull();
});

test("repeated inserts stay sorted, and odd keys do not throw", () => {
  const keys = ["00000001"];
  for (let step = 0; step < 12; step += 1) {
    const next = keyBetween(keys[keys.length - 1] ?? null, null);
    expect(next).not.toBeNull();
    keys.push(next!);
  }
  expect(keys).toEqual([...keys].sort());
  const pair = ["a", "z"];
  for (let step = 0; step < 8; step += 1) {
    const mid = Math.floor(pair.length / 2);
    const next = keyBetween(pair[mid - 1] ?? null, pair[mid] ?? null);
    expect(next).not.toBeNull();
    pair.splice(mid, 0, next!);
  }
  expect(pair).toEqual([...pair].sort());
  expect(() => keyBetween("café", "über")).not.toThrow();
  expect(() => keyBetween("a\r\nb", "z")).not.toThrow();
  const odd = keyBetween("café", "über");
  if (odd) expect(odd > "café" && odd < "über").toBe(true);
  expect(keyBetween("b", "b")).toBeNull();
});
