import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("names the two inverted round 1 cases as limits", () => {
  const src = readFileSync(new URL("./needsLive.r243.test.ts", import.meta.url), "utf8");
  const names = [...src.matchAll(/\bit\("([^"]*)"/g)].map((match) => match[1]);
  expect(names.filter((name) => name.toLowerCase().includes("limit"))).toEqual([
    "limit: an answered check leaves the list, and opening the card does not answer the gate",
    "limit: an empty parts list does not include the task the opening count reads",
  ]);
});
