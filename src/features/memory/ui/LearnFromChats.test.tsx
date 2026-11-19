// @vitest-environment happy-dom
// WP-157: the edits a work log retro left waiting show in the learn screen, and the screen's own
// accept and reject decide them. A screen with no work log behind it shows none.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnFromChats, type LearnPorts, type ShownProposal } from "./LearnFromChats";

const WAITING: ShownProposal[] = [
  {
    id: "retro:one",
    title: "A correction from the week",
    diff: "+ Keep the line short.",
    quotes: [{ sessionId: "work log 2026-11-10", quote: "Keep the line short." }],
    note: "Agents will see this once a second log line backs it.",
  },
  {
    id: "retro:two",
    title: "Work sent back",
    diff: "+ Check the brief.",
    quotes: [
      { sessionId: "work log 2026-11-09", quote: "Sent back: The brief was wrong." },
      { sessionId: "work log 2026-11-10", quote: "Sent back: The brief was thin." },
    ],
  },
];

function ports(extra: Partial<LearnPorts> = {}): LearnPorts {
  return {
    cost: vi.fn(async () => 1200),
    run: vi.fn(async () => []),
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

describe("LearnFromChats, edits from the work log", () => {
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

  it("shows nothing extra when the screen has no work log behind it", async () => {
    await render(ports());
    expect(container.querySelector("[aria-label='From the work log']")).toBeNull();
    expect(container.textContent).not.toContain("From the work log");
  });

  it("lists the waiting edits with their log lines, and nothing is saved by showing them", async () => {
    const given = ports({ staged: vi.fn(async () => WAITING) });
    await render(given);
    const section = container.querySelector("[aria-label='From the work log']")!;
    expect(section.textContent).toContain("A retro suggested these. Nothing is saved until you accept one.");
    expect(section.textContent).toContain("A correction from the week");
    expect(section.textContent).toContain("+ Check the brief.");
    expect(section.textContent).toContain("Sent back: The brief was thin.");
    expect(section.textContent).toContain("Agents will see this once a second log line backs it.");
    expect(given.accept).not.toHaveBeenCalled();
    expect(given.reject).not.toHaveBeenCalled();
    expect(given.saveProfile).not.toHaveBeenCalled();
  });

  it("accept decides one edit through the screen's own accept, and the opinions box is read again", async () => {
    const given = ports({ staged: vi.fn(async () => WAITING) });
    await render(given);
    const reads = vi.mocked(given.loadProfiles).mock.calls.length;
    await act(async () => {
      button("Accept A correction from the week")!.click();
    });
    expect(given.accept).toHaveBeenCalledWith("retro:one");
    expect(container.textContent).not.toContain("A correction from the week");
    expect(container.textContent).toContain("Work sent back");
    expect(vi.mocked(given.loadProfiles).mock.calls.length).toBeGreaterThan(reads);
  });

  it("reject leaves the other edit waiting", async () => {
    const given = ports({ staged: vi.fn(async () => WAITING) });
    await render(given);
    await act(async () => {
      button("Reject Work sent back")!.click();
    });
    expect(given.reject).toHaveBeenCalledWith("retro:two");
    expect(container.textContent).not.toContain("+ Check the brief.");
    expect(container.textContent).toContain("A correction from the week");
  });

  it("a file that changed keeps the edit waiting and says so", async () => {
    const given = ports({ staged: vi.fn(async () => WAITING), accept: vi.fn(async () => false) });
    await render(given);
    await act(async () => {
      button("Accept Work sent back")!.click();
    });
    expect(container.textContent).toContain("That file changed. Try again.");
    expect(container.textContent).toContain("+ Check the brief.");
  });

  it("a refusal from the save is said in its own words and the edit stays", async () => {
    const given = ports({
      staged: vi.fn(async () => WAITING),
      accept: vi.fn(async () => {
        throw new Error("Opinions is full. Remove or merge something there first.");
      }),
    });
    await render(given);
    await act(async () => {
      button("Accept Work sent back")!.click();
    });
    expect(container.textContent).toContain("Opinions is full. Remove or merge something there first.");
    expect(container.textContent).toContain("+ Check the brief.");
  });

  it("a read that fails is said, and the rest of the screen still works", async () => {
    const given = ports({
      staged: vi.fn(async () => {
        throw new Error("timed out");
      }),
    });
    await render(given);
    expect(container.textContent).toContain("The edits from the work log could not be read. Try again.");
    expect(button("Learn from recent chats")).toBeTruthy();
  });
});
