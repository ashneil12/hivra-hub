// @vitest-environment happy-dom
// G1: a project template shapes that project's live Today. Its cards become Today sections, in the template's order,
// each drawn from real data (the app's own since/needs, the project's builds, the pages kept for it), and the app's own
// Being built closes the board.
import { beforeEach, expect, it } from "vitest";
import { projectTodaySections, sectionsForCards, setTemplate, templateOf } from "./templates";

beforeEach(() => localStorage.clear());

it("turns a template's cards into Today sections, in order", () => {
  const game = sectionsForCards(templateOf("vg-game").todayCards);
  expect(game.map((s) => s.kind)).toEqual(["since", "needs", "latest-build"]);
  expect(game.map((s) => s.title)).toEqual(["Since you were last here", "Needs you", "Latest build to try"]);

  const product = projectTodaySections("hivra");
  expect(product.map((s) => s.kind)).toEqual(["since", "needs", "latest-page", "being-built"]);

  // Org / ops adds nothing beyond the app's own two cards.
  expect(projectTodaySections("hub").map((s) => s.kind)).toEqual(["since", "needs", "being-built"]);
});

it("maps an old card name and draws a card once", () => {
  const sections = sectionsForCards(["Needs (up to 5)", "Needs you", "Stuck: needs you"]);
  expect(sections.map((s) => s.kind)).toEqual(["needs"]);
});

it("falls back to Today's usual sections when a dashboard names only cards it can't draw", () => {
  const kinds = sectionsForCards(["Sign-ups this week"]).map((s) => s.kind);
  expect(kinds).toEqual(["since", "setup", "needs"]);
});

it("follows the project's template, including a choice Ash changed", () => {
  expect(projectTodaySections("nibbii").map((s) => s.kind)).toEqual(["since", "needs", "latest-page", "being-built"]);
  setTemplate("nibbii", "game-studio");
  expect(projectTodaySections("nibbii").map((s) => s.kind)).toEqual(["since", "needs", "latest-build", "being-built"]);
});
