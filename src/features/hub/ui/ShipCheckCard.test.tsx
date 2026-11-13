// @vitest-environment happy-dom
// SC-3b: the ship check on a project's crew tab (hub/ui/ShipCheckCard.tsx). It must show a record's two lists, say plainly
// when a check could not run, appear only where it belongs, never start a second run, and never put one project's answer
// under another.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestingMode } from "../../delivery/model/testingMode";
import { runShipCheck, type ShipCheckBackend, type ShipCheckRecord } from "../model/shipCheck";
import { ShipCheckCard } from "./ShipCheckCard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const HEAD = "0123456789abcdef0123456789abcdef01234567";
// Every test names its own project: the model keeps its runs by project, across tests.
let counter = 0;
const folder = () => `/work/ship-card-${++counter}`;

function record(over: Partial<ShipCheckRecord> = {}): ShipCheckRecord {
  return {
    project: "/work/app",
    head: HEAD,
    base: null,
    commitsCovered: 4,
    at: Date.now() - 5 * 60_000,
    outcome: "passed",
    note: null,
    steps: [{ name: "Project checks", outcome: "passed", detail: "ran and passed" }],
    tested: ["Web checks: 412 tests passed.", "Test guard: no test was weakened."],
    notTested: ["Review: no task briefs landed in this range."],
    ...over,
  };
}

function api(over: Partial<ShipCheckBackend> = {}): ShipCheckBackend {
  return {
    run: vi.fn(async () => record()),
    latest: vi.fn(async () => null),
    passed: vi.fn(async () => false),
    head: vi.fn(async () => HEAD),
    ...over,
  };
}

