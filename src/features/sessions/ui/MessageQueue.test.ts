// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { monoSessionCompletionMessage } from "../../monos/model/monoSessionCompletion";
import { MessageQueue } from "./MessageQueue";

it("labels a pending completion and offers removal without editing or steering it", () => {
  const message = monoSessionCompletionMessage({
    sessionId: "worker",
    requestId: "app-mono-monitor",
    project: "/code/project",
    prompt: "Review",
    session: undefined,
    outcome: { status: "completed", text: "Done" },
  });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(MessageQueue, {
      messages: [message],
      onSteer: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      variant: "messages",
    }),
  );
  expect(container.textContent).toContain("Session completed: Agent session");
  expect(container.textContent).not.toContain(
    "MonoCode completion notification",
  );
  expect(container.textContent).not.toContain("Steer");
  expect(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]',
    )?.disabled,
  ).toBe(true);
  expect(
    container.querySelector('[aria-label="Remove queued message"]'),
  ).not.toBeNull();
});

it("hides Steer and shows one plain sentence when the agent cannot redirect", () => {
  const note = "Grok Build can't redirect a running turn. Stop it, then send.";
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(MessageQueue, {
      messages: [
        { id: "a", text: "first", attachments: [] },
        { id: "b", text: "second", attachments: [] },
      ],
      onSteer: vi.fn(),
      steerNote: note,
    }),
  );
  expect(container.querySelectorAll('[role="note"]')).toHaveLength(1);
  expect(container.textContent).toContain(note);
  expect(container.textContent).not.toContain("Steer");
  expect(note).not.toMatch(/[—–]/);
});

it("still offers Steer when the agent can redirect", () => {
  const markup = renderToStaticMarkup(
    createElement(MessageQueue, {
      messages: [{ id: "a", text: "first", attachments: [] }],
      onSteer: vi.fn(),
    }),
  );
  expect(markup).toContain("Steer");
  expect(markup).not.toContain('role="note"');
});

it("does not show the sentence for an app note that never sits in the queue", () => {
  const markup = renderToStaticMarkup(
    createElement(MessageQueue, {
      messages: [
        {
          id: "note",
          text: "[MonoCode latest result] From the app: newer",
          attachments: [],
        },
      ],
      onSteer: vi.fn(),
      steerNote: "fx can't redirect a running turn. Stop it, then send.",
    }),
  );
  expect(markup).toBe("");
});

it("labels a combined report without exposing the app prompt", () => {
  const message = monoSessionCompletionMessage({
    sessionId: "worker",
    requestId: "request",
    project: "/code/project",
    prompt: "Review",
    outcome: { status: "completed", text: "Done" },
  });
  message.monoSessionCompletion!.sessionCount = 3;
  const markup = renderToStaticMarkup(
    createElement(MessageQueue, { messages: [message] }),
  );
  expect(markup).toContain("3 sessions finished");
  expect(markup).not.toContain("MonoCode completion notification");
});
