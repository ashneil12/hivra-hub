// @vitest-environment happy-dom
// A learn run ends as one batch: a summary line, Accept all and Reject all, and each suggestion's
// own buttons. The cost shows before the run starts. Nothing is saved by showing any of it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnFromChats, type LearnPorts, type ShownProposal } from "./LearnFromChats";

const BATCH: ShownProposal[] = [
  { id: "opinions.md:a", title: "Small commits", diff: "+ Keep commits small.", quotes: [{ sessionId: "one", quote: "small" }] },
  { id: "opinions.md:b", title: "Test first", diff: "+ Write the test first.", quotes: [{ sessionId: "two", quote: "test" }] },
  { id: "voice.md:c", title: "Short lines", diff: "+ Keep lines short.", quotes: [{ sessionId: "three", quote: "short" }] },
];

function ports(extra: Partial<LearnPorts> = {}): LearnPorts {
  return {
    cost: vi.fn(async () => 1200),
    run: vi.fn(async () => ({ proposals: BATCH, chats: 60 })),
    accept: vi.fn(async () => true),
    reject: vi.fn(async () => true),
    loadProfiles: vi.fn(async () => ({ opinions: "# Opinions\n", voice: "", opinionsSha256: "a", voiceSha256: "b" })),
    saveProfile: vi.fn(async () => true),
    schedule: vi.fn(async () => ({ weekly: false, lastOfferedAt: null })),
    setWeekly: vi.fn(async () => true),
    markOffered: vi.fn(async () => true),
    ...extra,
  };
}

describe("LearnFromChats, one batch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(given: LearnPorts) {
    await act(async () => {
      root.render(createElement(LearnFromChats, { ports: given, now: () => Date.parse("2026-11-10T00:00:00.000Z") }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function button(name: string) {
    return [...container.querySelectorAll("button")].find((node) => node.textContent === name);
  }

  async function press(name: string) {
    await act(async () => {
      button(name)!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("shows the estimate with the model, and what was left out, before the run", async () => {
    await render(
      ports({
        estimate: vi.fn(async () => ({
          chats: 60,
          tokens: 70_000,
          model: "Claude Code (claude-haiku-4-5)",
          leftOut: 12_000,
          tooBig: 1,
        })),
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("This reads 60 chats, about 70,000 tokens, with Claude Code (claude-haiku-4-5).");
    expect(text).toContain("12,000 older chats were left out.");
    expect(text).toContain("1 chat was too big to read.");
    expect(button("Learn from recent chats")!.disabled).toBe(false);
  });

  it("falls back to the plain cost when the screen has no estimate", async () => {
    await render(ports());
    expect(container.textContent).toContain("This sends about 1,200 tokens.");
  });

  it("ends the run as one batch with a summary line and nothing saved yet", async () => {
    const given = ports();
    await render(given);
    expect(container.textContent).not.toContain("Accept all");
    await press("Learn from recent chats");
    expect(container.querySelector("[data-testid='learn-batch-summary']")!.textContent).toBe("3 suggested rules from 60 chats");
    expect(button("Accept all")).toBeTruthy();
    expect(button("Reject all")).toBeTruthy();
    expect(button("Accept Small commits")).toBeTruthy();
    expect(button("Reject Short lines")).toBeTruthy();
    expect(given.accept).not.toHaveBeenCalled();
    expect(given.reject).not.toHaveBeenCalled();
  });

  it("still takes a plain list from a run that did not count its chats", async () => {
    await render(ports({ run: vi.fn(async () => BATCH.slice(0, 1)) }));
    await press("Learn from recent chats");
    expect(container.querySelector("[data-testid='learn-batch-summary']")!.textContent).toBe("1 suggested rule");
  });

  it("Accept all sends each suggestion through the screen's own accept, in order", async () => {
    const given = ports();
    await render(given);
    await press("Learn from recent chats");
    await press("Accept all");
    expect(vi.mocked(given.accept).mock.calls.map(([id]) => id)).toEqual(["opinions.md:a", "opinions.md:b", "voice.md:c"]);
    expect(given.reject).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='learn-batch-summary']")).toBeNull();
    expect(container.textContent).toContain("Accepted 3.");
  });

  it("keeps a suggestion that is refused in the list and says so, and goes on with the rest", async () => {
    const given = ports({
      accept: vi.fn(async (id: string) => {
        if (id === "opinions.md:b") throw new Error("That edit looks like it contains a secret, so it was not saved.");
        return id !== "voice.md:c";
      }),
    });
    await render(given);
    await press("Learn from recent chats");
    await press("Accept all");
    expect(given.accept).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("Accepted 1. 2 could not be saved and are still listed.");
    expect(container.textContent).toContain("contains a secret");
    expect(button("Accept Test first")).toBeTruthy();
    expect(button("Accept Short lines")).toBeTruthy();
    expect(button("Accept Small commits")).toBeUndefined();
  });

  it("Reject all sends each one through the screen's own reject, so each is remembered", async () => {
    const given = ports();
    await render(given);
    await press("Learn from recent chats");
    await press("Reject all");
    expect(vi.mocked(given.reject).mock.calls.map(([id]) => id)).toEqual(["opinions.md:a", "opinions.md:b", "voice.md:c"]);
    expect(given.accept).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Rejected 3.");
  });

  it("the per-item buttons still decide one suggestion and leave the batch", async () => {
    const given = ports();
    await render(given);
    await press("Learn from recent chats");
    await press("Reject Test first");
    expect(given.reject).toHaveBeenCalledWith("opinions.md:b");
    expect(container.querySelector("[data-testid='learn-batch-summary']")!.textContent).toBe("2 suggested rules from 60 chats");
  });

  it("shows a batch a run started elsewhere left waiting", async () => {
    await render(ports({ batch: () => ({ proposals: BATCH, chats: 41 }) }));
    expect(container.querySelector("[data-testid='learn-batch-summary']")!.textContent).toBe("3 suggested rules from 41 chats");
  });
});
