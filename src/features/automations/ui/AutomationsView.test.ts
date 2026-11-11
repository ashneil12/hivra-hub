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
