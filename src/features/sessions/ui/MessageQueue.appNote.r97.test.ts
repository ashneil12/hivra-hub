// @vitest-environment happy-dom
// r97 (Critiquito b, r95): an app note to a busy Lead ("[MonoCode fix mismatch] From the app: …") sat in Ash's queued
// message bar above the composer, with Steer, edit and delete as if he wrote it. It never shows there; it shows only
// as the grey line in the chat once sent.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { QueuedMessage } from "../model/session";
import { MessageQueue } from "./MessageQueue";

const queued = (id: string, text: string) => ({ id, text, attachments: [] }) as unknown as QueuedMessage;
const render = (messages: QueuedMessage[]) => {
  const el = document.createElement("div");
  el.innerHTML = renderToStaticMarkup(createElement(MessageQueue, { messages, onSteer: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }));
  return el;
};

it("an app note alone puts nothing in the bar", () => {
  const el = render([queued("n", "[MonoCode fix mismatch] From the app: the board order test still fails.")]);
  expect(el.querySelector("[data-message-queue]")).toBeNull();
  expect(el.textContent).toBe("");
});

it("beside Ash's own message, only his is in the bar", () => {
  const el = render([
    queued("n", "[MonoCode latest result] From the app: 16 passed, 0 failed."),
    queued("a", "also check the readme"),
  ]);
  expect(el.textContent).toContain("also check the readme");
  expect(el.textContent).not.toMatch(/MonoCode|The app pointed|From the app/);
  expect(el.querySelectorAll('[aria-label="Remove queued message"]')).toHaveLength(1);
});
