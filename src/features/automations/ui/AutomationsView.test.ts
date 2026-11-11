// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  listAutomations,
  newAutomationDraft,
  notifyAutomationsChanged,
  peekAutomations,
  type Automation,
} from "../model/automations";
import { AutomationsView } from "./AutomationsView";

const invoke = vi.hoisted(() => vi.fn());
const activityListeners = vi.hoisted(() => [] as Array<() => void>);
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, handler: () => void) => {
    activityListeners.push(handler);
    return () => {
      const index = activityListeners.indexOf(handler);
      if (index >= 0) activityListeners.splice(index, 1);
    };
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  notifyAutomationsChanged();
  invoke.mockReset();
  activityListeners.splice(0, activityListeners.length);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the cached automation list immediately and refreshes it without a loading screen", async () => {
  const automation: Automation = {
    ...newAutomationDraft("/work/project", "codex", "model"),
    id: "test-automation",
    name: "Daily review",
    nextRunAt: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  invoke.mockResolvedValue([automation]);
  await listAutomations();
  let finish!: (automations: Automation[]) => void;
  const refresh = new Promise<Automation[]>((resolve) => {
    finish = resolve;
  });
  invoke.mockReturnValue(refresh);
  await act(async () =>
    root.render(
      createElement(AutomationsView, {
        cwd: "/work/project",
        recents: [],
        onClose: vi.fn(),
        onLaunch: vi.fn(),
        onOpenSession: vi.fn(),
      }),
    ),
  );
  expect(
    container.querySelector('[aria-label="Open Daily review"]'),
  ).not.toBeNull();
  expect(container.querySelector(".animate-spin")).toBeNull();

  await act(async () => finish([{ ...automation, name: "Updated review" }]));
  expect(
    container.querySelector('[aria-label="Open Updated review"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[aria-label="Open Daily review"]'),
  ).toBeNull();
});

it("invalidates the cached list when an automation changes", async () => {
  invoke.mockResolvedValue([]);
  await listAutomations();
  expect(peekAutomations()).toEqual([]);
  notifyAutomationsChanged();
  expect(peekAutomations()).toBeNull();
});

