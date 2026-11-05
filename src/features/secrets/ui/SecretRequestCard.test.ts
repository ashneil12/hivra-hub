// @vitest-environment happy-dom
import { act, createElement } from "react";
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

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SecretRequestCard, { request, onDone: () => {} }));
  });
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  beginSave.mockClear();
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
  expect(container.textContent).toContain("Every project");
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const show = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show")!;
  await act(async () => {
    show.click();
  });
  expect(input.type).toBe("text");
  expect(input.value).toBe("");
});