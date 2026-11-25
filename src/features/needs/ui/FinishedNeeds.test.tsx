// @vitest-environment happy-dom
// Finished rows leave the flow for one named place (Ash, 13 Nov: "when they resolve, they can just go into their own
// pile that is like out of the way"): a folded "Finished" line with a count at the bottom of the Needs you list and of
// the roll-up, opening in place, and a row he cannot tick done finished from the row itself.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InlineNeed, NeedsRollupCard } from "../../asks/ui/InlineNeed";
import type { NeedsItem } from "../model/needsYou";
import { resetNeedsLiveForTest } from "../model/needsLive";
import { dismissNeed, foldedLine, resetSettledNeedsForTest, settledRows } from "../model/settledNeeds";
import { FinishedNeeds } from "./FinishedNeeds";
import { InboxNeeds } from "./InboxNeeds";
import { NeedDetail } from "./NeedDetail";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resetSettledNeedsForTest();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
  resetSettledNeedsForTest();
});

function need(patch: Partial<NeedsItem> = {}): NeedsItem {
  return {
    key: "question:take",
    kind: "question",
    who: "Example lead",
    at: 10 * HOUR,
    sentence: "Example: which take goes in the trailer?",
    actions: [],
    open: { where: "chat", id: "lead-chat" },
    ...patch,
  };
}

async function show(element: ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

function byText(label: string): HTMLElement | undefined {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(label)) as HTMLElement | undefined;
}

describe("the Finished pile", () => {
  it("is one folded line with a count, and opens its rows in place", async () => {
    dismissNeed(need(), NOW - HOUR);
    dismissNeed(need({ key: "question:other", sentence: "Example: which of the two fonts?" }), NOW);
    await show(<FinishedNeeds />);
    const toggle = container.querySelector("[data-finished-toggle]") as HTMLButtonElement;
    expect(toggle.textContent).toContain("Finished");
    expect(toggle.textContent).toContain("2");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-finished-need]")).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const rows = [...container.querySelectorAll("[data-finished-need]")];
    expect(rows).toHaveLength(2);
    // Newest first, each saying which of the three happened.
    expect(rows[0].textContent).toContain("Example: which of the two fonts?");
    expect(rows[0].textContent).toContain("You let it go.");
  });

  it("says nothing at all when nothing has finished", async () => {
    await show(<FinishedNeeds />);
    expect(container.querySelector("[data-finished-toggle]")).toBeNull();
  });

  it("sits at the bottom of the Needs you list, after the rows above it", async () => {
    dismissNeed(need(), NOW - HOUR);
    await show(<InboxNeeds pick={{ picked: null, firstWhenNone: true, onPick: () => undefined }} />);
    expect(container.querySelectorAll("[data-finished-toggle]")).toHaveLength(1);
    const fold = container.querySelector("[data-finished-toggle]");
    expect(container.lastElementChild?.contains(fold)).toBe(true);
    const empty = container.querySelector("[data-inbox-needs-empty]");
    expect(empty).not.toBeNull();
    expect(empty!.compareDocumentPosition(fold!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the roll-up in the Chief of Staff's chat", () => {
  it("ends with the same folded line", async () => {
    dismissNeed(need(), NOW - HOUR);
    await show(<NeedsRollupCard card={{ items: [{ key: "question:take", sentence: "Example: which take?", yours: false }], more: 0 }} />);
    expect(container.querySelectorAll("[data-finished-toggle]")).toHaveLength(1);
  });
});

describe("a row he cannot tick done", () => {
  it("is finished from its own card, and the record says he let it go", async () => {
    await show(<NeedDetail item={need()} now={NOW} />);
    const button = byText("Let it go");
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(settledRows()[0]).toMatchObject({ key: "question:take", reason: "letgo" });
    expect(foldedLine("question:take", "Example: which take goes in the trailer?")).toBe("You let it go.");
  });

  it("folds to the reason it went, never to 'no longer needs you'", async () => {
    dismissNeed(need(), NOW - HOUR);
    await show(<InlineNeed needKey="question:take" label="Example: which take goes in the trailer?" />);
    const line = container.querySelector("[data-inline-need='settled']");
    expect(line?.textContent).toBe("You let it go.");
  });
});

describe("a question row in the Inbox", () => {
  it("is finished from the row itself, and goes to the Finished pile", async () => {
    resetNeedsLiveForTest();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "decisions_list") {
        return [{
          project: "/work/proj",
          decisionKey: "sweep",
          question: "Example: which take goes in the trailer?",
          options: [],
          recommended: null,
          askedBy: "lead-chat",
          askedByMono: null,
          waiting: [],
          state: "open",
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        }];
      }
      return [];
    }) as never);
    await act(async () => {
      root.render(<InboxNeeds pick={{ picked: null, onPick: () => undefined }} />);
    });
    await vi.waitFor(() => expect(container.querySelector("[data-let-go-need]")).not.toBeNull());
    const row = container.querySelector("[data-let-go-need]") as HTMLButtonElement;
    await act(async () => row.click());
    expect(settledRows()[0]).toMatchObject({ key: "question:/work/proj:sweep", reason: "letgo" });
    await vi.waitFor(() => expect(container.querySelector("[data-let-go-need]")).toBeNull());
    expect(container.querySelector("[data-finished-needs]")).not.toBeNull();
  });
});
