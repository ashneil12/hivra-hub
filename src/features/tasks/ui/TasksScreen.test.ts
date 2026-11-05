// @vitest-environment happy-dom
// WP-71: a view change is kept, a stale delete is not, and an agent card is not a silent bulk success.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubDataSource } from "../../hub/model/types";
import { defaultViewState } from "../vendor/views/viewState";
import { TasksScreen } from "./TasksScreen";

const bridge = vi.hoisted(() => ({
  changed: undefined as undefined | (() => void),
  stacks: undefined as undefined | (() => void),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    if (name === "stacks://changed") bridge.stacks = handler;
    else bridge.changed = handler;
    return () => {
      if (name === "stacks://changed") {
        if (bridge.stacks === handler) bridge.stacks = undefined;
      } else if (bridge.changed === handler) bridge.changed = undefined;
    };
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = [string, { actor?: { project?: string }; input?: Record<string, unknown>; id?: string; version?: number }];

function view(layout: "list" | "board", version: number, id = "view-1", name = "Tasks", builtin = true) {
  const state = defaultViewState();
  state.display.layout = layout;
  return { id, pageKey: "project:crew", name, state, version, builtin };
}

const person = {
  id: "task-1",
  projectId: "crew",
  number: 1,
  title: "Write the notes",
  status: "Todo",
  priority: "none",
  labels: [],
  version: 1,
  delegationId: null,
};

const agent = {
  ...person,
  id: "agent-1",
  number: 2,
  title: "Ship the board",
  delegationId: "del-1",
};

let root: Root | undefined;
let host: HTMLElement | undefined;

function calls(command: string): Call[] {
  return vi.mocked(invoke).mock.calls.filter((call) => call[0] === command) as Call[];
}

function pressed(): string {
  return [...(host?.querySelectorAll("button") ?? [])].find((button) => button.getAttribute("aria-pressed") === "true")?.textContent?.trim() ?? "";
}

async function until(check: () => boolean) {
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw new Error(`timed out: ${host?.textContent ?? ""}`);
}

async function render(scope: "project" | "all" = "project") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(TasksScreen, { cwd: "/repo", scope }));
  });
}

function unmount() {
  if (!root) return;
  act(() => root?.unmount());
  root = undefined;
}

beforeEach(() => {
  bridge.changed = undefined;
  bridge.stacks = undefined;
  localStorage.clear();
  vi.mocked(invoke).mockReset();
  setHubDataSource({
    listProjects: () => [
      { id: "crew", name: "Crew", shortName: "Crew", iconShape: "folder", folder: "/repo" },
      { id: "other", name: "Other", shortName: "Other", iconShape: "folder", folder: "/else" },
    ],
  } as HubDataSource);
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "tasks_list") return [];
    if (command === "tasks_statuses") {
      return [
        { projectId: "crew", name: "Todo", category: "unstarted", position: 0, color: "" },
        { projectId: "other", name: "Blocked", category: "started", position: 1, color: "" },
      ];
    }
    if (command === "tasks_views_list") return [view("list", 1)];
    if (command === "tasks_views_save") return { stale: false, view: view("board", 2) };
    return null;
  });
});

afterEach(() => {
  unmount();
  host?.remove();
  setHubDataSource(undefined);
});

it("does not put another project's status on this project's board", async () => {
  await render("project");
  await until(() => pressed() === "List");
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Board")?.click();
  });
  await until(() => host?.querySelector("[aria-label='Todo']") != null);
  expect(host?.querySelector("[aria-label='Blocked']")).toBeNull();
  const asked = calls("tasks_statuses").map((call) => call[1].actor?.project);
  expect(asked).toEqual(["crew"]);
});

it("asks every project for its own statuses on All tasks", async () => {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: { actor?: { project?: string } }) => {
    if (command === "tasks_list") return [];
    if (command === "tasks_statuses") {
      const project = args?.actor?.project;
      if (project === "other") return [{ projectId: "other", name: "Blocked", category: "started", position: 1, color: "" }];
      if (project === "crew") return [{ projectId: "crew", name: "Todo", category: "unstarted", position: 0, color: "" }];
      return [];
    }
    if (command === "tasks_views_list") return [view("list", 1)];
    if (command === "tasks_views_save") return { stale: false, view: view("board", 2) };
    return null;
  });
  await render("all");
  await until(() => pressed() === "List");
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Board")?.click();
  });
  await until(() => host?.querySelector("[aria-label='Blocked']") != null || calls("tasks_statuses").length > 0);
  const asked = calls("tasks_statuses").map((call) => call[1].actor?.project);
  expect(asked).toContain("crew");
  expect(asked).toContain("other");
  expect(asked).not.toContain("/repo");
  expect(asked).not.toContain("/else");
  expect(host?.querySelector("[aria-label='Blocked']")).not.toBeNull();
  expect(host?.querySelector("[aria-label='Todo']")).not.toBeNull();
});