it("lists only automations for the scoped project, plus project-less ones", async () => {
  const automation = (id: string, name: string, cwd: string): Automation => ({
    ...newAutomationDraft(cwd, "codex", "model"),
    id,
    name,
    nextRunAt: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  invoke.mockImplementation(async (command: string) =>
    command.includes("run")
      ? []
      : [
          automation("here", "Here review", "/work/project"),
          automation("there", "There review", "/work/other"),
          automation("home", "Home review", "~"),
        ],
  );
  await act(async () =>
    root.render(
      createElement(AutomationsView, {
        cwd: "/work/project",
        scopeProject: "/work/project",
        recents: [],
        onClose: vi.fn(),
        onLaunch: vi.fn(),
        onOpenSession: vi.fn(),
      }),
    ),
  );
  const shown = (name: string) =>
    container.querySelector(`[aria-label="Open ${name}"]`) != null;
  expect(shown("Here review")).toBe(true);
  expect(shown("Home review")).toBe(true);
  expect(shown("There review")).toBe(false);
});

type ActivityQuery = { kind?: string; before?: { seq?: number } };

function automation(id: string, name: string, cwd: string): Automation {
  return {
    ...newAutomationDraft(cwd, "codex", "model"),
    id,
    name,
    nextRunAt: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function runLine(
  id: string,
  kind: string,
  summary: string,
  project: string,
  target: string,
  seq: number,
) {
  return {
    id,
    seq,
    kind,
    actor: { role: "app" },
    initiator: { role: "app" },
    project,
    target,
    summary,
    link: "",
    at: seq,
  };
}

async function openRuns() {
  const tab = [...container.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent === "Runs",
  );
  if (!(tab instanceof HTMLButtonElement)) throw new Error("missing runs tab");
  await act(async () => {
    tab.click();
  });
}

it("shows runs for the open project and not another project's", async () => {
  const rows = [
    runLine(
      "here",
      "automation.started",
      "Here review. Started by the 9:00 schedule.",
      "/work/project",
      "here/run-1",
      4,
    ),
    runLine(
      "slash",
      "automation.started",
      "Slash review. Started by the 9:00 schedule.",
      "/work/project/",
      "slash/run-1",
      3,
    ),
    runLine(
      "there",
      "automation.started",
      "There review. Started by the hourly schedule.",
      "/work/other",
      "there/run-1",
      2,
    ),
    runLine(
      "home",
      "automation.started",
      "Home review. Started by the schedule.",
      "~",
      "home/run-1",
      1,
    ),
  ];
  invoke.mockImplementation(async (command: string, args?: { query?: ActivityQuery }) => {
    if (command === "activity_list") {
      const kind = args?.query?.kind;
      return { entries: rows.filter((row) => row.kind === kind), next: null };
    }
    if (command === "automations_list") {
      return [
        automation("here", "Here review", "/work/project"),
        automation("there", "There review", "/work/other"),
        automation("home", "Home review", "~"),
      ];
    }
    return [];
  });
  await act(async () =>
    root.render(
      createElement(AutomationsView, {
        cwd: "/work/project",
        scopeProject: "/work/project",
        recents: [],
        onClose: vi.fn(),
        onLaunch: vi.fn(),
        onOpenSession: vi.fn(),
      }),
    ),
  );
  await openRuns();
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Here review. Started by the 9:00 schedule.");
  });
  expect(container.textContent).toContain("Slash review. Started by the 9:00 schedule.");
  expect(container.textContent).toContain("Home review. Started by the schedule.");
  expect(container.textContent).not.toContain("There review. Started by the hourly schedule.");
});

it("a new activity line does not read the older pages again", async () => {
  const newer = runLine(
    "new",
    "automation.started",
    "Newer. Started by the 9:00 schedule.",
    "/work/project",
    "morning/run-2",
    2,
  );
  const older = runLine(
    "old",
    "automation.started",
    "Older. Started by the hourly schedule.",
    "/work/project",
    "morning/run-1",
    1,
  );
  const queries: ActivityQuery[] = [];
  invoke.mockImplementation(async (command: string, args?: { query?: ActivityQuery }) => {
    if (command === "activity_list") {
      const query = args?.query ?? {};
      queries.push(query);
      if (query.kind !== "automation.started") return { entries: [], next: null };
      if (query.before) return { entries: [older], next: null };
      return { entries: [newer], next: { at: newer.at, seq: newer.seq } };
    }
    if (command === "automations_list") {
      return [automation("morning", "Morning", "/work/project")];
    }
    return [];
  });
  await act(async () =>
    root.render(
      createElement(AutomationsView, {
        cwd: "/work/project",
        recents: [],
        onClose: vi.fn(),
        onLaunch: vi.fn(),
        onOpenSession: vi.fn(),
      }),
    ),
  );
  await openRuns();
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Older. Started by the hourly schedule.");
  });
  const readBefore = queries.filter((query) => query.before).length;
  expect(readBefore).toBeGreaterThan(0);
  expect(activityListeners.length).toBeGreaterThan(0);
  const mark = queries.length;
  await act(async () => {
    for (const handler of [...activityListeners]) handler();
  });
  await vi.waitFor(() => {
    expect(queries.length).toBeGreaterThanOrEqual(mark + 3);
  });
  expect(queries.filter((query) => query.before).length).toBe(readBefore);
  expect(container.textContent).toContain("Newer. Started by the 9:00 schedule.");
  expect(container.textContent).toContain("Older. Started by the hourly schedule.");
});

function expectTabControlsNameRenderedPanels() {
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  expect(tabs.length).toBeGreaterThan(0);
  for (const tab of tabs) {
    const id = tab.getAttribute("aria-controls");
    const selected = tab.getAttribute("aria-selected") === "true";
    if (selected) expect(id).toBeTruthy();
    if (!id) continue;
    expect(document.getElementById(id), `${tab.textContent} -> ${id}`).not.toBeNull();
  }
}

async function openTab(name: string) {
  const tab = [...container.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent === name,
  );
  if (!(tab instanceof HTMLButtonElement)) throw new Error(`missing ${name} tab`);
  await act(async () => {
    tab.click();
  });
}

it("a tab only names a panel that is on screen", async () => {
  invoke.mockImplementation(async (command: string) =>
    command === "automations_list"
      ? [automation("daily", "Daily review", "/work/project")]
      : [],
  );
  await act(async () =>
    root.render(
      createElement(AutomationsView, {
        cwd: "/work/project",
        recents: [],
        onClose: vi.fn(),
        onLaunch: vi.fn(),
        onOpenSession: vi.fn(),
      }),
    ),
  );
  expectTabControlsNameRenderedPanels();
  await openTab("Runs");
  expectTabControlsNameRenderedPanels();
  await openTab("Map");
  expectTabControlsNameRenderedPanels();
  await openTab("Automations");
  const card = container.querySelector('[aria-label="Open Daily review"]');
  if (!(card instanceof HTMLButtonElement)) throw new Error("missing automation card");
  await act(async () => {
    card.click();
  });
  expectTabControlsNameRenderedPanels();
  await openTab("Run history");
  expectTabControlsNameRenderedPanels();
  await openTab("Settings");
  expectTabControlsNameRenderedPanels();
});
