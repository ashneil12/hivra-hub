// @vitest-environment happy-dom
// r70b (Critiquito): a stuck worker only Ash can unstick (kept out of the "N workers stopped" fold) reads like a red row:
// neutral card, 2px red left bar, red Needs you word (~#ff6b6b); never a red card.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEEDS_YOU_RED, redRowProps } from "../../hub/ui/StatusMark";
import { StuckList } from "./StuckWorkerCard";

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

const now = Date.now();
const worker = (id: string, extra: Record<string, unknown>) =>
  ({
    kind: "failed",
    line: "x",
    since: now - 60_000,
    escalated: true,
    key: id,
    row: { id: `t-${id}`, childSession: id, ownerSession: "lead", title: `Job ${id}`, state: "failed", createdAt: now - 120_000, settledAt: now - 60_000, log: [], ...extra },
  }) as never;

describe("r70b: a red stuck card is a red row, not a red card", () => {
  it("the red card has the bar and the red word, a neutral background; a grey card has no bar", () => {
    const red = worker("r", { errorClass: "billing", error: "Your credit balance is too low" });
    const grey = worker("g", { error: "Disk full." });
    act(() => root.render(createElement(StuckList, { stuck: [red, grey], now, variant: "chat" })));
    const card = container.querySelector<HTMLElement>('[data-stuck-worker="r"]')!;
    expect(card).not.toBeNull();
    expect(card.hasAttribute("data-hub-red-row")).toBe(true);
    expect(card.style.boxShadow).toContain("inset 2px 0 0 rgb(239 68 68)");
    expect(card.className).not.toMatch(/bg-red|border-red/);
    expect(card.className).toContain("bg-background-base/95");
    const word = card.querySelector<HTMLElement>('[data-hub-chip="Needs you"]')!;
    expect(word.style.color.replace(/\s/g, "")).toMatch(/#ff6b6b|rgb\(255,107,107\)/i);
    // The grey one is folded away; opened, it has no bar.
    act(() => container.querySelector<HTMLButtonElement>("[data-stuck-stopped-toggle]")!.click());
    expect(container.querySelector('[data-stuck-worker="g"]')!.hasAttribute("data-hub-red-row")).toBe(false);
  });

  it("the bar keeps the pinned card's drop shadow", () => {
    expect(redRowProps(true, "0 1px 2px black").style!.boxShadow).toBe("inset 2px 0 0 rgb(239 68 68), 0 1px 2px black");
    expect(NEEDS_YOU_RED).toBe("#ff6b6b");
  });
});
