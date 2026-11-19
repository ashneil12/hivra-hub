// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAutomationTrigger, type Automation } from "../model/automations";
import { AutomationMap } from "./AutomationMap";

function automation(
  partial: Partial<Automation> & Pick<Automation, "id" | "name">,
): Automation {
  return {
    id: partial.id,
    name: partial.name,
    prompt: "PROMPT_SHOULD_NOT_LEAK",
    harness: "codex",
    model: "model",
    cwd: partial.cwd ?? "/work/project",
    workspaceMode: "current",
    reuseSession: false,
    runtimeMode: "auto",
    triggerKind: "time",
    triggerEvent: "",
    scheduleKind: "weekdays",
    minute: 0,
    time: "09:00",
    dayOfWeek: 1,
    triggers: partial.triggers,
    missedRunGraceMinutes: 720,
    enabled: partial.enabled ?? true,
    nextRunAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

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

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${name}`);
  return found;
}

it("does not open the editor from a switched-off node", async () => {
  const onOpen = vi.fn();
  await act(async () =>
    root.render(
      createElement(AutomationMap, {
        automations: [
          automation({
            id: "off-a",
            name: "Paused one",
            enabled: false,
            triggers: [
              createAutomationTrigger("time", "weekdays", {
                id: "time-a",
                time: "09:00",
                scheduleKind: "weekdays",
              }),
            ],
          }),
          automation({
            id: "off-b",
            name: "Paused two",
            enabled: false,
            triggers: [
              createAutomationTrigger("time", "daily", {
                id: "time-b",
                time: "18:00",
                scheduleKind: "daily",
              }),
            ],
          }),
          automation({
            id: "on",
            name: "Active",
            triggers: [
              createAutomationTrigger("github", "issue_opened", {
                id: "issue-on",
                repo: "owner/repo",
              }),
            ],
          }),
        ],
        onOpen,
      }),
    ),
  );
  await act(async () => {
    button("Paused one, off").click();
    button("Paused two, off").click();
  });
  expect(onOpen).not.toHaveBeenCalled();
  expect(button("Paused one, off").getAttribute("aria-disabled")).toBe("true");
  expect(button("Paused two, off").getAttribute("aria-disabled")).toBe("true");
  await act(async () => {
    button("Active").click();
  });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("on");
});
