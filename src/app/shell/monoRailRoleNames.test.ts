import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const src = readFileSync(new URL("./MonoRailSection.tsx", import.meta.url), "utf8");

it("in a narrow sidebar the role name truncates first and the grey own name never does", () => {
  expect(src).toMatch(/className="min-w-0 truncate text-sm font-medium" data-mono-primary-name/);
  expect(src).toMatch(/className="shrink-0 text-xs font-normal text-content\/45" data-mono-own-name/);
});
