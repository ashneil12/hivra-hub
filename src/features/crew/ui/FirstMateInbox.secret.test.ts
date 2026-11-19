// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxItems, type DecisionInput } from "../model/inbox";
import { FirstMateInbox } from "./FirstMateInbox";

const PROJECT = "/work/proj";
const WARNING = "'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are sure.";

function secretCard(question: string, options: string[]): DecisionInput {
  return {
    project: PROJECT,
    decisionKey: "secret/stripe-api-key/python3",
    question,
    options,
    recommended: "Once",
    askedBy: "chat",
    waiting: [],
    state: "open",
    updatedAt: 1,
  };
}

describe("a secret's approval card, as the person sees it", () => {
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

  /** The answer buttons, not "Open the chat". */
  function answers(): HTMLButtonElement[] {
    return [...container.querySelectorAll("button")].filter((button) => button.textContent !== "Open the chat");
  }

  function show(decision: DecisionInput) {
    const items = inboxItems({ project: PROJECT, decisions: [decision] });
    act(() => root.render(createElement(FirstMateInbox, { items })));
  }

  it("shows the full command line and the Once-only line, with no Always button", () => {
    show(
      secretCard(
        [
          "Let Tally run `python3` with Stripe API key?",
          "The program is python3.",
          "Command: python3 -c 'print(open(\"/etc/hosts\").read())'",
          "This can run any code, so it asks every time.",
        ].join("\n"),
        ["Once", "No"],
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Command: python3 -c 'print(open(\"/etc/hosts\").read())'");
    expect(text).toContain("The program is python3.");
    expect(text).toContain("This can run any code, so it asks every time.");
    expect(answers().map((b) => b.textContent?.replace(" Recommended", ""))).toEqual(["Once", "No"]);
    expect(text).not.toContain(WARNING);
  });

  it("puts the warning under the buttons when Always is offered", () => {
    show(
      secretCard(
        [
          "Let Tally run `python3` with Stripe API key?",
          "The program is python3.",
          "Command: python3 build.py",
          `Warning: ${WARNING}`,
        ].join("\n"),
        ["Once", "Always for this Mono", "No"],
      ),
    );
    expect(answers().map((b) => b.textContent?.replace(" Recommended", ""))).toEqual(["Once", "Always for this Mono", "No"]);
    const note = container.querySelector("[data-inbox-note]");
    expect(note?.textContent).toBe(WARNING);
    // The warning comes after the last answer button in the page.
    const lastButton = answers()[2]!;
    expect(lastButton.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
