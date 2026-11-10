// @vitest-environment happy-dom
// Hivra WP-92: the chat's key ask is a secret form, never a text box whose words would land in the transcript.
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const saveNew = vi.fn(async (..._args: unknown[]) => ({}));

vi.mock("../model/secrets", async (importOriginal) => {
  const real = await importOriginal<typeof import("../model/secrets")>();
  return { ...real, saveNew: (...args: unknown[]) => saveNew(...args) };
});

import { SecretKeyAsk } from "./SecretKeyAsk";

const VALUE = "sk_live_51NxAbCdEfGhIjKl";
const chat = {
  id: "chat-1",
  busy: false,
  blocks: [
    { role: "user" as const, text: "See if the customer list loads." },
    {
      role: "assistant" as const,
      text: "I stopped at the key.\nNeeds Ash (provide): a Stripe live secret key, so I can list the customers",
    },
  ],
};

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  saveNew.mockClear();
  localStorage.clear();
  sessionStorage.clear();
});

it("shows the secret form for a finished turn that asks for a key", async () => {
  const { container } = await render(createElement(SecretKeyAsk, { chat }));
  expect(container.textContent).toContain("needs a key from you");
  expect(container.textContent).toMatch(/stripe live secret key/i);
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Save")).toBe(true);
  // Not a text box that would become a chat message.
  expect(container.querySelector("textarea")).toBeNull();
});

it("sends the value once, clears it, and says where it went", async () => {
  const { container } = await render(createElement(SecretKeyAsk, { chat }));
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    input.value = VALUE;
  });
  const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
  await act(async () => {
    save.click();
  });
  expect(saveNew).toHaveBeenCalledTimes(1);
  expect(saveNew.mock.calls[0]).toEqual(["global", "stripe-live-secret-key", null, VALUE]);
  expect(container.textContent).toContain("Saved for Everywhere");
  expect(input.isConnected).toBe(false);
  expect(container.textContent).toContain("Saved in your Mac's keychain");
  expect(container.textContent).not.toContain(VALUE);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it("a failed save shows one sentence, no value, and clears the field", async () => {
  saveNew.mockImplementationOnce(async () => {
    throw new Error("the keychain said something with " + VALUE);
  });
  const { container } = await render(createElement(SecretKeyAsk, { chat }));
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    input.value = VALUE;
  });
  const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
  await act(async () => {
    save.click();
  });
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("That key wasn't saved. Try again on a fresh card.");
  expect(container.textContent).not.toContain(VALUE);
  expect(input.value).toBe("");
});

it("refuses a name the vault would not take, without sending the value", async () => {
  const { container } = await render(createElement(SecretKeyAsk, { chat }));
  const name = container.querySelector<HTMLInputElement>("#secret-key-ask-name")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(name, "Stripe Key!");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    input.value = VALUE;
  });
  const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
  await act(async () => {
    save.click();
  });
  expect(saveNew).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("lower-case letters, digits and dashes");
});

it("renders nothing for an ask that is not a key", async () => {
  const { container } = await render(
    createElement(SecretKeyAsk, {
      chat: { ...chat, blocks: [{ role: "assistant" as const, text: "Needs Ash (provide): git access to the hivra repo" }] },
    }),
  );
  expect(container.textContent).toBe("");
});

it("renders nothing once the key ask is answered", async () => {
  const { container } = await render(
    createElement(SecretKeyAsk, {
      chat: {
        ...chat,
        blocks: [
          ...chat.blocks,
          { role: "user" as const, text: '[MonoCode Ash answered] answered your question "a Stripe live secret key, so I can list the customers"' },
        ],
      },
    }),
  );
  expect(container.textContent).toBe("");
});

it("says where the key will be saved before it is saved, and it is everywhere for a chat with no project", async () => {
  const { container } = await render(createElement(SecretKeyAsk, { chat }));
  expect(container.textContent).toContain("It will be saved for: Everywhere");
});

it("writes to the project when the ask came from a project chat, and says so first", async () => {
  const { container } = await render(createElement(SecretKeyAsk, { chat, project: "/work/hivra" }));
  // Named before anything is saved.
  expect(container.textContent).toContain("It will be saved for: Project: hivra");
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    input.value = VALUE;
  });
  const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
  await act(async () => {
    save.click();
  });
  expect(saveNew).toHaveBeenCalledTimes(1);
  expect(saveNew.mock.calls[0]).toEqual(["project./work/hivra", "stripe-live-secret-key", null, VALUE]);
  expect(container.textContent).toContain("Saved for Project: hivra");
  expect(container.textContent).not.toContain(VALUE);
});

it("lets the person choose everywhere instead of the project", async () => {
  const { container } = await render(createElement(SecretKeyAsk, { chat, project: "/work/hivra" }));
  const where = container.querySelector<HTMLSelectElement>("#secret-key-ask-scope")!;
  expect([...where.options].map((option) => option.textContent)).toEqual(["Project: hivra", "Everywhere"]);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(where, "global");
    where.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("It will be saved for: Everywhere");
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    input.value = VALUE;
  });
  const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
  await act(async () => {
    save.click();
  });
  expect(saveNew.mock.calls[0]).toEqual(["global", "stripe-live-secret-key", null, VALUE]);
});
