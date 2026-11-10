import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const src = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
const menu = src.slice(src.indexOf("data-composer-plus"), src.indexOf("</Popover>", src.indexOf("data-composer-plus")));

it("the + menu lists Upload file, Plan mode, Operator, Orchestrator and Draft, each a name and one grey line", () => {
  for (const name of ["Upload file", "Plan mode", "Operator", "Orchestrator", "Draft"]) expect(menu).toContain(`>${name}<`);
  expect(menu.match(/text-\[11px\] leading-4 text-content\/45/g)?.length).toBe(6);
});

it("the + menu icons are grey: no hue classes", () => {
  expect(menu).not.toMatch(/text-(yellow|sky|fuchsia|accent)|bg-fuchsia/);
});

it("Screenshot is disabled and labelled Not connected yet, and Dictate is a real control", () => {
  expect(menu).toContain(">Screenshot<");
  expect(menu).not.toContain(">Voice<");
  expect(menu).toContain("<DictationMenuRow");
  expect(menu.match(/data-composer-plus-unwired/g)?.length).toBe(1);
  expect(menu.match(/Not connected yet/g)?.length).toBe(1);
  expect(src).toContain("dictation.seal()");
  expect(src).toContain("dictation.onTyped(el.value)");
});
