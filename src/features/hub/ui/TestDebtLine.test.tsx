// @vitest-environment happy-dom
// PT-5: the one quiet line beside the ship check card (hub/ui/TestDebtLine.tsx). It shows the count the app gives, lists the tests
// in a popover, never counts a real bug or a flaky test, shows nothing for a zero count or an unreadable answer, and never puts
// one project's late answer under another.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShipCheck, type ShipCheckRecord } from "../model/shipCheck";
import { type TestDebtBackend } from "../model/testDebt";
import { TestDebtLine } from "./TestDebtLine";

const events = vi.hoisted(() => ({ names: [] as string[], handlers: [] as Array<() => void> }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    events.names.push(name);
    events.handlers.push(handler);
    return () => undefined;
  }),
}));

const DAY = 86_400_000;
let counter = 0;
const folder = () => `/work/test-debt-${++counter}`;

function item(over: Record<string, unknown> = {}) {
  return {
    id: `t${++counter}`,
    test: "saves the draft",
    file: "src/draft.test.ts",
    since: Date.now() - 2 * DAY,
    task: "Draft saving",
    state: "to-sort",
    ...over,
  };
}

function answer(over: Record<string, unknown> = {}) {
  return { count: 1, sorting: false, items: [item()], ...over };
}

function api(answerFor: () => unknown): TestDebtBackend {
  return { summary: vi.fn(async () => answerFor()) };
}

