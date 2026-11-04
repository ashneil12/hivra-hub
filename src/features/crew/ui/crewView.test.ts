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
  });

  it("shows no digest when there is nothing to say", () => {
    act(() => root.render(createElement(DigestBanner, { immediate: [], digest: null })));
    expect(container.querySelector("[data-digest]")).toBeNull();
    expect(container.querySelector("[data-immediate]")).toBeNull();
  });
});