it("saves a layout change when Tasks is left before the debounce", async () => {
  await render();
  await until(() => pressed() === "List");
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Board")?.click();
  });
  unmount();
  const saved = calls("tasks_views_save");
  expect(saved).toHaveLength(1);
  expect((saved[0]?.[1].input?.state as { display?: { layout?: string } } | undefined)?.display?.layout).toBe("board");
});

it("does not paint an older view over a save that already landed", async () => {
  let viewsCalls = 0;
  let releaseSecond: (rows: unknown) => void = () => undefined;
  let second = Promise.resolve();
  vi.mocked(invoke).mockImplementation(async (command: string, args?: { input?: { state?: unknown; version?: number } }) => {
    if (command === "tasks_list") return [];
    if (command === "tasks_statuses") return [{ projectId: "crew", name: "Todo", category: "unstarted", position: 0, color: "" }];
    if (command === "tasks_views_list") {
      viewsCalls += 1;
      if (viewsCalls === 1) return [view("list", 1)];
      second = new Promise((resolve) => {
        releaseSecond = resolve;
      });
      return second;
    }
    if (command === "tasks_views_save") return { stale: false, view: view("board", (args?.input?.version ?? 1) + 1) };
    return null;
  });
  await render();
  await until(() => pressed() === "List");
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Board")?.click();
  });
  await act(async () => {
    bridge.changed?.();
  });
  await until(() => viewsCalls >= 2);
  await until(() => calls("tasks_views_save").length >= 1);
  await act(async () => {
    releaseSecond([view("list", 1)]);
    await second;
  });
  expect(pressed()).toBe("Board");
});

it("keeps a view that was saved while the list was still in flight", async () => {
  let viewsCalls = 0;
  let releaseSecond: (rows: unknown) => void = () => undefined;
  let second = Promise.resolve();
  vi.mocked(invoke).mockImplementation(async (command: string, args?: { input?: { id?: string; name?: string; state?: unknown } }) => {
    if (command === "tasks_list") return [];
    if (command === "tasks_statuses") return [];
    if (command === "tasks_views_list") {
      viewsCalls += 1;
      if (viewsCalls === 1) return [view("list", 1)];
      second = new Promise((resolve) => {
        releaseSecond = resolve;
      });
      return second;
    }
    if (command === "tasks_views_save" && !args?.input?.id) {
      return { stale: false, view: { id: "view-2", pageKey: "project:crew", name: args?.input?.name, state: args?.input?.state, version: 1, builtin: false } };
    }
    return { stale: false, view: view("list", 2) };
  });
  await render();
  await until(() => pressed() === "List");
  await act(async () => {
    bridge.changed?.();
  });
  await until(() => viewsCalls >= 2);
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Save view" && button.getAttribute("type") !== "submit")?.click();
  });
  const input = host?.querySelector("[aria-label='View name']") as HTMLInputElement | null;
  expect(input).not.toBeNull();
  await act(async () => {
    if (!input) return;
    input.value = "Mine";
    input.form?.requestSubmit();
  });
  await until(() => (host?.querySelector("[aria-label='Saved view']") as HTMLSelectElement | null)?.value === "view-2");
  await act(async () => {
    releaseSecond([view("list", 1)]);
    await second;
  });
  expect((host?.querySelector("[aria-label='Saved view']") as HTMLSelectElement | null)?.value).toBe("view-2");
});

it("leaves a view in place when the delete lost the version", async () => {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "tasks_list") return [];
    if (command === "tasks_statuses") return [];
    if (command === "tasks_views_list") return [view("list", 1), view("list", 1, "view-2", "Mine", false)];
    if (command === "tasks_views_delete") return { stale: true, view: view("list", 4, "view-2", "Mine", false) };
    return null;
  });
  await render();
  await until(() => host?.querySelector("[aria-label='Saved view']") != null);
  await act(async () => {
    const select = host?.querySelector("[aria-label='Saved view']") as HTMLSelectElement;
    select.value = "view-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Delete view")?.click();
  });
  await until(() => (host?.textContent ?? "").includes("That view changed"));
  const names = [...(host?.querySelectorAll("[aria-label='Saved view'] option") ?? [])].map((option) => option.textContent);
  expect(names).toContain("Mine");
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Delete view")?.click();
  });
  expect(calls("tasks_views_delete").map((call) => call[1].version)).toEqual([1, 4]);
});

