// @vitest-environment happy-dom
// A DeepSeek-recorded worker names the model it stored. The title stays whole and wraps when the card is squeezed.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

const { LaunchedSessionCard } = await import("./LaunchedSessionCard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let r: Root | undefined;
afterEach(() => act(() => r?.unmount()));

// r95 (PM, worker card a): the engine chip is gone from the card; what ran is in its tooltip.
it("names DeepSeek V4.1 Flash and the effort in the card's tooltip, with no engine chip", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const launch = { sessionId: "w3", cwd: "/repo/tally", title: "Show tally count", harness: "claude" as const, model: "claude:deepseek-v4.1-flash", effort: "High" };
  await act(async () => r!.render(createElement(LaunchedSessionCard, { launch, view: { state: "working", title: launch.title }, onOpen: () => undefined })));
  expect(host.querySelector("[data-launched-model]")).toBeNull();
  const card = host.querySelector("[data-launched-session]")!;
  expect(card.getAttribute("title")).toMatch(/ · Runs on DeepSeek V4\.1 Flash, High effort$/);
  expect(card.getAttribute("title")).not.toMatch(/key|provider|bridge/i);
});

it("names the CLI, the model, the effort and where they came from, and still has no engine chip", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const launch = {
    sessionId: "w5",
    cwd: "/repo/tally",
    title: "Show tally count",
    harness: "claude" as const,
    model: "claude:opus",
    effort: "High",
    from: "set for this Mono",
  };
  await act(async () =>
    r!.render(createElement(LaunchedSessionCard, { launch, view: { state: "done", title: launch.title }, onOpen: () => undefined })),
  );
  const card = host.querySelector("[data-launched-session]")!;
  expect(host.querySelector("[data-launched-model]")).toBeNull();
  expect(card.getAttribute("title")).toBe("Done · Runs on Opus, High effort · set for this Mono");
  expect(host.querySelector("[data-launched-ran]")?.textContent).toBe(
    "Runs on Claude Code, Opus, High effort (set for this Mono)",
  );
});

it("r92/r95 (s15 dcf4): squeezed beside 'Stalled', the card clips and the title wraps instead of being cut", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const launch = { sessionId: "w4", cwd: "/repo/tally", title: "Show tally count at the top", harness: "claude" as const, model: "claude:deepseek-v4.1-flash", effort: "High" };
  await act(async () => r!.render(createElement(LaunchedSessionCard, { launch, view: { state: "working", title: launch.title }, onOpen: () => undefined })));
  const card = host.querySelector("[data-launched-session]")!;
  expect(card.className).toContain("overflow-hidden");
  const title = host.querySelector("[data-launched-title]")!.className.split(/\s+/);
  expect(title).toEqual(expect.arrayContaining(["flex-1", "min-w-[min(10rem,100%)]", "whitespace-normal", "break-words"]));
  expect(title).not.toContain("truncate");
});
