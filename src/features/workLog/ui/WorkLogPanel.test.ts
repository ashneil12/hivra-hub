// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLogPanel } from "./WorkLogPanel";
import type { PendingEdit } from "../model/retro";
import type { StageOutcome } from "../model/retroStore";
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
    localStorage.clear();
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

  async function render(
    props: {
      lines?: WorkLogLine[];
      stage?: (edits: PendingEdit[], at: string) => Promise<StageOutcome>;
    } = { lines: seed },
  ) {
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

  const queued: StageOutcome = { staged: 1, waiting: 1, declined: 0, present: 0, full: 0 };
  const click = (name: string) =>
    act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === name)!.click();
    });

  it("the summary reports the week and queues Ash's corrections as pending, leaving Opinions alone", async () => {
    const stage = vi.fn(async () => queued);
    await render({ lines: [...seed, line("2026-11-10", "feedback", "Keep the line short.")], stage });
    await click("Summarize the week");
    const retro = container.querySelector("[data-retro]")!;
    expect(retro.textContent).toContain("Shipped: 3.");
    expect(retro.textContent).toContain("Feedback: 1.");
    expect(retro.textContent).toContain("Keep the line short.");
    expect(retro.textContent).toContain("1 edit is waiting for you. Accept or reject it in Settings, Memory, Learn from chats.");
    expect(retro.textContent).toContain("Opinions was not changed.");
    expect(stage).toHaveBeenCalledTimes(1);
    const [edits, at] = stage.mock.calls[0] as unknown as [PendingEdit[], string];
    expect(edits.map((edit) => edit.text)).toEqual(["Keep the line short."]);
    expect(Number.isFinite(Date.parse(at))).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("by default it queues through the learn state only, and never saves a profile file", async () => {
    const commands: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      commands.push(command);
      if (command === "learn_state_load") return { revision: 3, state: {} };
      if (command === "learn_profile_load") return { opinions: "# Opinions\n", opinionsSha256: "sha" };
      if (command === "learn_state_cas") return true;
      throw new Error(`unexpected ${command}`);
    });
    await render({ lines: [...seed, line("2026-11-10", "feedback", "Keep the line short.")] });
    await click("Summarize the week");
    expect(container.querySelector("[data-retro]")!.textContent).toContain("1 edit is waiting for you.");
    expect(new Set(commands)).toEqual(new Set(["learn_profile_load", "learn_state_load", "learn_state_cas"]));
    expect(commands).not.toContain("learn_profile_save");
    expect(commands).not.toContain("learn_apply_edit");
  });

  it("says when the edits could not be queued, and still reports the week", async () => {
    const stage = vi.fn(async () => {
      throw new Error("raw failure");
    });
    await render({ lines: [...seed, line("2026-11-10", "feedback", "Keep the line short.")], stage });
    await click("Summarize the week");
    const retro = container.querySelector("[data-retro]")!;
    expect(retro.textContent).toContain("Shipped: 3.");
    expect(retro.textContent).toContain("The edits could not be queued. Try again.");
    expect(retro.textContent).not.toContain("raw failure");
    expect(retro.textContent).not.toContain("is waiting for you");
  });

  it("says why nothing new was queued", async () => {
    const stage = vi.fn(async (): Promise<StageOutcome> => ({ staged: 0, waiting: 0, declined: 1, present: 1, full: 0 }));
    await render({ lines: [...seed, line("2026-11-10", "feedback", "Keep the line short.")], stage });
    await click("Summarize the week");
    expect(container.querySelector("[data-retro]")!.textContent).toContain(
      "No new edits. The ones found were already saved or turned down.",
    );

    stage.mockResolvedValue({ staged: 0, waiting: 0, declined: 0, present: 0, full: 1 });
    await click("Summarize the week");
    expect(container.querySelector("[data-retro]")!.textContent).toContain(
      "Opinions is full. Remove or merge something there first.",
    );
  });

  it("a week with no corrections queues nothing", async () => {
    const stage = vi.fn(async () => queued);
    await render({ lines: seed, stage });
    await click("Summarize the week");
    expect(container.querySelector("[data-retro]")!.textContent).toContain("No corrections to review.");
    expect(stage).not.toHaveBeenCalled();
  });

  it("sent back and failed work is counted in the summary and never queued as an edit", async () => {
    const stage = vi.fn(async () => queued);
    await render({
      lines: [
        ...seed,
        line("2026-11-09", "outcome", "Sent back: The brief was wrong."),
        line("2026-11-10", "outcome", "Failed: The build broke."),
      ],
      stage,
    });
    await click("Summarize the week");
    const summary = container.querySelector("[data-retro]")!.textContent ?? "";
    expect(summary).toContain("Sent back: 1.");
    expect(summary).toContain("Failed: 1.");
    expect(summary).toContain("No corrections to review.");
    expect(summary).not.toContain("Check the brief");
    expect(summary).not.toContain("Say what broke");
    expect(stage).not.toHaveBeenCalled();
  });

  it("is a summary: no request text, and no claim that the first mate was asked", async () => {
    const stage = vi.fn(async () => queued);
    await render({ lines: [...seed, line("2026-11-10", "feedback", "Keep the line short.")], stage });
    await click("Summarize the week");
    const summary = container.querySelector("[data-retro]")!.textContent ?? "";
    expect(summary).not.toContain("Read the work log");
    expect(summary).not.toContain("Propose at most");
    expect(summary).not.toMatch(/first mate/i);
    expect(container.textContent).not.toContain("Run a retro");
    expect(container.textContent).not.toContain("Weekly retro");
  });

  it("the weekly routine is off, and turning it on does not ask", async () => {
    await render();
    const weekly = () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Summary every week")!;
    expect(weekly().getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      weekly().click();
    });
    expect(weekly().getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-retro]")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a weekly routine that is already due asks once, queues its edits and still applies nothing", async () => {
    localStorage.setItem(
      "monocode:work-log-weekly-retro",
      JSON.stringify({ enabled: true, lastAskedAt: null }),
    );
    const stage = vi.fn(async () => queued);
    await render({ lines: [...seed, line("2026-11-10", "feedback", "Keep the line short.")], stage });
    await act(async () => {
      await Promise.resolve();
    });
    const retro = container.querySelector("[data-retro]");
    expect(retro?.textContent).toContain("Shipped: 3.");
    expect(retro?.textContent).toContain("Opinions was not changed.");
    expect(stage).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem("monocode:work-log-weekly-retro") ?? "{}") as {
      enabled?: boolean;
      lastAskedAt?: string | null;
    };
    expect(saved.enabled).toBe(true);
    expect(saved.lastAskedAt).toEqual(expect.any(String));
  });

  it("a weekly routine whose edits could not be queued is not marked as asked", async () => {
    localStorage.setItem(
      "monocode:work-log-weekly-retro",
      JSON.stringify({ enabled: true, lastAskedAt: null }),
    );
    const stage = vi.fn(async () => {
      throw new Error("busy");
    });
    await render({ lines: [...seed, line("2026-11-10", "feedback", "Keep the line short.")], stage });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-retro]")?.textContent).toContain("The edits could not be queued. Try again.");
    const saved = JSON.parse(localStorage.getItem("monocode:work-log-weekly-retro") ?? "{}") as {
      lastAskedAt?: string | null;
    };
    expect(saved.lastAskedAt).toBeNull();
    expect(stage).toHaveBeenCalledTimes(1);
  });
});
