// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstMateItem } from "../model/inbox";
import { FirstMateInbox } from "./FirstMateInbox";

const item = (apply: () => void): FirstMateItem => ({
  id: "pass",
  kind: "question",
  title: "Example: retry the check?",
  body: "it can wait",
  statusWord: "Chief of Staff suggests: Example: retry once",
  chip: "Passed up",
  reasonLead: "Why you:",
  marks: ["Can wait"],
  actions: [
    { label: "Do that", primary: true, onClick: apply },
    { label: "Something else" },
  ],
  chatId: null,
  workerIds: [],
  options: [],
  recommended: null,
  project: "EXO",
  key: null,
  since: 0,
  updatedAt: 1,
});

describe("a passed-up row's suggestion", () => {
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

  it("applies the suggestion from Do that, and the chip sits with the title", () => {
    const apply = vi.fn();
    act(() => root.render(createElement(FirstMateInbox, { items: [item(apply)] })));
    const buttons = [...container.querySelectorAll("button")];
    buttons.find((button) => button.textContent === "Do that")?.click();
    expect(apply).toHaveBeenCalledOnce();
    buttons.find((button) => button.textContent === "Something else")?.click();
    expect(apply).toHaveBeenCalledOnce();
    const article = container.querySelector("article");
    expect(article?.querySelector("h3")?.textContent).toBe("Example: retry the check?");
    expect(article?.querySelector("p")?.textContent).toBe("Chief of Staff suggests: Example: retry once");
    expect(container.querySelector("[data-reason-text]")?.textContent).toBe("it can wait");
    expect(container.textContent).toContain("Can wait");
    expect(container.textContent).toContain("Why you:");
  });
});
