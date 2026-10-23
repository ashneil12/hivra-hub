// @vitest-environment happy-dom
// A worker's card in a Lead's chat takes the replies' reading width (PM's real-app check of r35, 22 Oct: they still
// showed as narrow pills in the Hub lead's chat). Like the r24 1:1 width change: about 640px, the title fills the card
// and the project sits at its end; never a fit-to-content pill.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { LaunchedSessionCard } from "./LaunchedSessionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let r: Root | undefined;
afterEach(() => act(() => r?.unmount()));

it("a worker's card fills up to the 640px reading width, title first and the project at the end", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const launch = { sessionId: "w1", cwd: "/repo/monocode-hub", title: "Example: ask the colour question and wait for the answer", harness: "claude" as const, model: "claude:opus" };
  await act(async () => r!.render(createElement(LaunchedSessionCard, { launch, view: { state: "done", title: launch.title }, onOpen: () => undefined })));
  const card = host.querySelector<HTMLButtonElement>('[data-launched-session="w1"]')!;
  const cls = card.className.split(/\s+/);
  // Not a pill sized to its text, and not the old 24rem (384px) cap.
  expect(cls).not.toContain("w-fit");
  expect(card.className).not.toMatch(/24rem/);
  // The replies' reading width: 40rem = 640px, growing into it as the row allows.
  expect(cls).toContain("max-w-[40rem]");
  expect(cls).toContain("flex-1");
  expect(cls).toContain("basis-full");
  expect(cls).toContain("min-w-0");
  // The title takes the room; the project chip stays at the card's end.
  const title = [...card.querySelectorAll("span")].find((s) => s.textContent === launch.title)!;
  expect(title.className.split(/\s+/)).toContain("flex-1");
  expect(card.lastElementChild!.textContent).toBe("monocode-hub");
  // E7: the card says which model the worker runs on, quietly, just before the project chip.
  const model = card.querySelector("[data-launched-model]")!;
  expect(model.textContent).toBe("Opus");
  expect(model.getAttribute("title")).toBe("Runs on Opus");
  expect(model.nextElementSibling).toBe(card.lastElementChild);
});

it("says the effort a hard job's worker runs at, in the same words the composer uses", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const launch = { sessionId: "w2", cwd: "/repo/monocode-hub", title: "Migration", harness: "claude" as const, model: "claude:opus-5-5", effort: "High" };
  await act(async () => r!.render(createElement(LaunchedSessionCard, { launch, view: { state: "working", title: launch.title }, onOpen: () => undefined })));
  const model = host.querySelector("[data-launched-model]")!;
  expect(model.textContent).toMatch(/ · High$/);
  expect(model.getAttribute("title")).toMatch(/^Runs on .+, High effort$/);
});
