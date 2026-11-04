// @vitest-environment happy-dom
// One "Needs you" card (Critiquito, 22 Oct). "Stuck: needs you" and "Needs (up to 5)" were the same list (Today's Needs
// you section: stuck rows first, then Needs, proposals, failed builds and stuck workers), so they are one card, named
// with no number limit. A dashboard or a Today board saved with the old cards still loads, with Needs you shown once.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubData, setHubDataSource } from "./hubData";
import { mapToday } from "./hubStore";
import { currentTodayCards, setTemplate, TEMPLATES } from "./templates";
import type { HubProject } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const OLD_BOARD = [
  { id: "since", kind: "since", title: "Since you were away" },
  { id: "stuck", kind: "stuck", title: "Stuck: needs you" },
  { id: "needs", kind: "needs", title: "Needs (up to 5)" },
  { id: "being-built", kind: "being-built", title: "Being built" },
];

describe("the cards", () => {
  it("every template has one Needs you card, no old stuck card and no number limit", () => {
    for (const t of TEMPLATES) {
      expect(t.todayCards.filter((c) => c === "Needs you"), t.id).toHaveLength(1);
      for (const c of t.todayCards) {
        expect(c, t.id).not.toMatch(/\(up to \d+\)|\bup to \d+\b/);
        expect(c, t.id).not.toMatch(/^Stuck/);
      }
      expect(new Set(t.todayCards).size, t.id).toBe(t.todayCards.length);
    }
  });

  it("an old dashboard's cards map to the new card, once", () => {
    expect(currentTodayCards(["Since you were last here", "Stuck: needs you", "Needs (up to 5)", "Latest build to try"]))
      .toEqual(["Since you were last here", "Needs you", "Latest build to try"]);
    expect(currentTodayCards(["Since you were last here", "Stuck: needs you", "Decisions (up to 5)"]))
      .toEqual(["Since you were last here", "Needs you"]);
    expect(currentTodayCards(["Example: Sign-ups this week"])).toEqual(["Example: Sign-ups this week"]);
  });
});

describe("a saved Today board", () => {
  it("with the old stuck and capped cards loads as one Needs you section, where the first of them was", () => {
    expect(mapToday(OLD_BOARD)).toEqual([
      { id: "since", kind: "since", title: "Since you were away" },
      { id: "stuck", kind: "needs", title: "Needs you" },
      { id: "being-built", kind: "being-built", title: "Being built" },
    ]);
  });
  it("a current board is untouched, including a title Ash chose for Needs you", () => {
    const now = [{ id: "needs", kind: "needs", title: "Example: For me" }, { id: "since", kind: "since", title: "Since you were away" }];
    expect(mapToday(now)).toEqual(now);
  });
});

describe("on screen", () => {
  let root: Root | undefined;
  const PROJECT: HubProject = { id: "example-game", name: "Example: Game", shortName: "Game", iconShape: "gamepad", folder: null };
  beforeEach(() => {
    localStorage.clear();
    setHubDataSource(undefined);
    const src = Object.create(hubData());
    src.listProjects = () => [PROJECT];
    setHubDataSource(src);
  });
  afterEach(() => act(() => root?.unmount()));
  afterAll(() => setHubDataSource(undefined));
  const mount = async (el: ReturnType<typeof createElement>) => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(el));
    return host;
  };

  it("Settings → Dashboards lists Needs you once and no number limit", async () => {
    setTemplate(PROJECT.id, "game-studio");
    const { DashboardsPage } = await import("../ui/DashboardsPage");
    const host = await mount(createElement(DashboardsPage));
    const line = host.querySelector(`[data-hub-dashboard="${PROJECT.id}"]`)!.textContent!;
    expect(line).toContain("Today: Since you were last here, Needs you, Latest build to try");
    expect(line).not.toMatch(/up to 5|Stuck: needs you/);
  });
});
