// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSession } from "../model/history";
import { UsagePage } from "./UsagePage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const NOW = new Date(2026, 10, 6, 15).getTime();
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();

function session(
  id: string,
  cwd: string,
  harness: string,
  model: string,
  blocks: UsageSession["blocks"],
): UsageSession {
  return { id, cwd, harness, model, blocks };
}

const secret = "my bank password is hunter2";

/** A block plus a prompt. The extra field is what the page must not show. */
function leaked(block: UsageSession["blocks"][number], text: string): UsageSession["blocks"][number] {
  return { ...block, text } as UsageSession["blocks"][number];
}

function seeded(): UsageSession[] {
  return [
    session("s1", "/work/secret-project", "claude", "sonnet-5", [
      leaked(
        {
          id: "b1",
          role: "user",
          startedAt: at(6, 9),
          turnMetrics: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
          turnModel: { harness: "claude", name: "sonnet-5" },
        },
        secret,
      ),
      {
        id: "late",
        role: "user",
        startedAt: at(5, 23, 50),
        turnMetrics: { inputTokens: 1_000 },
      },
    ]),
    session("s2", "/work/lib", "codex", "gpt-5", [
      leaked(
        {
          id: "b1",
          role: "user",
          startedAt: at(6, 10),
          turnMetrics: { inputTokens: 40, outputTokens: 8 },
          turnModel: { harness: "codex", name: "gpt-5" },
        },
        "the reply that must not travel",
      ),
    ]),
  ];
}

