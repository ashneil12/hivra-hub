// @vitest-environment happy-dom
// G10: the Inbox shows a first mate's decision once, as a row of the one Needs you list. The row's answer goes through
// the first-mate panel's versioned answer, and the panel keeps only its results, failures and digest line.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { queueHomeDecision, resetHomePending } from "../../home/model/pending";
import { resetNeedsLiveForTest } from "../model/needsLive";
import { InboxOneList } from "./InboxOneList";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const PROJECT = "/work/proj";
const QUESTION = "Example: Which name for the save menu?";
const CHANGED = "That card changed after you read it, so the answer was not recorded. Read it again and answer.";

type Card = Record<string, unknown> & { version: number; state: string };

function decision(version: number): Card {
  return {
    project: PROJECT,
    decisionKey: "name",
    question: QUESTION,
    options: ["Keep", "Rename"],
    recommended: "Keep",
    askedBy: "lead-chat",
    askedByMono: null,
    waiting: [],
    state: "open",
    createdAt: 1,
    updatedAt: 1,
    version,
  };
}

function secretCard(version: number): Card {
  return {
    ...decision(version),
    decisionKey: "secret/stripe-api-key/9f",
    question: "Let Tally run `/usr/bin/curl` with Stripe?\nCommand: /usr/bin/curl https://example.test/v1 -- balance",
    options: ["Once", "No"],
    recommended: "Once",
  };
}

function worker(id: string, title: string, status: string, patch: Record<string, unknown> = {}) {
  return { id, project: PROJECT, title, status, ownerSession: "lead", childSession: `chat-${id}`, createdAt: 1, updatedAt: 1, ...patch };
}

const WORKERS = [
  worker("failed", "Save the game", "failed", { statusNotice: "The save did not finish.", settledAt: 2 }),
  worker("done", "Ship the menu", "done", { settledAt: 2 }),
];

function serve(cards: () => Card[], onAnswer: (args: Record<string, unknown>) => unknown) {
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "delegations_list_open" || cmd === "delegations_recent") return WORKERS;
    if (cmd === "decisions_list") return cards().map((card) => ({ ...card }));
    if (cmd === "delivery_list") return [{ delegationId: "done", state: "open", updatedAt: 2 }];
    if (cmd === "decisions_answer") return onAnswer(args ?? {});
    return [];
  }) as never);
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

function rowButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("[data-inbox-need] button")].find((button) =>
    button.textContent?.startsWith(label),
  ) as HTMLButtonElement | undefined;
}

describe("the Inbox folds a first mate's decisions into the one Needs you list", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    resetNeedsLiveForTest();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetHomePending();
    resetNeedsLiveForTest();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function shown(wait: () => void) {
    await act(async () => {
      root.render(createElement(InboxOneList, { cwd: PROJECT }));
    });
    await vi.waitFor(wait);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("shows a decision once, as a Needs you row, with the results and failures under the list", async () => {
    serve(() => [decision(1)], () => ({ applied: true, decision: null, released: [], releasedTasks: [] }));
    await shown(() => {
      expect(rowButton(container, "Rename")).toBeTruthy();
      expect(container.querySelector("[data-inbox-kind=failure]")).toBeTruthy();
    });
    expect(occurrences(container.textContent ?? "", QUESTION)).toBe(1);
    expect(container.querySelectorAll("[data-inbox-kind=decision]")).toHaveLength(0);
    expect(container.querySelector("[data-inbox-need]")?.textContent).toContain(QUESTION);
    // What only the first-mate panel shows stays: the failure and the result waiting for review.
    expect(container.querySelector("[data-inbox-kind=failure]")?.textContent).toContain("The save did not finish.");
    expect(container.querySelector("[data-inbox-kind=review]")?.textContent).toContain("Ship the menu");
    // The digest's "Needs you now" line does not repeat the decision either.
    expect(container.querySelector("[data-immediate]")?.textContent ?? "").not.toContain(QUESTION);
  });

  it("answers from the row through the versioned answer, with the row's version", async () => {
    const card = decision(3);
    const sent: Record<string, unknown>[] = [];
    serve(
      () => [card],
      (args) => {
        sent.push(args);
        card.state = "answered";
        return { applied: true, decision: card, released: [], releasedTasks: [] };
      },
    );
    await shown(() => expect(rowButton(container, "Rename")).toBeTruthy());
    await act(async () => {
      rowButton(container, "Rename")?.click();
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ project: PROJECT, key: "name", answer: "Rename", by: "user", seenVersion: 3 });
  });

  it("refuses a stale version the way the panel did: no resend, the row stays, the next tap sends the new version", async () => {
    const card = decision(3);
    const seen: number[] = [];
    serve(
      () => [card],
      (args) => {
        seen.push(Number(args.seenVersion));
        card.version = 4;
        throw new Error(CHANGED);
      },
    );
    await shown(() => expect(rowButton(container, "Rename")).toBeTruthy());
    await act(async () => {
      rowButton(container, "Rename")?.click();
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen).toEqual([3]);
    expect(rowButton(container, "Rename")).toBeTruthy();
    await act(async () => {
      rowButton(container, "Rename")?.click();
    });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([3, 4]);
  });

  it("the decision Home opened is the selected row, not a second card", async () => {
    queueHomeDecision(PROJECT, "name");
    serve(() => [decision(1), { ...decision(1), decisionKey: "font", question: "Example: Which font?" }], () => ({}));
    await shown(() => expect(container.querySelector("[data-selected='true']")).toBeTruthy());
    const selected = container.querySelectorAll("[data-selected='true']");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.matches("[data-inbox-need]")).toBe(true);
    expect(selected[0]?.getAttribute("data-decision-key")).toBe("name");
  });

  it("a secret card's row shows the exact command and answers as the person", async () => {
    const card = secretCard(2);
    const sent: Record<string, unknown>[] = [];
    serve(
      () => [card],
      (args) => {
        sent.push(args);
        card.state = "answered";
        return { applied: true, decision: card, released: [], releasedTasks: [] };
      },
    );
    await shown(() => expect(rowButton(container, "Once")).toBeTruthy());
    expect(container.querySelector("[data-inbox-need]")?.textContent).toContain(
      "Command: /usr/bin/curl https://example.test/v1 -- balance",
    );
    expect(container.querySelectorAll("[data-inbox-kind=decision]")).toHaveLength(0);
    await act(async () => {
      rowButton(container, "Once")?.click();
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ key: "secret/stripe-api-key/9f", answer: "Once", by: "person", seenVersion: 2 });
  });
});
