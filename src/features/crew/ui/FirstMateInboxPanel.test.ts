// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function shown() {
    await act(async () => {
      root.render(createElement(FirstMateInboxPanel, { cwd: PROJECT }));
    });
    await vi.waitFor(() => expect(shipButton(container)).toBeTruthy());
  }

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
});
