// @vitest-environment happy-dom
// WP-01: upstream MonoCode's own build (no Hub flag, no hub dev page) opens on its workspace, as upstream does, until a
// hub view is picked; the Hub bundle and the hub's dev page open on the hub (hubDefaults.ts).
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

async function surfaceOnFirstLaunch(): Promise<boolean> {
  const nav = await import("./hubNav");
  let open = false;
  const { renderToString } = await import("react-dom/server");
  const { createElement } = await import("react");
  // What App asks on its first render: the stored selection, through the hook.
  function Probe() {
    open = nav.hubSurfaceOpen(nav.useHubSelection());
    return null;
  }
  renderToString(createElement(Probe));
  return open;
}

it("upstream's own build opens on its workspace before anything was picked", async () => {
  expect(await surfaceOnFirstLaunch()).toBe(false);
});

it("once a hub view is picked, upstream's own build shows it too", async () => {
  const nav = await import("./hubNav");
  nav.showProjectToday();
  expect(nav.hubSurfaceOpen({ project: nav.NO_PROJECT, item: "inbox" })).toBe(true);
});

it("the hub's dev page opens on the hub", async () => {
  (window as { __MONOCODE_HUB_DEV_PAGE__?: boolean }).__MONOCODE_HUB_DEV_PAGE__ = true;
  expect(await surfaceOnFirstLaunch()).toBe(true);
});

it("the Hub bundle opens on the hub", async () => {
  vi.stubEnv("VITE_MONOCODE_HUB", "1");
  expect(await surfaceOnFirstLaunch()).toBe(true);
});
