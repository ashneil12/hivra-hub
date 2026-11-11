// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StandingAnswers, type RetireResult, type StandingAnswer } from "./StandingAnswers";

const keep: StandingAnswer = {
  project: "/work/proj",
  key: "keep",
  standingId: "S-4",
  question: "Keep deleted sessions — or delete them?",
  answer: "Keep them for 30 days.",
  uses: 2,
};

const logo: StandingAnswer = {
  project: "/work/proj",
  key: "logo",
  standingId: "S-9",
  question: "What colour is the logo?",
  answer: "Blue.",
  uses: 1,
};

describe("standing answers", () => {
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

  async function show(props: Parameters<typeof StandingAnswers>[0]) {
    await act(async () => {
      root.render(createElement(StandingAnswers, props));
    });
  }

  function button(name: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find((item) => item.textContent === name);
  }

  it("stays hidden while the setting is off", async () => {
    await show({ enabled: false, rows: [keep] });
    expect(container.textContent).toBe("");
    expect(container.querySelector("[aria-label='Standing answers']")).toBeNull();
  });

  it("shows the use count, and a failed load is not an empty list", async () => {
    await show({ enabled: true, rows: [keep, logo], stale: true });
    expect(container.textContent).toContain("Used 2 times");
    expect(container.textContent).toContain("Used 1 time");
    expect(container.textContent).toContain("Couldn't load standing answers. Trying again.");
    expect(container.textContent).toContain("Keep deleted sessions, or delete them?");
    expect(container.textContent).not.toMatch(/[—–]/);
  });

  it("asks for a reason before it retires, then lists who relied on it", async () => {
    const onRetire = vi.fn(async (): Promise<RetireResult> => ({ applied: true, relied: ["task-1", "task-2", "task-1"] }));
    await show({ enabled: true, rows: [keep, logo], onRetire });
    await act(async () => {
      button("Retire")?.click();
    });
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    expect(onRetire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Say why, in a short line.");

    const input = container.querySelector("input");
    expect(input).toBeTruthy();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "   ");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    expect(onRetire).not.toHaveBeenCalled();

    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "x".repeat(301));
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    expect(onRetire).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Keep the reason to 300 characters.");

    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "The rule changed.");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    expect(onRetire).toHaveBeenCalledWith(keep, "The rule changed.");
    const retired = container.querySelector("[data-standing-retired='true']");
    expect(retired?.textContent).toContain("Retired.");
    expect(retired?.textContent).toContain("Tasks that relied on this");
    expect(retired?.textContent).toContain("task-1");
    expect(retired?.textContent).toContain("task-2");
    expect(retired?.querySelectorAll("[data-relied]")).toHaveLength(2);
    expect(container.querySelector("[data-standing-key='logo']")).toBeTruthy();
    expect(container.textContent).not.toMatch(/[—–]/);
  });

  it("says when it was already retired, and when the answer is gone", async () => {
    const onRetire = vi
      .fn()
      .mockResolvedValueOnce({ applied: false, relied: [] } satisfies RetireResult)
      .mockResolvedValueOnce({ applied: false, gone: true, relied: [] } satisfies RetireResult);
    await show({ enabled: true, rows: [keep, logo], onRetire });
    async function retire(name: string) {
      const row = [...container.querySelectorAll("article")].find((item) => item.textContent?.includes(name));
      await act(async () => {
        [...row!.querySelectorAll("button")].find((item) => item.textContent === "Retire")?.click();
      });
      const input = row!.querySelector("input")!;
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(input, "Done.");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        row!.querySelector("form")?.requestSubmit();
      });
    }
    await retire("Keep deleted");
    expect(container.textContent).toContain("Already retired.");
    expect(container.textContent).toContain("No task relied on this.");
    await retire("logo");
    expect(container.textContent).toContain("That answer is gone.");
  });

  it("keeps the answer when retire or reuse does not land", async () => {
    const onRetire = vi.fn(async () => {
      throw new Error("timed out");
    });
    const onReuse = vi.fn(async () => false);
    await show({ enabled: true, rows: [keep, logo], onRetire, onReuse });
    await act(async () => {
      button("Retire")?.click();
    });
    const input = container.querySelector("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Try.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    expect(container.textContent).toContain("Couldn't retire this. Trying again.");
    expect(container.querySelector("[data-standing-key='keep']")).toBeTruthy();

    const logoRow = container.querySelector("[data-standing-key='logo']")!;
    const box = logoRow.querySelector("input[type='checkbox']") as HTMLInputElement;
    await act(async () => {
      box.click();
    });
    expect(onReuse).toHaveBeenCalledWith(logo, true);
    expect(container.textContent).toContain("Couldn't update this. Trying again.");
    expect(container.querySelector("[data-standing-key='logo']")).toBeTruthy();
    expect(container.querySelector("[data-standing-key='keep']")?.textContent).not.toContain("Couldn't update this");
  });

  it("ticks reuse for one answer and leaves both on the list", async () => {
    const onReuse = vi.fn(async () => true);
    await show({ enabled: true, rows: [{ ...keep, standing: true }, logo], onReuse });
    expect(container.textContent).toContain(
      "A ticked answer is reused for similar questions. It is guidance, not permission.",
    );
    const keepBox = container.querySelector("[data-standing-key='keep'] input[type='checkbox']") as HTMLInputElement;
    const logoBox = container.querySelector("[data-standing-key='logo'] input[type='checkbox']") as HTMLInputElement;
    expect(keepBox.checked).toBe(true);
    expect(logoBox.checked).toBe(false);
    await act(async () => {
      logoBox.click();
    });
    expect(onReuse).toHaveBeenCalledWith(logo, true);
    await act(async () => {
      keepBox.click();
    });
    expect(onReuse).toHaveBeenCalledWith({ ...keep, standing: true }, false);
    expect(container.querySelector("[data-standing-key='logo']")).toBeTruthy();
    expect(container.querySelector("[data-standing-key='keep']")).toBeTruthy();
    expect(container.textContent).not.toMatch(/[—–]/);
  });

  it("does not retire twice from a double click", async () => {
    let finish: (result: RetireResult) => void = () => {};
    const onRetire = vi.fn(
      () =>
        new Promise<RetireResult>((resolve) => {
          finish = resolve;
        }),
    );
    await show({ enabled: true, rows: [keep], onRetire });
    await act(async () => {
      button("Retire")?.click();
    });
    const input = container.querySelector("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Once.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const form = container.querySelector("form");
      form?.requestSubmit();
      form?.requestSubmit();
    });
    expect(onRetire).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ applied: true, relied: ["task-1"] });
    });
    expect(container.querySelectorAll("[data-standing-retired='true']")).toHaveLength(1);
  });

  it("ignores a retire that lands after a newer click", async () => {
    let finish: (result: RetireResult) => void = () => {};
    const onRetire = vi.fn(
      () =>
        new Promise<RetireResult>((resolve) => {
          finish = resolve;
        }),
    );
    await show({ enabled: true, rows: [keep], onRetire });
    await act(async () => {
      button("Retire")?.click();
    });
    const input = container.querySelector("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Old.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")?.requestSubmit();
    });
    await act(async () => {
      button("Cancel")?.click();
    });
    await act(async () => {
      finish({ applied: true, relied: ["task-late"] });
    });
    expect(container.textContent).not.toContain("task-late");
    expect(container.querySelector("[data-standing-retired='true']")).toBeNull();
    expect(container.querySelector("[data-standing-key='keep']")).toBeTruthy();
  });
});