describe("the ship check card", () => {
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
    vi.unstubAllGlobals();
  });

  const modeOf = (mode: TestingMode) => vi.fn(async () => ({ mode }));

  async function show(props: { project: string; backend: ShipCheckBackend; mode?: TestingMode; quiet?: boolean }) {
    await act(async () => {
      root.render(
        createElement(ShipCheckCard, {
          project: props.project,
          backend: props.backend,
          loadMode: modeOf(props.mode ?? "at-ship"),
          quiet: props.quiet,
        }),
      );
    });
    // The card reads the mode and the last record after it renders: let those answers land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const button = () => container.querySelector<HTMLButtonElement>("[data-ship-check-run]");
  const lines = (kind: string) =>
    [...container.querySelectorAll(`[data-ship-check-list='${kind}'] li`)].map((li) => li.textContent);
  const summary = () => container.querySelector("[data-ship-check-summary]")?.textContent ?? "";
  const problem = () => container.querySelector("[data-ship-check-problem]")?.textContent ?? null;

  async function click() {
    await act(async () => {
      button()?.click();
    });
  }

  it("shows the last record: the outcome in words, the version, the commits and the two lists", async () => {
    await show({ project: folder(), backend: api({ latest: vi.fn(async () => record()) }) });
    expect(container.querySelector("[data-ship-check-outcome]")?.textContent).toBe("Passed");
    expect(summary()).toContain("version 0123456");
    expect(summary()).toContain("5 min ago");
    expect(summary()).toContain("4 commits");
    expect(lines("tested")).toEqual(["Web checks: 412 tests passed.", "Test guard: no test was weakened."]);
    expect(lines("not-tested")).toEqual(["Review: no task briefs landed in this range."]);
    expect(container.textContent).toContain("Tested");
    expect(container.textContent).toContain("Not tested");
  });

  it.each([
    ["passed", "Passed"],
    ["failed", "Failed"],
    ["couldNotRun", "Couldn't run everything"],
  ] as const)("says %s in plain words", async (outcome, word) => {
    await show({
      project: folder(),
      backend: api({
        latest: vi.fn(async () => record({ outcome, steps: [{ name: "Project checks", outcome, detail: "x" }] })),
      }),
    });
    expect(container.querySelector("[data-ship-check-outcome]")?.textContent).toBe(word);
    expect(container.querySelector("[data-ship-check]")?.getAttribute("data-ship-check-state")).toBe(outcome);
  });

  it("never reads a check that could not run as a pass", async () => {
    await show({
      project: folder(),
      backend: api({
        latest: vi.fn(async () =>
          record({ outcome: "couldNotRun", tested: [], notTested: ["Review: the model gave no answer."] }),
        ),
      }),
    });
    expect(container.textContent).not.toContain("Passed");
    expect(lines("not-tested")).toEqual(["Review: the model gave no answer."]);
    // An empty list is a sentence, not a blank.
    expect(container.querySelector("[data-ship-check-list='tested']")?.textContent).toContain("Nothing ran.");
  });

  // PT-5: a named test finding (a real bug a test caught, a flaky test that is quarantined) passes the check and stays in view.
  it("lists the record's named findings under their own heading, and no heading when there are none", async () => {
    const findings = [
      { kind: "code-wrong" as const, test: "adds up", file: "a.test.ts", line: "adds up fails because the code is wrong: tax is ignored" },
      { kind: "quarantined" as const, test: "flaky one", file: "b.test.ts", line: "flaky one is flaky and quarantined until 2026-11-27: passed on a re-run" },
    ];
    await show({ project: folder(), backend: api({ latest: vi.fn(async () => record({ findings })) }) });
    expect(lines("findings")).toEqual(findings.map((finding) => finding.line));
    expect(container.textContent).toContain("Findings");
    expect(container.querySelector("[data-ship-check-outcome]")?.textContent).toBe("Passed");
    act(() => root.unmount());
    root = createRoot(container);
    await show({ project: folder(), backend: api({ latest: vi.fn(async () => record()) }) });
    expect(container.querySelector("[data-ship-check-list='findings']")).toBeNull();
    expect(container.textContent).not.toContain("Findings");
  });

  it("shows the record's note when it has one", async () => {
    await show({
      project: folder(),
      backend: api({ latest: vi.fn(async () => record({ note: "First ship check: covered the last 30 commits" })) }),
    });
    expect(container.querySelector("[data-ship-check-note]")?.textContent).toBe(
      "First ship check: covered the last 30 commits",
    );
  });

  it("is shown in an at-ship project with no record yet, in a sentence", async () => {
    await show({ project: folder(), backend: api() });
    expect(container.querySelector("[data-ship-check]")).not.toBeNull();
    expect(summary()).toContain("Nothing has been checked for this project yet.");
    expect(button()?.textContent).toBe("Run ship check");
    expect(container.querySelector("[data-ship-check-result]")).toBeNull();
  });

  it("is not shown when the project tests each task and has no record", async () => {
    for (const mode of ["light", "full", "off"] as const) {
      await show({ project: folder(), backend: api(), mode });
      expect(container.querySelector("[data-ship-check]")).toBeNull();
      expect(container.textContent).toBe("");
    }
  });

  it("is shown when a project that tests each task already has a record", async () => {
    await show({ project: folder(), backend: api({ latest: vi.fn(async () => record()) }), mode: "full" });
    expect(container.querySelector("[data-ship-check]")).not.toBeNull();
  });

  it("is not shown when neither the mode nor the last record can be read", async () => {
    await act(async () => {
      root.render(
        createElement(ShipCheckCard, {
          project: folder(),
          backend: api({ latest: vi.fn(async () => Promise.reject("gone")) }),
          loadMode: vi.fn(async () => Promise.reject("gone")),
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("[data-ship-check]")).toBeNull();
  });

  it("runs on a click, disables its button while it runs, and shows the new result", async () => {
    let finish: (value: ShipCheckRecord) => void = () => undefined;
    const backend = api({ run: vi.fn(() => new Promise<ShipCheckRecord>((resolve) => (finish = resolve))) });
    await show({ project: folder(), backend });
    await click();
    expect(backend.run).toHaveBeenCalledTimes(1);
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toBe("Running…");
    expect(summary()).toContain("Running now");
    await act(async () => finish(record({ outcome: "failed", head: "fedcba9876543210fedcba9876543210fedcba98" })));
    expect(button()?.disabled).toBe(false);
    expect(container.querySelector("[data-ship-check-outcome]")?.textContent).toBe("Failed");
    expect(summary()).toContain("version fedcba9");
  });

  it("starts one run however fast it is clicked", async () => {
    const backend = api({ run: vi.fn(() => new Promise<ShipCheckRecord>(() => undefined)) });
    await show({ project: folder(), backend });
    await act(async () => {
      button()?.click();
      button()?.click();
      button()?.click();
    });
    expect(backend.run).toHaveBeenCalledTimes(1);
  });

  it("shows why a run could not start, keeps the last result, and shows no made-up one", async () => {
    const backend = api({
      latest: vi.fn(async () => record()),
      run: vi.fn(async () => {
        throw "Another ship check is already running for this project.";
      }),
    });
    await show({ project: folder(), backend });
    await click();
    await vi.waitFor(() => expect(problem()).toBe("Another ship check is already running for this project."));
    // The earlier result is still the earlier one.
    expect(container.querySelector("[data-ship-check-outcome]")?.textContent).toBe("Passed");
    expect(button()?.disabled).toBe(false);
  });

  it("shows no result for a run whose answer it couldn't read", async () => {
    const backend = api({ run: vi.fn(async () => ({ outcome: "passed" })) as unknown as ShipCheckBackend["run"] });
    await show({ project: folder(), backend });
    await click();
    await vi.waitFor(() => expect(problem()).toContain("couldn't be read"));
    expect(container.querySelector("[data-ship-check-result]")).toBeNull();
  });

  it("joins a run that is already out for this project instead of starting another", async () => {
    const project = folder();
    let finish: (value: ShipCheckRecord) => void = () => undefined;
    const backend = api({ run: vi.fn(() => new Promise<ShipCheckRecord>((resolve) => (finish = resolve))) });
    // A first mate's tool call (or another card) started it.
    const out = runShipCheck(project, backend);
    await show({ project, backend });
    expect(button()?.disabled).toBe(true);
    await click();
    expect(backend.run).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(record());
      await out;
    });
    expect(button()?.disabled).toBe(false);
    expect(container.querySelector("[data-ship-check-outcome]")?.textContent).toBe("Passed");
  });

  it("never puts one project's late answer under another project", async () => {
    const first = folder();
    const second = folder();
    let finish: (value: ShipCheckRecord) => void = () => undefined;
    const backend = api({
      run: vi.fn(() => new Promise<ShipCheckRecord>((resolve) => (finish = resolve))),
      latest: vi.fn(async () => null),
    });
    await show({ project: first, backend });
    await click();
    expect(button()?.disabled).toBe(true);
    // Now another project is in view.
    await show({ project: second, backend });
    expect(button()?.disabled).toBe(false);
    expect(container.querySelector("[data-ship-check-result]")).toBeNull();
    await act(async () => finish(record()));
    expect(container.querySelector("[data-ship-check-result]")).toBeNull();
    expect(container.querySelector("[data-ship-check-outcome]")).toBeNull();
    expect(button()?.disabled).toBe(false);
  });

  it("learns of a run started elsewhere (a first mate's tool call): shows it running, then its result", async () => {
    const project = folder();
    let finish: (value: ShipCheckRecord) => void = () => undefined;
    let stored: ShipCheckRecord | null = null;
    const backend = api({
      run: vi.fn(() => new Promise<ShipCheckRecord>((resolve) => (finish = resolve))),
      latest: vi.fn(async () => stored),
    });
    await show({ project, backend });
    expect(button()?.disabled).toBe(false);
    expect(container.querySelector("[data-ship-check-result]")).toBeNull();
    // Not this card: another caller starts the run.
    let out: Promise<unknown> = Promise.resolve();
    await act(async () => {
      out = runShipCheck(project, backend);
    });
    expect(backend.run).toHaveBeenCalledTimes(1);
    expect(button()?.disabled).toBe(true);
    expect(summary()).toContain("Running now");
    // It finishes: the card re-reads the latest record and shows it.
    const done = record({ head: "fedcba9876543210fedcba9876543210fedcba98", commitsCovered: 9 });
    stored = done;
    await act(async () => {
      finish(done);
      await out;
    });
    expect(button()?.disabled).toBe(false);
    expect(summary()).toContain("version fedcba9");
    expect(summary()).toContain("9 commits");
    expect(container.querySelector("[data-ship-check-result]")).not.toBeNull();
    expect(backend.latest).toHaveBeenCalledTimes(2);
  });

  it("shows why a run started elsewhere failed", async () => {
    const project = folder();
    const backend = api({
      run: vi.fn(async () => {
        throw "git is not available";
      }),
    });
    await show({ project, backend });
    await act(async () => {
      await runShipCheck(project, backend).catch(() => undefined);
    });
    expect(problem()).toBe("git is not available");
    expect(button()?.disabled).toBe(false);
    expect(container.querySelector("[data-ship-check-result]")).toBeNull();
  });

  it("is not moved by a run for another project", async () => {
    const backend = api({ run: vi.fn(() => new Promise<ShipCheckRecord>(() => undefined)) });
    await show({ project: folder(), backend });
    await act(async () => {
      void runShipCheck(folder(), backend);
    });
    expect(button()?.disabled).toBe(false);
    expect(summary()).not.toContain("Running now");
  });

  it("stops listening when it goes away", async () => {
    const project = folder();
    let finish: (value: ShipCheckRecord) => void = () => undefined;
    const backend = api({ run: vi.fn(() => new Promise<ShipCheckRecord>((resolve) => (finish = resolve))) });
    await show({ project, backend });
    // The card is gone from the screen (its effect cleans up).
    await act(async () => {
      root.render(null);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = runShipCheck(project, backend);
    finish(record());
    await out;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(errors).not.toHaveBeenCalled();
    expect(backend.latest).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("says so when the project has moved on from the version the result covers, and keeps the result", async () => {
    const backend = api({
      latest: vi.fn(async () => record()),
      head: vi.fn(async () => "89abcdef0123456789abcdef0123456789abcdef"),
    });
    await show({ project: folder(), backend });
    expect(container.querySelector("[data-ship-check-moved]")?.textContent).toBe(
      "The project is now at 89abcde, so this result is for an earlier version.",
    );
    // The outcome word is unchanged and the old result stays.
    expect(container.querySelector("[data-ship-check-outcome]")?.textContent).toBe("Passed");
    expect(lines("tested")).toHaveLength(2);
  });

  it("says nothing extra when the version is the same, or the project's version can't be read", async () => {
    for (const head of [
      vi.fn(async () => HEAD),
      vi.fn(async () => HEAD.toUpperCase()),
      vi.fn(async () => null),
      vi.fn(async () => ""),
      vi.fn(async () => Promise.reject("gone")),
    ]) {
      await show({ project: folder(), backend: api({ latest: vi.fn(async () => record()), head }) });
      expect(container.querySelector("[data-ship-check-moved]")).toBeNull();
      expect(container.querySelector("[data-ship-check-outcome]")?.textContent).toBe("Passed");
      expect(problem()).toBeNull();
    }
  });

  it("compares the project's version again after a run", async () => {
    const project = folder();
    const head = vi.fn(async () => HEAD);
    const backend = api({ run: vi.fn(async () => record({ head: "89abcdef0123456789abcdef0123456789abcdef" })), head });
    await show({ project, backend });
    await click();
    await vi.waitFor(() => expect(container.querySelector("[data-ship-check-result]")).not.toBeNull());
    // The run covered a version that is not the one the project is at.
    await vi.waitFor(() => expect(container.querySelector("[data-ship-check-moved]")).not.toBeNull());
    head.mockImplementation(async () => "89abcdef0123456789abcdef0123456789abcdef");
    await click();
    await vi.waitFor(() => expect(container.querySelector("[data-ship-check-moved]")).toBeNull());
  });

  it("is a primary button on its own, and quiet beside another", async () => {
    await show({ project: folder(), backend: api() });
    const primary = /(^|\s)bg-content(\s|$)/;
    expect(button()?.className).toMatch(primary);
    await show({ project: folder(), backend: api(), quiet: true });
    expect(button()?.className).not.toMatch(primary);
    expect(button()?.hasAttribute("data-ship-check-run")).toBe(true);
  });

  it("uses plain words, never Stuck, and no hard-coded colours", async () => {
    await show({
      project: folder(),
      backend: api({ latest: vi.fn(async () => record({ outcome: "couldNotRun" })) }),
    });
    expect(container.textContent).not.toMatch(/stuck/i);
    const html = container.innerHTML;
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\b(?:red|green|blue|amber|yellow)-\d{3}\b/i);
  });
});
