// @vitest-environment happy-dom
// Port map idea 1: the card folds only past UniiChat's TALL threshold, with "Show all" then "Fold"; a hairline frame.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TeamReportCard } from "./TeamReportCard";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  el = document.createElement("div");
  root = createRoot(el);
});
afterEach(() => act(() => root.unmount()));

const render = (text: string) =>
  act(() => root.render(createElement(TeamReportCard, { report: { team: "EXO coding team", text, status: "completed" } })));

it("a short report shows whole, framed, the team's name on the frame's edge, no Show all", () => {
  render("Fixed the save bug.\nTests pass.");
  const card = el.querySelector("fieldset[data-team-report]")!;
  expect(card.querySelector("legend")!.textContent).toBe("EXO coding team");
  expect(card.className).toContain("border-content/12");
  expect(card.className).not.toMatch(/shadow|glow|bg-/);
  expect(el.querySelector("[data-team-report-body]")!.textContent).toBe("Fixed the save bug.\nTests pass.");
  expect(el.querySelector("[data-team-report-body]")!.className).toContain("whitespace-pre-wrap");
  expect(el.querySelector("[data-team-report-more]")).toBeNull();
});

it("a report that says it is done carries what that claim is worth", () => {
  render("Fixed the save bug.\nTests pass.");
  const claim = el.querySelector("[data-team-report-claim]")!;
  expect(claim.getAttribute("data-team-report-claim")).toBe("likely");
  // The card has the team's words, not its transcript, so no report reaches it confirmed.
  expect(claim.getAttribute("data-team-report-confirmed")).toBe("no");
  expect(claim.textContent).toContain("says the checks passed");
  expect(claim.textContent).toContain("the app saw no test or type-check run in this turn");
  expect(claim.textContent).toContain("Not yet confirmed.");
});

it("a done claim with nothing behind it reads as not proven", () => {
  render("Done: the export rework is in.");
  const claim = el.querySelector("[data-team-report-claim]")!;
  expect(claim.getAttribute("data-team-report-claim")).toBe("guess");
  expect(claim.textContent).toContain("Not proven.");
});

it("a report that makes no done claim gets no footer", () => {
  render("I read the export path and left it as it was; the question is whether to keep the old format.");
  expect(el.querySelector("[data-team-report-claim]")).toBeNull();
});

it("a tall report shows its head (20em) with Show all, then Fold", () => {
  render("a".repeat(3921));
  const body = el.querySelector("[data-team-report-body]")!;
  expect(body.hasAttribute("data-folded")).toBe(true);
  expect(body.className).toContain("max-h-[20em]");
  // A soft fade above Show all, made with a mask so nothing is painted on the glass.
  expect(body.className).toContain("[mask-image:linear-gradient(to_bottom,black_calc(100%-3em),transparent)]");
  const more = el.querySelector<HTMLButtonElement>("[data-team-report-more]")!;
  expect(more.textContent).toBe("Show all");
  act(() => more.click());
  expect(body.hasAttribute("data-folded")).toBe(false);
  expect(more.textContent).toBe("Fold");
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(body.className).not.toContain("mask-image");
});

it("exactly at the threshold it does not fold", () => {
  render("a".repeat(3920));
  expect(el.querySelector("[data-team-report-more]")).toBeNull();
});
