// @vitest-environment happy-dom
// C6: the calendar block draws the block's month with react-day-picker, Monday first, marked days tinted with the theme
// accent and carrying their note; a month it can't read falls back to the plain grid.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CalendarBlock, monthOf } from "./CalendarBlock";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("reads 'October 2026' and nothing vaguer", () => {
  expect(monthOf("October 2026")).toEqual(new Date(2026, 9, 1));
  expect(monthOf("Sprint 4")).toBeUndefined();
});

it("draws the month Monday first with the marked days tinted and titled", () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  act(() => root.render(createElement(CalendarBlock, { month: new Date(2026, 9, 1), marked: [{ day: 16, text: "Playtest" }] })));
  expect([...el.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
  const days = [...el.querySelectorAll("td")].filter((td) => !td.className.includes("invisible") && td.textContent);
  expect(days).toHaveLength(31);
  // 1 October 2026 is a Thursday: the fourth cell of the first week.
  const firstWeek = [...el.querySelectorAll("tbody tr")][0].querySelectorAll("td");
  expect(firstWeek[3].textContent).toBe("1");
  const playtest = el.querySelector('[title="Playtest"]')!;
  expect(playtest.textContent).toBe("16");
  expect(playtest.closest("td")!.className).toContain("bg-theme-accent/20");
  act(() => root.unmount());
});
