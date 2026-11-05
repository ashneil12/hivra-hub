import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { HOME_CARD_LIMIT, HOME_ENTER_EASE, HOME_ENTER_MS, HOME_ENTER_RISE_PX, HOME_MAX_WIDTH, HOME_STAGGER_MS } from "./homeLayout";

it("copies Orbit's home column, card limit and view-bar-enter timing", () => {
  expect(HOME_MAX_WIDTH).toBe(960);
  expect(HOME_CARD_LIMIT).toBe(7);
  expect(HOME_ENTER_MS).toBe(180);
  expect(HOME_ENTER_EASE).toBe("cubic-bezier(0.23, 1, 0.32, 1)");
  expect(HOME_ENTER_RISE_PX).toBe(4);
  expect(HOME_STAGGER_MS).toBe(40);
  const css = readFileSync(new URL("../ui/home.css", import.meta.url), "utf8");
  expect(css).toContain(`${HOME_ENTER_MS}ms`);
  expect(css).toContain(HOME_ENTER_EASE);
  expect(css).toContain(`translateY(${HOME_ENTER_RISE_PX}px)`);
  expect(css).toContain("prefers-reduced-motion");
});