describe("the test debt line", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // The popover measures itself with ResizeObserver, which a page without layout doesn't have.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    events.names.length = 0;
    events.handlers.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function show(project: string, backend: TestDebtBackend) {
    await act(async () => {
      root.render(createElement(TestDebtLine, { project, backend }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const line = () => container.querySelector<HTMLElement>("[data-test-debt-count]");
  const more = () => container.querySelector<HTMLButtonElement>("[data-test-debt-more]");
  const popover = () => document.body.querySelector<HTMLElement>("[data-test-debt-popover]");

  async function openMore() {
    await act(async () => {
      more()?.click();
    });
  }

  it("shows nothing when the count is zero", async () => {
    await show(folder(), api(() => ({ count: 0, sorting: false, items: [] })));
    expect(line()).toBeNull();
    expect(more()).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("says how many tests wait to be sorted at ship, and has a data hook with the count", async () => {
    await show(
      folder(),
      api(() => ({ count: 3, sorting: false, items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })] })),
    );
    expect(line()?.textContent).toBe("3 tests to sort at ship");
    expect(line()?.getAttribute("data-test-debt-count")).toBe("3");
    expect(more()).not.toBeNull();
  });

  it("uses the singular for one test", async () => {
    await show(folder(), api(() => answer()));
    expect(line()?.textContent).toBe("1 test to sort at ship");
    expect(line()?.getAttribute("data-test-debt-count")).toBe("1");
  });

  it("reads Sorting with the app's own count while the app is sorting, even when the popover lists fewer", async () => {
    // The app counts every test still to sort; the popover lists at most a hundred, and a flaky one is listed but not counted.
    await show(
      folder(),
      api(() => ({ count: 150, sorting: true, items: [item({ id: "a" }), item({ id: "b" }), item({ id: "c", state: "flaky" })] })),
    );
    expect(line()?.textContent).toBe("Sorting 150 tests");
    expect(line()?.getAttribute("data-test-debt-count")).toBe("150");
  });

  it("opens a popover that lists each test with its file, since when and its task", async () => {
    await show(folder(), api(() => answer()));
    expect(popover()).toBeNull();
    await openMore();
    const row = popover()?.querySelector("[data-test-debt-item]");
    expect(row?.querySelector("[data-test-debt-test]")?.textContent).toBe("saves the draft");
    expect(row?.querySelector("[data-test-debt-file]")?.textContent).toBe("src/draft.test.ts");
    expect(row?.querySelector("[data-test-debt-since]")?.textContent).toBe("since 2 days ago");
    expect(row?.querySelector("[data-test-debt-task]")?.textContent).toBe("from Draft saving");
    expect(more()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("lists real-bug and flaky tests with a quiet label, and does not count them", async () => {
    await show(
      folder(),
      api(() => ({
        count: 1,
        sorting: false,
        items: [item({ id: "a" }), item({ id: "b", state: "real-bug", test: "adds a row" }), item({ id: "c", state: "flaky", test: "loads" })],
      })),
    );
    expect(line()?.textContent).toBe("1 test to sort at ship");
    await openMore();
    const states = [...(popover()?.querySelectorAll("[data-test-debt-item]") ?? [])].map((row) => row.getAttribute("data-test-debt-item"));
    expect(states).toEqual(["to-sort", "real-bug", "flaky"]);
    expect(popover()?.textContent).toContain("Real bug");
    expect(popover()?.textContent).toContain("Flaky");
  });

  it("labels a real bug the person chose to ship with, apart from one that still waits on them", async () => {
    await show(
      folder(),
      api(() => ({
        count: 1,
        sorting: false,
        items: [
          item({ id: "a" }),
          item({ id: "b", state: "real-bug", test: "adds a row" }),
          item({ id: "c", state: "shipping-anyway", test: "totals" }),
        ],
      })),
    );
    await openMore();
    const rows = [...(popover()?.querySelectorAll("[data-test-debt-item]") ?? [])];
    expect(rows.map((row) => row.getAttribute("data-test-debt-item"))).toEqual(["to-sort", "real-bug", "shipping-anyway"]);
    expect(rows[1]?.querySelector("[data-test-debt-state]")?.textContent).toBe("Real bug");
    expect(rows[2]?.querySelector("[data-test-debt-state]")?.textContent).toBe("Real bug, shipping anyway");
  });

  it("shows nothing when the answer is not one it can read", async () => {
    await show(folder(), api(() => ({ count: "lots", sorting: false, items: "x" })));
    expect(line()).toBeNull();
    expect(more()).toBeNull();
  });

  it("shows nothing when the read fails", async () => {
    await show(folder(), { summary: vi.fn(async () => Promise.reject("gone")) });
    expect(container.textContent).toBe("");
  });

  it("reads again when the app says the test debt changed", async () => {
    let count = 1;
    await show(folder(), api(() => answer({ count })));
    expect(line()?.textContent).toBe("1 test to sort at ship");
    expect(events.names).toContain("test-debt://changed");
    count = 2;
    await act(async () => {
      for (const handler of events.handlers) handler();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(line()?.textContent).toBe("2 tests to sort at ship");
  });

  it("reads again when a ship check settles for its project", async () => {
    const project = folder();
    let count = 1;
    await show(project, api(() => answer({ count })));
    count = 4;
    const record: ShipCheckRecord = {
      project,
      head: "0123456789abcdef0123456789abcdef01234567",
      base: null,
      commitsCovered: 0,
      at: Date.now(),
      outcome: "passed",
      note: null,
      steps: [],
      tested: [],
      notTested: [],
    };
    await act(async () => {
      await runShipCheck(project, { run: async () => record });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(line()?.textContent).toBe("4 tests to sort at ship");
  });

  it("never puts one project's late answer under another project", async () => {
    const first = folder();
    const second = folder();
    let finishFirst: (value: unknown) => void = () => undefined;
    const backend: TestDebtBackend = {
      summary: vi.fn((cwd: string) =>
        cwd === first
          ? new Promise((resolve) => (finishFirst = resolve))
          : Promise.resolve(answer({ count: 2, items: [item({ id: "s" })] })),
      ),
    };
    await show(first, backend);
    await show(second, backend);
    expect(line()?.textContent).toBe("2 tests to sort at ship");
    await act(async () => finishFirst(answer({ count: 9 })));
    expect(line()?.textContent).toBe("2 tests to sort at ship");
  });

  it("uses plain words, never Stuck, and no hard-coded colours", async () => {
    await show(folder(), api(() => answer()));
    await openMore();
    expect(container.textContent).not.toMatch(/stuck/i);
    expect(document.body.textContent).not.toMatch(/stuck/i);
    const html = container.innerHTML + (popover()?.outerHTML ?? "");
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\b(?:red|green|blue|amber|yellow)-\d{3}\b/i);
  });
});
