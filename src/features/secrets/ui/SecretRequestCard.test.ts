// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const beginSave = vi.fn(async () => ({ request: {}, token: "tok-1" }));
const saveRequest = vi.fn(async (..._args: unknown[]) => ({}));
const declineRequest = vi.fn(async () => undefined);

vi.mock("../model/secrets", async (importOriginal) => {
  const real = await importOriginal<typeof import("../model/secrets")>();
  return { ...real, beginSave: () => beginSave(), saveRequest: (...args: unknown[]) => saveRequest(...args), declineRequest: (...args: unknown[]) => declineRequest(...args) };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { SecretRequestCard } from "./SecretRequestCard";

const VALUE = "sk_live_51NxAbCdEfGhIjKl";
const request = {
  id: "req-1",
  chat: "chat-1",
  mono: "Tally",
  project: null,
  scope: "global",
  name: "stripe-api-key",
  why: "to list customers",
  state: "open" as const,
  createdAt: 1,
  updatedAt: 1,
};

async function render(strict = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const card = createElement(SecretRequestCard, { request, onDone: () => {} });
  await act(async () => {
    root.render(strict ? createElement(StrictMode, null, card) : card);
  });
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  beginSave.mockClear();
  beginSave.mockImplementation(async () => ({ request: {}, token: "tok-1" }));
  saveRequest.mockClear();
});

it("sends the value once and clears the field", async () => {
  const { container } = await render();
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    input.value = VALUE;
  });
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
  await act(async () => {
    save.click();
  });
  expect(saveRequest).toHaveBeenCalledTimes(1);
  expect(saveRequest.mock.calls[0]).toEqual(["req-1", "tok-1", "stripe-api-key", VALUE]);
  expect(input.value).toBe("");
  // The DOM never holds it as text, and nothing stores it.
  expect(container.textContent).not.toContain(VALUE);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it("works under StrictMode: the second mount does not throw away the first ticket", async () => {
  // The app mounts the card under StrictMode, which runs the open -> saving effect twice. One claim serves both mounts,
  // so the store is asked once, the first ticket survives, and the card stays usable.
  let calls = 0;
  beginSave.mockImplementation(async () => {
    calls += 1;
    if (calls > 1) throw new Error("That key was already saved.");
    return { request: {}, token: "tok-strict" };
  });
  const { container } = await render(true);
  // One claim for the two mounts: the card never asks the store twice.
  expect(calls).toBe(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    input.value = VALUE;
  });
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
  await act(async () => {
    save.click();
  });
  expect(saveRequest).toHaveBeenCalledTimes(1);
  expect(saveRequest.mock.calls[0]).toEqual(["req-1", "tok-strict", "stripe-api-key", VALUE]);
  expect(container.textContent).not.toContain(VALUE);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("a failed save shows one sentence, no value, and clears the field for a fresh card", async () => {
  saveRequest.mockImplementationOnce(async () => {
    throw new Error("the keychain said something with " + VALUE);
  });
  const { container } = await render();
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    input.value = VALUE;
  });
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
  await act(async () => {
    save.click();
  });
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe("That key wasn't saved. Try again on a fresh card.");
  expect(container.textContent).not.toContain(VALUE);
  expect(input.value).toBe("");
});

it("shows the Mono, the why, the slug and the scope, and the show toggle only changes the type", async () => {
  const { container } = await render();
  expect(container.textContent).toContain("Tally needs a key");
  expect(container.textContent).toContain("to list customers");
  expect(container.textContent).toContain("stripe-api-key");
  // Plain words for where the key will live (this line used to say "Every project").
  expect(container.textContent).toContain("Everywhere");
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const show = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show")!;
  await act(async () => {
    show.click();
  });
  expect(input.type).toBe("text");
  expect(input.value).toBe("");
});
it("names a project's scope in plain words, not as a path id", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(SecretRequestCard, {
        request: { ...request, id: "req-2", scope: "project./work/hivra", project: "/work/hivra" },
        onDone: () => {},
      }),
    );
  });
  expect(container.textContent).toContain("Project: hivra");
  expect(container.textContent).not.toContain("project./work/hivra");
});
