// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewRows, type CrewWorkerInput } from "../model/rows";
import { inboxItems, type DecisionInput } from "../model/inbox";
import { CrewTab } from "./CrewTab";
import { DigestBanner } from "./DigestBanner";
import { FirstMateInbox } from "./FirstMateInbox";

const NOW = 1_700_000_000_000;
const PROJECT = "/work/proj";

function worker(id: string, status: CrewWorkerInput["status"]): CrewWorkerInput {
  return {
    id,
    project: PROJECT,
    title: id,
    status,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    childSession: `chat-${id}`,
    ownerSession: "lead",
  };
}

describe("crew tab", () => {
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

  it("WP-141: shows why the crew picked a worker, beside its notice", () => {
    const rows = crewRows({
      project: PROJECT,
      now: NOW,
      rows: [
        { ...worker("a", "working"), log: [{ event: "recorded", at: 1, why: "Builder role prefers Codex." }] },
        worker("b", "working"),
      ],
    });
    act(() => root.render(createElement(CrewTab, { rows, onStop: vi.fn() })));
    expect(container.querySelector("[data-crew-row='a'] [data-crew-why]")?.textContent).toBe("Builder role prefers Codex.");
    expect(container.querySelector("[data-crew-row='b'] [data-crew-why]")).toBeNull();
  });

  it("shows the five words and nothing else, and asks before it stops", () => {
    const rows = crewRows({
      project: PROJECT,
      now: NOW,
      rows: [
        worker("a", "working"),
        worker("b", "needs-you"),
        worker("c", "done"),
        worker("d", "failed"),
        worker("e", "paused"),
      ],
    });
    const onStop = vi.fn();
    act(() => root.render(createElement(CrewTab, { rows, onStop })));
    expect(container.querySelector("[data-crew-row='a'] [data-status-word]")?.textContent).toBe("working");
    expect(container.querySelector("[data-crew-row='b'] [data-status-word]")?.textContent).toBe("needs you");
    expect(container.querySelector("[data-crew-row='c'] [data-status-word]")?.textContent).toBe("done");
    expect(container.querySelector("[data-crew-row='d'] [data-status-word]")?.textContent).toBe("failed");
    expect(container.querySelector("[data-crew-row='e'] [data-status-word]")?.textContent).toBe("paused");
    expect(container.textContent).not.toMatch(/stuck|error|running/);
    const stop = [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop");
    act(() => stop?.click());
    expect(onStop).not.toHaveBeenCalled();
    const keep = [...container.querySelectorAll("button")].find((button) => button.textContent === "Keep it");
    act(() => keep?.click());
    expect(onStop).not.toHaveBeenCalled();
    act(() => stop?.click());
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop it");
    act(() => confirm?.click());
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("does not send an empty message", () => {
    const rows = crewRows({ project: PROJECT, now: NOW, rows: [worker("a", "working")] });
    const onMessage = vi.fn();
    act(() => root.render(createElement(CrewTab, { rows, onMessage })));
    const message = [...container.querySelectorAll("button")].find((button) => button.textContent === "Message");
    act(() => message?.click());
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent === "Send");
    act(() => send?.click());
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("keeps a message that did not send, and the button becomes Retry", async () => {
    const rows = crewRows({ project: PROJECT, now: NOW, rows: [worker("a", "working")] });
    const onMessage = vi.fn(() => Promise.reject(new Error("timed out")));
    act(() => root.render(createElement(CrewTab, { rows, onMessage })));
    const message = [...container.querySelectorAll("button")].find((button) => button.textContent === "Message");
    act(() => message?.click());
    const input = container.querySelector("input");
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter!.call(input, "Keep this");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent === "Send");
    await act(async () => {
      send?.click();
    });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(container.querySelector("input")?.value).toBe("Keep this");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
  });

  it("clears the message once the send has succeeded", async () => {
    const rows = crewRows({ project: PROJECT, now: NOW, rows: [worker("a", "working")] });
    const onMessage = vi.fn(() => Promise.resolve());
    act(() => root.render(createElement(CrewTab, { rows, onMessage })));
    const message = [...container.querySelectorAll("button")].find((button) => button.textContent === "Message");
    act(() => message?.click());
    const input = container.querySelector("input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter!.call(input, "Hello");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent === "Send");
    await act(async () => {
      send?.click();
    });
    expect(container.querySelector("input")).toBeNull();
  });

  it("offers Retry on a failed row and calls it", () => {
    const rows = crewRows({ project: PROJECT, now: NOW, rows: [worker("d", "failed")] });
    const onRetry = vi.fn();
    act(() => root.render(createElement(CrewTab, { rows, onRetry })));
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    expect(retry).toBeTruthy();
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("inbox and digest on screen", () => {
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

  it("marks the recommended answer and says a failure in plain words", () => {
    const decision: DecisionInput = {
      project: PROJECT,
      decisionKey: "ship",
      question: "Ship it now?",
      options: ["Ship it", "Wait"],
      recommended: "Ship it",
      state: "open",
      waiting: [],
    };
    const items = inboxItems({
      project: PROJECT,
      decisions: [decision],
      rows: [
        {
          id: "bad",
          project: PROJECT,
          status: "failed",
          title: "Save bug",
          statusNotice: "The save did not finish.",
          error: "at save (/tmp/a.ts:1)\nsk-live-secret",
        },
      ],
    });
    const onAnswer = vi.fn();
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(FirstMateInbox, { items, onAnswer }),
          createElement(DigestBanner, {
            immediate: [{ id: "decision", title: "Ship it now?" }],
            digest: [{ id: "failure", title: "The save did not finish." }],
          }),
        ),
      ),
    );
    expect(container.querySelector("[data-recommended]")?.textContent).toContain("Recommended");
    expect(container.querySelector("[data-failure]")?.textContent).toBe("The save did not finish.");
    expect(container.querySelector("[data-failure]")?.textContent).not.toMatch(/sk-|at save/);
    expect(container.querySelector("[data-immediate]")?.textContent).toContain("Ship it now?");
    expect(container.querySelector("[data-digest]")?.textContent).toContain("The save did not finish.");
    expect(container.querySelector("[data-digest]")?.textContent).not.toContain("Ship it now?");
    const ship = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Ship it"));
    act(() => ship?.click());
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ key: "ship" }), "Ship it");
    expect(container.querySelector("[data-waiting]")).toBeNull();
  });

  it("says how long a question has been waiting", () => {
    const items = inboxItems({
      project: PROJECT,
      decisions: [
        {
          project: PROJECT,
          decisionKey: "old",
          question: "Oldest question",
          state: "open",
          waiting: [],
          createdAt: NOW - 12 * 60_000,
          // Touched a second ago: the phrase still counts from when it was asked.
          updatedAt: NOW - 1_000,
        },
      ],
    });
    act(() => root.render(createElement(FirstMateInbox, { items, now: NOW })));
    expect(container.querySelector("[data-inbox-kind='decision'] [data-waiting]")?.textContent).toBe("waiting 12 minutes");
  });

  it("says how long a blocked row has been stuck, not how long its work has run", () => {
    const items = inboxItems({
      project: PROJECT,
      rows: [
        {
          id: "stuck",
          project: PROJECT,
          title: "Cannot finish",
          status: "needs-you",
          statusNotice: "Cannot finish: the deploy key is missing",
          stallKind: "blocked",
          stalledAt: NOW - 4 * 60_000,
          createdAt: NOW - 3 * 60 * 60_000,
          updatedAt: NOW - 1_000,
        },
      ],
    });
    act(() => root.render(createElement(FirstMateInbox, { items, now: NOW })));
    expect(container.querySelector("[data-inbox-id='question:stuck'] [data-waiting]")?.textContent).toBe("waiting 4 minutes");
  });

  it("shows no digest when there is nothing to say", () => {
    act(() => root.render(createElement(DigestBanner, { immediate: [], digest: null })));
    expect(container.querySelector("[data-digest]")).toBeNull();
    expect(container.querySelector("[data-immediate]")).toBeNull();
  });
});
