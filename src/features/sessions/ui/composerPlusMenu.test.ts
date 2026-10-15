import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const src = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
const menu = src.slice(src.indexOf("data-composer-plus"), src.indexOf("</Popover>", src.indexOf("data-composer-plus")));

it("the + menu lists Upload file, Plan mode, Operator, Orchestrator and Draft, each a name and one grey line", () => {
  for (const name of ["Upload file", "Plan mode", "Operator", "Orchestrator", "Draft"]) expect(menu).toContain(`>${name}<`);
  expect(menu.match(/text-\[11px\] leading-4 text-content\/45/g)?.length).toBe(5);
});

it("the + menu icons are grey: no hue classes", () => {
  expect(menu).not.toMatch(/text-(yellow|sky|fuchsia|accent)|bg-fuchsia/);
});
