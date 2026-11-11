// @vitest-environment happy-dom
// The Hub's shell under upstream MonoCode's opt-in new (inset) layout: Pages, the project's hub items and the
// project strip stay reachable there, the classic layout is unchanged, and the Hub bundle doesn't prompt Ash to
// switch layouts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { ProjectStrip } from "../../features/hub/ui/ProjectStrip";

vi.mock("../../features/source-control/hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: () => null,
}));
vi.mock("../../features/source-control/hooks/useGitFileStatuses", () => ({
  useGitFileStatuses: () => ({ files: new Map(), dirs: new Map() }),
}));
vi.mock("./SidebarUpdate", () => ({ SidebarUpdateFooter: () => null }));
vi.mock("../../features/files/ui/FileTree", () => ({ FileTree: () => null }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function sidebar(over: Partial<ComponentProps<typeof Sidebar>>) {
  const props: ComponentProps<typeof Sidebar> = {
    cwd: "/workspace/project",
    open: true,
    sessions: [],
    busySessionIds: new Set(),
    approvalSessionIds: new Set(),
    status: "idle",
    pending: false,
    tab: "sessions",
    filesSearchOpen: false,
    onSelectSession: vi.fn(),
    onOpenFile: vi.fn(),
    onTabChange: vi.fn(),
    onFilesSearchOpenChange: vi.fn(),
    ...over,
  };
  act(() => root.render(createElement(Sidebar, props)));
}

const views = () => [
  ...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Views"] button'),
];
const hubItems = () => createElement("div", { "data-probe-hub-items": "" });
const shownHubItems = () => container.querySelectorAll("[data-probe-hub-items]").length;

describe("the Hub in the new layout", () => {
  it("lists Hubs with the other views, marks it open, and opens it", () => {
    const onOpenPages = vi.fn();
    sidebar({ inset: true, onOpenAutomations: vi.fn(), onOpenPages, pagesActive: true });
    const labels = views().map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["Automations", "Hubs"]);
    const pages = views()[1];
    expect(pages.className).toContain("bg-selection");
    act(() => pages.click());
    expect(onOpenPages).toHaveBeenCalledOnce();
  });

  it("shows the selected project's hub items in the sidebar, once", () => {
    sidebar({ inset: true, hubItems: hubItems() });
    expect(shownHubItems()).toBe(1);
  });

  it("the strip leaves the traffic lights to the title bar above it", () => {
    const spacer = (titleBarAbove: boolean) => {
      act(() =>
        root.render(
          createElement(ProjectStrip, {
            selection: { project: "hivra", item: "inbox" },
            onPickProject: () => undefined,
            onCreateProject: () => undefined,
            titleBarAbove,
          }),
        ),
      );
      return container.querySelector("[data-hub-strip]")!.firstElementChild!.className;
    };
    expect(spacer(false)).toContain("h-10");
    expect(spacer(true)).not.toContain("h-10");
  });
});

describe("the Hub in the classic layout, unchanged", () => {
  it("lists hub items in the project rail only, and has no inset views list", () => {
    sidebar({
      inset: false,
      projectRailOpen: true,
      onSelectProject: vi.fn(),
      onOpenProject: vi.fn(),
      onOpenPages: vi.fn(),
      hubItems: hubItems(),
    });
    expect(shownHubItems()).toBe(1);
    expect(container.querySelector('[aria-label="Projects"] [data-probe-hub-items]')).not.toBeNull();
    expect(views()).toHaveLength(0);
  });
});

it("an upstream merge can't bring the new-layout prompt back into the Hub bundle", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(join(here, "../App.tsx"), "utf8");
  // WP-01: gated on hubDefaultsOn(), which is on in the Hub bundle (and on the hub dev page), so the Hub never shows it.
  expect(app).toMatch(/\{hubDefaultsOn\(\) \? null : \(\s*<NewLayoutNotice\b/);
});
