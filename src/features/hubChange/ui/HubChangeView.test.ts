// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HubChangeContent, NOT_ON_COPY } from "./HubChangeView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("the Not connected yet card has the plain copy and only Back", async () => {
  localStorage.clear();
  localStorage.setItem("monocode:mono-roster", JSON.stringify([{ id: "bo", name: "Projects Manager" }]));
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(HubChangeContent, { flow: "hub", projectId: "hivra" })));
  const input = host.querySelector("input")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "Group my chats by week");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => vi.waitFor(() => expect(host.querySelector("[data-hub-change-not-connected]")).not.toBeNull()));
  const card = host.querySelector("[data-hub-change-not-connected]")!;
  expect(card.textContent).toContain(NOT_ON_COPY);
  expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Back"]);
});
