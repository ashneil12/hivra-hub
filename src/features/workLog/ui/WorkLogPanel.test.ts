// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLogPanel } from "./WorkLogPanel";
import type { WorkLogLine } from "../model/workLog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

function line(day: string, kind: WorkLogLine["kind"], text: string, project = "hivra"): WorkLogLine {
  return { project, day, kind, taskId: "", line: text };
}

const seed: WorkLogLine[] = [
  line("2026-11-09", "outcome", "Done: Wrote the log."),
  line("2026-11-10", "decision", "Decided: Ship it. Answer: yes."),
  line("2026-11-10", "outcome", "Done: Shipped the panel."),
  line("2026-11-10", "outcome", "Done: Other project.", "other"),
  line("2026-11-03", "outcome", "Done: Too old for the week."),
];

describe("WorkLogPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset().mockImplementation(async () => undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(props: { lines?: WorkLogLine[] } = { lines: seed }) {
    await act(async () => {
      root.render(createElement(WorkLogPanel, { ...props, today: "2026-11-10" }));
    });
  }

  function setProject(value: string) {
    const input = container.querySelector("input")!;
    return act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("groups the week by day and kind, and answers today from outcomes", async () => {
    await render();
    expect(invoke).not.toHaveBeenCalled();
    const days = [...container.querySelectorAll("[data-day]")].map((node) => node.getAttribute("data-day"));
    expect(days).toEqual(["2026-11-10", "2026-11-09"]);
    expect(container.textContent).not.toContain("Too old for the week");
    const today = container.querySelector("[data-day='2026-11-10']")!;
    const kinds = [...today.querySelectorAll("[data-kind]")].map((node) => node.getAttribute("data-kind"));
    expect(kinds).toEqual(["outcome", "decision"]);
    expect(container.querySelector("[data-today-answer]")!.textContent).toBe(
      "Done: Shipped the panel.\nDone: Other project.",
    );
  });

  it("filters to one project, and a miss is not an empty log", async () => {
    await render();
    await setProject("hivra");
    expect(container.textContent).toContain("Done: Shipped the panel.");
    expect(container.textContent).not.toContain("Other project");
    expect(container.querySelector("[data-today-answer]")!.textContent).toBe("Done: Shipped the panel.");

    await setProject("missing");
    expect(container.textContent).toContain("Nothing matches.");
    expect(container.querySelector("[data-today-answer]")!.textContent).toBe("Nothing got done today.");
  });

  it("today shows one day", async () => {
    await render();
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Today")!.click();
    });
    const days = [...container.querySelectorAll("[data-day]")].map((node) => node.getAttribute("data-day"));
    expect(days).toEqual(["2026-11-10"]);
  });

  it("says when nothing is written", async () => {
    await render({ lines: [] });
    expect(container.textContent).toContain("Nothing has been written yet.");
    expect(container.querySelector("[data-today-answer]")!.textContent).toBe("Nothing got done today.");
  });

  it("a late read does not replace a newer one, and a failed read keeps the rows", async () => {
    let resolveFirst: (rows: unknown) => void = () => undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    vi.mocked(invoke).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return first;
      if (calls === 2) {
        return [{ project: "hivra", day: "2026-11-10", kind: "outcome", taskId: "", line: "Done: The newer read." }];
      }
      throw new Error("timed out");
    });
    await render({ lines: undefined });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Today")!.click();
      await Promise.resolve();
    });
    resolveFirst([{ project: "hivra", day: "2026-11-10", kind: "outcome", taskId: "", line: "Done: The late read." }]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Done: The newer read.");
    expect(container.textContent).not.toContain("The late read");

    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "This week")!.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Done: The newer read.");
    expect(container.textContent).toContain("The work log could not be read. Try again.");
  });
});
