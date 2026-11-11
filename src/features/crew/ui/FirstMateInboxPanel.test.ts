// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { queueHomeDecision, resetHomePending } from "../../home/model/pending";
import { FirstMateInboxPanel } from "./FirstMateInboxPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const PROJECT = "/work/proj";

function openDecision() {
  return {
    project: PROJECT,
    decisionKey: "ship",
    question: "Ship it now?",
    options: ["Ship it", "Wait"],
    recommended: "Ship it",
    state: "open",
    waiting: ["needs"],
    updatedAt: 1,
    version: 1,
  };
}

function answeredDecision() {
  return { ...openDecision(), state: "answered", answer: "Ship it", version: 2 };
}

function needsRow() {
  return {
    id: "needs",
    project: PROJECT,
    title: "Which name to ship",
    status: "needs-you",
    ownerSession: "lead",
    childSession: "chat-needs",
    createdAt: 1,
    updatedAt: 1,
  };
}

function shipButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Ship it"));
}

describe("first mate inbox panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation(async () => () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetHomePending();
    vi.unstubAllGlobals();
  });

  async function shown() {
    await act(async () => {
      root.render(createElement(FirstMateInboxPanel, { cwd: PROJECT }));
    });
    await vi.waitFor(() => expect(shipButton(container)).toBeTruthy());
  }

  it("selects the decision opened from home, and not the one beside it", async () => {
    queueHomeDecision(PROJECT, "ship");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "decisions_list") {
        return [openDecision(), { ...openDecision(), decisionKey: "font", question: "Which font?" }];
      }
      return [];
    });
    await act(async () => {
      root.render(createElement(FirstMateInboxPanel, { cwd: PROJECT }));
    });
    await vi.waitFor(() => expect(container.querySelector("[data-selected='true']")).toBeTruthy());
    const selected = container.querySelectorAll("[data-selected='true']");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain("Ship it now?");
    expect(selected[0]?.getAttribute("aria-current")).toBe("true");
  });

  it("keeps a timed-out decision open and tries the answer again", async () => {
    let answers = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "delegations_list_open" || cmd === "delegations_recent") return [needsRow()];
      if (cmd === "decisions_list") return [openDecision()];
      if (cmd === "decisions_answer") {
        answers += 1;
        throw new Error("timed out");
      }
      return [];
    });
    await shown();
    await act(async () => {
      shipButton(container)?.click();
    });
    await vi.waitFor(() => expect(answers).toBeGreaterThanOrEqual(3));
    expect(shipButton(container)).toBeTruthy();
    expect(answers).toBe(3);
  });

  it("reloads when an answer is refused, and does not put the open decision back", async () => {
    let answers = 0;
    let serverAnswered = false;
    const gates: Array<() => void> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "delegations_list_open" || cmd === "delegations_recent") return [needsRow()];
      if (cmd === "decisions_list") return [serverAnswered ? answeredDecision() : openDecision()];
      if (cmd === "decisions_answer") {
        answers += 1;
        const mine = answers;
        return new Promise((resolve) => {
          gates.push(() => {
            if (mine === 1) serverAnswered = true;
            resolve({
              applied: mine === 1,
              decision: mine === 1 ? answeredDecision() : openDecision(),
              released: [],
              releasedTasks: mine === 1 ? ["needs"] : [],
            });
          });
        });
      }
      return [];
    });
    await shown();
    const button = shipButton(container);
    await act(async () => {
      button?.click();
      button?.click();
    });
    expect(gates).toHaveLength(2);
    await act(async () => {
      gates[0]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      gates[1]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(shipButton(container)).toBeUndefined());
  });

  it("hides standing answers until the setting is on, and keeps them when a later read fails", async () => {
    const row = {
      project: PROJECT,
      decisionKey: "keep",
      standingId: "S-4",
      question: "Keep deleted sessions?",
      answer: "Keep",
      uses: 2,
    };
    let on = false;
    let lists = 0;
    const changed: Array<() => void> = [];
    vi.mocked(listen).mockImplementation(async (_event, fn) => {
      changed.push(fn as () => void);
      return () => {};
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "decisions_standing_enabled") return on;
      if (cmd === "decisions_reuse_list") {
        lists += 1;
        if (lists > 1) throw new Error("timed out");
        return [row];
      }
      return [];
    });
    await act(async () => {
      root.render(createElement(FirstMateInboxPanel, { cwd: PROJECT }));
    });
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.some((call) => call[0] === "decisions_standing_enabled")).toBe(true));
    expect(container.querySelector("[aria-label='Standing answers']")).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some((call) => call[0] === "decisions_reuse_list")).toBe(false);

    on = true;
    await act(async () => {
      changed.forEach((fn) => fn());
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Used 2 times"));

    await act(async () => {
      changed.forEach((fn) => fn());
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't load standing answers. Trying again."));
    expect(container.textContent).toContain("Used 2 times");
    expect(container.textContent).not.toMatch(/[—–]/);
  });
});
