// @vitest-environment happy-dom
// WP-06: the hub opens a project's coding team, not Today. A stored Today, Being built,
// Decisions or Builds item is not a surface. With no project, the empty state stays.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as { __MONOCODE_HUB_DEV_PAGE__?: boolean }).__MONOCODE_HUB_DEV_PAGE__;
  localStorage.clear();
});

it("a project opens on its coding team, not Today", async () => {
  vi.stubEnv("VITE_MONOCODE_HUB", "1");
  const nav = await import("./hubNav");
  nav.showProjectToday("hivra");
  expect(nav.currentHubSelection()).toEqual({ project: "hivra", item: "coding-team" });
  expect(nav.hubSurfaceOpen(nav.currentHubSelection())).toBe(false);
});

it("a stored Today, Being built, Decisions or Builds item is not a hub surface", async () => {
  const nav = await import("./hubNav");
  for (const item of ["inbox", "being-built", "decisions", "builds"]) {
    expect(nav.retiredHubItem(item)).toBe(true);
    expect(nav.hubSurfaceOpen({ project: "hivra", item })).toBe(false);
  }
  expect(nav.retiredHubItem("")).toBe(false);
  expect(nav.retiredHubItem("coding-team")).toBe(false);
  expect(nav.retiredHubItem("leadership-team")).toBe(false);
  expect(nav.hubSurfaceOpen({ project: "hivra", item: "leadership-team" })).toBe(true);
  expect(nav.hubSurfaceOpen({ project: "hivra", item: "coding-team" })).toBe(false);
  // No project: the create-a-project empty state, even if an old item name is still stored.
  expect(nav.hubSurfaceOpen({ project: nav.NO_PROJECT, item: "inbox" })).toBe(true);
});

it("with no project, the entry stays the empty state, not a Today board", async () => {
  vi.stubEnv("VITE_MONOCODE_HUB", "1");
  const nav = await import("./hubNav");
  nav.showProjectToday();
  expect(nav.currentHubSelection()).toEqual({ project: nav.NO_PROJECT, item: "" });
  expect(nav.hubSurfaceOpen(nav.currentHubSelection())).toBe(true);
});

it("upstream's own build still opens on its workspace before anything was picked", async () => {
  const nav = await import("./hubNav");
  expect(nav.hubSurfaceOpen(nav.currentHubSelection())).toBe(false);
});

it("Settings → Decisions → Open is the Inbox, not the retired Today item", async () => {
  const nav = await import("./hubNav");
  expect(nav.resolveHubOpen({ project: "hivra", item: "inbox" })).toEqual({ kind: "inbox" });
  expect(nav.resolveHubOpen({ project: "项目", item: "inbox" })).toEqual({ kind: "inbox" });
  expect(nav.resolveHubOpen({ project: "hivra", item: "leadership-team" })).toEqual({
    kind: "selection",
    selection: { project: "hivra", item: "leadership-team" },
  });
  expect(nav.resolveHubOpen({ project: "hivra", item: "being-built" })).toEqual({
    kind: "selection",
    selection: { project: "hivra", item: "being-built" },
  });
  for (const detail of [null, undefined, {}, { project: "hivra" }, { item: "inbox" }, { project: "", item: "inbox" }, { project: "hivra", item: "  " }, { project: "hivra", item: "\r\n" }]) {
    expect(nav.resolveHubOpen(detail)).toBeNull();
  }
});

it("a project with no folder is a hub page, not the previous workspace", async () => {
  const nav = await import("./hubNav");
  for (const folder of [null, undefined, "", "   ", "\r\n"]) {
    const home = nav.projectHomeSelection({ id: "notes", folder });
    expect(home).toEqual({ project: "notes", item: "no-code" });
    expect(nav.hubSurfaceOpen(home)).toBe(true);
  }
  const coded = nav.projectHomeSelection({ id: "exo", folder: "/Users/example/My Projects/vg-game" });
  expect(coded).toEqual({ project: "exo", item: "coding-team" });
  expect(nav.hubSurfaceOpen(coded)).toBe(false);
  expect(nav.projectHomeSelection({ id: "win", folder: "C:\\work\\hivra" }).item).toBe("coding-team");
});
