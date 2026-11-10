// @vitest-environment happy-dom
// WP-176: the one line a person sees for a measured-cost limit.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSession } from "../model/history";
import { resetSpendGate, saveSpendLimit, setSpendClock, setSpendProjectLookup, setSpendSessions } from "../model/spendGate";
import { SpendLimitLine } from "./SpendLimitLine";

const month = Date.parse("2026-11-10T15:00:00");

function sessions(costUsd: number): UsageSession[] {
  return [
    {
      id: "chat",
      cwd: "/work/monocode-hub",
      harness: "claude",
      model: "opus",
      blocks: [{ id: "t1", role: "user", startedAt: month, turnMetrics: { costUsd, inputTokens: 10 } }],
    },
  ];
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetSpendGate();
  setSpendClock(() => month);
  setSpendProjectLookup({
    idOf: (folder) => (folder === "/work/monocode-hub" ? "hivra" : undefined),
    folderOf: (id) => (id === "hivra" ? "/work/monocode-hub" : undefined),
  });
  setSpendSessions([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(props: Partial<Parameters<typeof SpendLimitLine>[0]> = {}) {
  act(() => {
    root.render(createElement(SpendLimitLine, { project: "hivra", ...props }));
  });
}

describe("the spend limit line", () => {
  it("says nothing is set until the person sets one, then names the measured cost", () => {
    draw();
    expect(container.querySelector("[data-spend-line]")?.textContent).toBe("No spend limit is set.");
    expect(container.querySelector("[data-setting-id='spend-limit']")).toBeNull();
    setSpendSessions(sessions(12.4));
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 }, 0);
    draw();
    expect(container.querySelector("[data-spend-line]")?.textContent).toBe(
      "Spent $12.40 of $50 this month (25%). New builders pause at $50.",
    );
    expect(container.textContent).not.toMatch(/[—–]/);
    expect(container.textContent).not.toMatch(/your bill/i);
  });

  it("says a CLI that reports no cost cannot be counted", () => {
    setSpendSessions(sessions(12.4));
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 }, 0);
    draw({ harness: "codex" });
    expect(container.querySelector("[data-spend-line]")?.textContent).toBe(
      "This CLI reports no cost, so this limit cannot count its work.",
    );
  });

  it("shows an app limit when this project has none, and a blank amount clears only this project", () => {
    saveSpendLimit({ scope: "app", period: "month", amountUsd: 20, warnAt: 0.8, project: "" }, 0);
    setSpendSessions(sessions(0));
    draw({ indexed: true });
    expect(container.querySelector("[data-setting-id='spend-limit']")?.textContent).toContain(
      "Spent $0 of $20 this month (0%). New builders pause at $20.",
    );
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const fill = (value: string) => {
      const amount = container.querySelector<HTMLInputElement>("[data-spend-amount]")!;
      act(() => {
        amount.focus();
        setValue.call(amount, value);
        amount.dispatchEvent(new Event("input", { bubbles: true }));
        amount.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
    };
    expect(container.querySelector<HTMLInputElement>("[data-spend-amount]")!.value).toBe("");
    fill("0");
    expect(container.querySelector("[data-spend-line]")?.textContent).toContain("$20");
    fill("10");
    expect(container.querySelector("[data-spend-line]")?.textContent).toContain("$10");
    fill("");
    expect(container.querySelector("[data-spend-line]")?.textContent).toContain("$20");
  });
});