describe("UsagePage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset().mockImplementation(async () => undefined);
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(props: { sessions?: UsageSession[]; now?: number } = {}) {
    await act(async () => {
      root.render(createElement(UsagePage, props));
    });
  }

  const NOTE = "Estimated cost is what the same use would cost at API prices";

  /** How many times the page-level estimate note is drawn. */
  function noteCount(): number {
    return [...container.querySelectorAll("p")].filter((item) => item.textContent?.includes(NOTE)).length;
  }

  /** Every leaf element that shows a dollar figure. */
  function dollarFigures(): Element[] {
    return [...container.querySelectorAll("*")].filter(
      (element) => element.children.length === 0 && /\$\d/.test(element.textContent ?? ""),
    );
  }

  it("shows today, the last 7 days and the last 30 days, and never the prompt", async () => {
    await render({ sessions: seeded(), now: NOW });

    expect(invoke).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Today");
    expect(container.textContent).toContain("Last 7 days");
    expect(container.textContent).toContain("Last 30 days");
    expect(container.textContent).toContain("secret-project");
    expect(container.textContent).toContain("lib");
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("sonnet-5");
    expect(container.textContent).toContain("gpt-5");
    expect(container.textContent).toContain("$0.50");
    expect(container.textContent).toContain("Estimated cost");
    expect(container.textContent).toContain("what the same use would cost at API prices");
    expect(container.textContent).toContain("flat fee");
    expect(container.textContent).not.toContain("estimated, not your bill");
    expect(container.textContent).toContain("Cost reported for 1 of 2 turns");
    expect(container.textContent).toContain("Cost not reported by this engine");
    expect(container.textContent).not.toContain(secret);
    expect(container.textContent).not.toContain("must not travel");
    expect(container.textContent).not.toContain("/work/");

    const nov5 = container.querySelector('[data-usage-day="2026-11-05"]');
    expect(nov5?.getAttribute("aria-label")).toMatch(/5 Nov/);
    expect(nov5?.getAttribute("aria-label")).toMatch(/tokens/);
  });

  it("says when the last 30 days have no turns", async () => {
    await render({ sessions: [], now: NOW });
    expect(container.textContent).toContain("No turns in the last 30 days.");
    expect(container.textContent).toContain("No turns yet");
    expect(container.textContent).not.toContain("estimated, not your bill");
  });

  it("shows a dollar figure plain under the one page note, and leaves an unpriced engine alone", async () => {
    await render({
      sessions: [
        session("priced", "/work/priced", "claude", "sonnet-5", [
          {
            id: "b1",
            role: "user",
            startedAt: at(6, 9),
            turnMetrics: { inputTokens: 10, outputTokens: 2, costUsd: 1.25 },
          },
        ]),
        session("plain", "/work/plain", "codex", "gpt-5", [
          {
            id: "b1",
            role: "user",
            startedAt: at(6, 10),
            turnMetrics: { inputTokens: 8, outputTokens: 1 },
          },
        ]),
      ],
      now: NOW,
    });
    const priced = [...container.querySelectorAll("td")].filter((cell) =>
      cell.textContent?.includes("$1.25"),
    );
    expect(priced.length).toBeGreaterThan(0);
    for (const cell of priced) expect(cell.textContent).toBe("$1.25");
    const unpriced = [...container.querySelectorAll("td")].find((cell) =>
      cell.textContent?.includes("Cost not reported by this engine"),
    );
    expect(unpriced?.textContent).toBe("Cost not reported by this engine");
    expect(noteCount()).toBe(1);
  });

  it("does not repeat the estimate label next to the page note", async () => {
    // The seeded history has a fully priced turn and a partly priced window, so both cost shapes are on the page.
    await render({ sessions: seeded(), now: NOW });
    expect(noteCount()).toBe(1);
    const figures = dollarFigures();
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(figure.textContent).not.toMatch(/estimat/i);
      expect(figure.textContent).not.toMatch(/not your bill/i);
    }
    expect(container.textContent).not.toContain("estimated, not your bill");
    // The cost column heading and the note say it once, in the page's own words.
    expect(container.textContent?.match(/not your bill/g)).toHaveLength(1);
  });

  it("draws a dollar figure only where the page note is drawn", async () => {
    await render({ sessions: [], now: NOW });
    expect(dollarFigures()).toEqual([]);
    expect(noteCount()).toBe(0);
    await render({ sessions: seeded(), now: NOW });
    expect(dollarFigures().length).toBeGreaterThan(0);
    expect(noteCount()).toBe(1);
  });

  it("copies the history as CSV", async () => {
    await render({ sessions: seeded(), now: NOW });
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Copy as CSV"),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const csv = String(writeText.mock.calls[0]?.[0]);
    expect(csv.startsWith("Group,Name,Day,Turns,")).toBe(true);
    expect(csv).toContain("secret-project");
    expect(csv).not.toContain(secret);
    expect(csv).not.toContain("/work/");
    expect(container.textContent).toContain("Copied");
  });

  it("says when the copy did not work", async () => {
    writeText.mockRejectedValue(new Error("no clipboard"));
    document.execCommand = () => false;
    await render({ sessions: seeded(), now: NOW });
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Copy as CSV"),
    );
    await act(async () => {
      button!.click();
    });
    expect(container.textContent).toContain("Could not copy");
  });

  it("loads from the app, and a reply that is not a list is not an empty history", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        id: "s1",
        cwd: "/work/app",
        harness: "claude",
        model: "sonnet-5",
        blocks: [
          {
            id: "b1",
            role: "user",
            text: secret,
            startedAt: NOW,
            turnMetrics: { inputTokens: 12, costUsd: 0.25 },
          },
        ],
      },
    ]);
    await render({ now: NOW });
    expect(container.textContent).toContain("app");
    expect(container.textContent).toContain("$0.25");
    expect(container.textContent).not.toContain(secret);

    vi.mocked(invoke).mockResolvedValue({ rows: [] });
    await render({ now: NOW + 1 });
    expect(container.textContent).toContain("Could not load the latest usage.");
    expect(container.textContent).toContain("app");
    expect(container.textContent).not.toContain("No turns in the last 30 days.");
  });

  it("shows a failed first load as a failure, with a retry", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("timed out"));
    await render({ now: NOW });
    expect(container.textContent).toContain("Could not load usage.");
    expect(container.textContent).not.toContain("No turns in the last 30 days.");

    vi.mocked(invoke).mockResolvedValue([]);
    const again = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Try again"),
    );
    await act(async () => {
      again!.click();
    });
    expect(container.textContent).toContain("No turns in the last 30 days.");
    expect(container.textContent).not.toContain("Could not load usage.");
  });

  it("drops a late result once a newer load has won", async () => {
    let resolveFirst: (rows: unknown) => void = () => undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    vi.mocked(invoke).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return first;
      return [
        {
          id: "newer",
          cwd: "/work/newer",
          harness: "claude",
          model: "sonnet-5",
          blocks: [
            { id: "b1", role: "user", startedAt: NOW + 1, turnMetrics: { inputTokens: 3 } },
          ],
        },
      ];
    });

    await render({ now: NOW });
    expect(container.textContent).toContain("Loading usage.");

    await render({ now: NOW + 1 });
    expect(container.textContent).toContain("newer");

    await act(async () => {
      resolveFirst([
        {
          id: "older",
          cwd: "/work/older",
          harness: "claude",
          model: "sonnet-5",
          blocks: [
            { id: "b1", role: "user", startedAt: NOW, turnMetrics: { inputTokens: 9 } },
          ],
        },
      ]);
      await first;
    });
    expect(container.textContent).toContain("newer");
    expect(container.textContent).not.toContain("older");
  });

  function pick(select: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("filters by provider and model, and starts on all", async () => {
    await render({ sessions: seeded(), now: NOW });
    const provider = container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
    expect(provider.value).toBe("");
    expect(model.value).toBe("");
    expect([...provider.options].map((option) => option.text)).toEqual(["All", "Claude Code", "Codex"]);
    expect([...model.options].map((option) => option.text)).toEqual(["All", "gpt-5", "sonnet-5"]);

    await act(async () => pick(provider, "codex"));
    expect(container.textContent).toContain("gpt-5");
    expect(container.textContent).not.toContain("sonnet-5");
    expect(container.textContent).not.toContain("secret-project");
    expect(
      [...container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.options].map(
        (option) => option.value,
      ),
    ).toEqual(["", "gpt-5"]);

    await act(async () => pick(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!, ""));
    await act(async () => pick(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!, "sonnet-5"));
    const modelTable = [...container.querySelectorAll("table")].find(
      (table) => table.querySelector("caption")?.textContent === "By model",
    );
    expect(modelTable?.textContent).toContain("sonnet-5");
    expect(modelTable?.textContent).not.toContain("gpt-5");

    await act(async () => pick(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!, "codex"));
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.value).toBe("");
    expect(container.textContent).toContain("gpt-5");
    expect(container.textContent).not.toContain("sonnet-5");
  });

  it("says when the chosen filter has no turns in the window", async () => {
    await render({
      sessions: [
        session("old", "/work/old", "grok", "grok-1", [
          {
            id: "b",
            role: "user",
            startedAt: new Date(2020, 0, 1).getTime(),
            turnMetrics: { inputTokens: 4 },
            turnModel: { harness: "grok", name: "grok-1" },
          },
        ]),
        ...seeded(),
      ],
      now: NOW,
    });
    await act(async () =>
      pick(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!, "grok"),
    );
    expect(container.textContent).toContain("No turns for this filter.");
    expect(container.textContent).not.toContain("No turns in the last 30 days.");
    expect(container.textContent).not.toContain("secret-project");
  });
});
