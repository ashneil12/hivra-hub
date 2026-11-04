// @vitest-environment happy-dom
// G1: a project template shapes that project's cards. They become sections, in the template's order, each drawn from
// real data (the app's own since/needs, the project's builds, the pages kept for it). WP-06: Being built is not one.
import { beforeEach, expect, it } from "vitest";
import { sectionsForCards, setTemplate, templateOf } from "./templates";

beforeEach(() => localStorage.clear());

it("turns a template's cards into sections, in order", () => {
  const game = sectionsForCards(templateOf("vg-game").todayCards);
  expect(game.map((s) => s.kind)).toEqual(["since", "needs", "latest-build"]);
  expect(game.map((s) => s.title)).toEqual(["Since you were last here", "Needs you", "Latest build to try"]);

  const product = sectionsForCards(templateOf("hivra").todayCards);
  expect(product.map((s) => s.kind)).toEqual(["since", "needs", "latest-page"]);

  // Org / ops adds nothing beyond the app's own two cards.
  expect(sectionsForCards(templateOf("hub").todayCards).map((s) => s.kind)).toEqual(["since", "needs"]);
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
  expect(sectionsForCards(templateOf("nibbii").todayCards).map((s) => s.kind)).toEqual(["since", "needs", "latest-page"]);
  setTemplate("nibbii", "game-studio");
  expect(sectionsForCards(templateOf("nibbii").todayCards).map((s) => s.kind)).toEqual(["since", "needs", "latest-build"]);
});