it("drops a view when the delete is the current version", async () => {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "tasks_list") return [];
    if (command === "tasks_statuses") return [];
    if (command === "tasks_views_list") return [view("list", 1), view("list", 1, "view-2", "Mine", false)];
    if (command === "tasks_views_delete") return { stale: false, view: view("list", 1, "view-2", "Mine", false) };
    return null;
  });
  await render();
  await until(() => host?.querySelector("[aria-label='Saved view']") != null);
  await act(async () => {
    const select = host?.querySelector("[aria-label='Saved view']") as HTMLSelectElement;
    select.value = "view-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Delete view")?.click();
  });
  await until(() => !(host?.textContent ?? "").includes("Mine"));
  const names = [...(host?.querySelectorAll("[aria-label='Saved view'] option") ?? [])].map((option) => option.textContent);
  expect(names).not.toContain("Mine");
  expect(names).toContain("Tasks");
});

it("says when a bulk status change cannot move an agent card", async () => {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: { input?: { id?: string } }) => {
    if (command === "tasks_list") return [person, agent];
    if (command === "tasks_statuses") {
      return [
        { projectId: "crew", name: "Todo", category: "unstarted", position: 0, color: "" },
        { projectId: "crew", name: "Done", category: "completed", position: 1, color: "" },
      ];
    }
    if (command === "tasks_views_list") return [view("list", 1)];
    if (command === "tasks_update") {
      const task = args?.input?.id === agent.id ? agent : person;
      return { stale: false, task: { ...task, status: "Done", version: 2 } };
    }
    return null;
  });
  await render();
  await until(() => host?.querySelector("[aria-label='Select #2']") != null);
  await act(async () => {
    for (const label of ["Select #1", "Select #2"]) {
      (host?.querySelector(`[aria-label='${label}']`) as HTMLInputElement | null)?.click();
    }
  });
  await act(async () => {
    const select = host?.querySelector("[aria-label='Bulk status']") as HTMLSelectElement;
    select.value = "Done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => (host?.textContent ?? "").includes("This task follows its work."));
  expect(calls("tasks_update").map((call) => call[1].input?.id)).toEqual(["task-1"]);
});

it("refreshes the running app link when a stack changes and drops a late one", async () => {
  let url: string | null = null;
  let holdRepo = false;
  let releaseHeld: (value: unknown) => void = () => undefined;
  vi.mocked(invoke).mockImplementation(async (command: string, args?: { cwd?: string }) => {
    if (command === "tasks_list") return [person];
    if (command === "tasks_get") return person;
    if (command === "tasks_statuses") return [{ projectId: "crew", name: "Todo", category: "unstarted", position: 0, color: "" }];
    if (command === "tasks_views_list") return [view("list", 1)];
    if (command === "stack_status") {
      if (holdRepo && args?.cwd === "/repo") {
        return new Promise((resolve) => {
          releaseHeld = resolve;
        });
      }
      return { url: args?.cwd === "/repo" ? url : null, stacks: [] };
    }
    return null;
  });
  await render();
  await until(() => (host?.textContent ?? "").includes("#1 Write the notes"));
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "#1 Write the notes")?.click();
  });
  await until(() => calls("stack_status").length >= 1);
  expect(host?.textContent ?? "").not.toContain("Open the running app");
  expect(bridge.stacks).toBeTypeOf("function");
  url = "http://127.0.0.1:22010";
  await act(async () => {
    bridge.stacks?.();
  });
  await until(() => (host?.textContent ?? "").includes("Open the running app"));
  holdRepo = true;
  await act(async () => {
    bridge.stacks?.();
  });
  await act(async () => {
    root?.render(createElement(TasksScreen, { cwd: "/else" }));
  });
  await act(async () => {
    releaseHeld({ url: "http://127.0.0.1:22999", stacks: [] });
  });
  expect(host?.querySelector("a[href='http://127.0.0.1:22999']")).toBeNull();
});
