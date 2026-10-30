// @vitest-environment happy-dom
// r90 (Ash, Critiquito): on the Grok bench a DeepSeek-recorded worker ran on Grok 4.7. Its card names what ran first,
// keeps that whole, and puts the reason after it in grey, which gives way first when the card is squeezed.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../../app/model/appIdentity", () => ({ appIdentity: () => ({ verify: { grok: true } }) }));
const { LaunchedSessionCard } = await import("./LaunchedSessionCard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let r: Root | undefined;
afterEach(() => act(() => r?.unmount()));

it("names Grok 4.7 and the effort whole, then 'DeepSeek wasn't available' in grey, truncating first", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const launch = { sessionId: "w3", cwd: "/repo/tally", title: "Show tally count", harness: "claude" as const, model: "claude:deepseek-v4.1-flash", effort: "High" };
  await act(async () => r!.render(createElement(LaunchedSessionCard, { launch, view: { state: "working", title: launch.title }, onOpen: () => undefined })));
  const model = host.querySelector("[data-launched-model]")!;
  expect(model.textContent).toBe("Grok 4.7 · High · DeepSeek wasn't available");
  expect(model.getAttribute("title")).toBe("Runs on Grok 4.7 · DeepSeek wasn't available, High effort");
  const name = model.firstElementChild!;
  expect(name.textContent).toBe("Grok 4.7 · High");
  // r92: the name gives way only after the reason (a tiny shrink weight), and both clip rather than overflow.
  expect(name.className).toContain("shrink-[0.01]");
  expect(name.className).toContain("truncate");
  const note = model.querySelector("[data-launched-model-note]")!;
  expect(note.className).toContain("truncate");
  expect(note.className).toContain("text-content/40");
  expect(note.textContent).not.toMatch(/key|provider|bridge/i);
});

it("r92 (s15 dcf4): squeezed beside 'Stalled', the card clips, the title keeps room and the model gives way", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const launch = { sessionId: "w4", cwd: "/repo/tally", title: "Show tally count at the top", harness: "claude" as const, model: "claude:deepseek-v4.1-flash", effort: "High" };
  await act(async () => r!.render(createElement(LaunchedSessionCard, { launch, view: { state: "working", title: launch.title }, onOpen: () => undefined })));
  const card = host.querySelector("[data-launched-session]")!;
  expect(card.className).toContain("overflow-hidden");
  expect(host.querySelector("[data-launched-title]")!.className).toContain("min-w-[4.5rem]");
  const model = host.querySelector("[data-launched-model]")!;
  expect(model.className).not.toContain("shrink-0");
  expect(model.className).toContain("overflow-hidden");
});
