// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resetHomePending } from "../../home/model/pending";
import { FirstMateInboxPanel } from "./FirstMateInboxPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const PROJECT = "/work/proj";
const CHANGED = "That card changed after you read it, so the answer was not recorded. Read it again and answer.";

function secretCard(version: number) {
  return {
    project: PROJECT,
    decisionKey: "secret/stripe-api-key/9f",
    question: "Let Tally run `/usr/bin/curl` with Stripe?\nCommand: /usr/bin/curl https://example.test",
    options: ["Once", "No"],
    recommended: "Once",
    state: "open",
    waiting: ["needs"],
    updatedAt: 1,
    version,
  };
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

function onceButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Once"));
}

describe("a secret card answer keeps the version that was tapped", () => {
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
    resetHomePending();
    vi.unstubAllGlobals();
  });

  async function shown(card: ReturnType<typeof secretCard>) {
    await act(async () => {
      root.render(createElement(FirstMateInboxPanel, { cwd: PROJECT }));
    });
    await vi.waitFor(() => expect(onceButton(container)).toBeTruthy());
    return card;
  }

  it("does not retry a card that changed, and a later tap sends the new version", async () => {
    const card = secretCard(1);
    const seen: number[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "delegations_list_open" || cmd === "delegations_recent") return [needsRow()];
      if (cmd === "decisions_list") return [card];
      if (cmd === "decisions_answer") {
        seen.push(Number(args?.seenVersion));
        card.version = 2;
        throw new Error(CHANGED);
      }
      return [];
    });
    await shown(card);
    await act(async () => {
      onceButton(container)?.click();
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen).toEqual([1]);
    expect(onceButton(container)).toBeTruthy();
    await act(async () => {
      onceButton(container)?.click();
    });
    await vi.waitFor(() => expect(seen.length).toBe(2));
    expect(seen).toEqual([1, 2]);
  });

  it("retries a timeout with the version from the tap, not a version that arrived later", async () => {
    const card = secretCard(1);
    const seen: number[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "delegations_list_open" || cmd === "delegations_recent") return [needsRow()];
      if (cmd === "decisions_list") return [card];
      if (cmd === "decisions_answer") {
        seen.push(Number(args?.seenVersion));
        card.version = 2;
        throw new Error("timed out");
      }
      return [];
    });
    await shown(card);
    await act(async () => {
      onceButton(container)?.click();
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(3));
    expect(seen).toEqual([1, 1, 1]);
    expect(onceButton(container)).toBeTruthy();
  });
});
