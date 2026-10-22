// @vitest-environment happy-dom
// r28 (PM's r44 real-app check): the Chief of Staff 1:1 showed "Usage limit reached (429): You've hit your weekly
// limit…". A Mono's 1:1 says a failed turn in plain words, the same error kinds as the rail, Today and Being built
// (turnFailure.ts), and never a status code; the CLI's own "API Error: 429 …" line goes with it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainChatError, resetClock } from "../../monos/model/turnFailure";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

vi.mock("../../settings/model/sounds", () => ({ playCue: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const NOW = Date.now();
const RESETS = NOW + 3 * 86_400_000;
const weekly: Block = {
  id: "err",
  role: "system",
  notice: "error",
  text: "Usage limit reached (429): You've hit your weekly limit. Example: try again later.",
  failure: { errorClass: "usage_limit", retryable: true, resetsAt: RESETS, at: NOW },
};
const blocks: Block[] = [
  { id: "u", role: "user", text: "Example: status? one line" },
  { id: "api", role: "assistant", text: "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}" },
  weekly,
];
const render = (mono: boolean) =>
  act(() =>
    root.render(
      createElement(AgentTranscript, {
        blocks,
        busy: false,
        inlineWork: true,
        bottomAligned: true,
        agentName: "Example: Chief of Staff",
        ...(mono ? { agentMascot: { mascot: "cat" as const, color: "#f97316" } } : {}),
        hideTurnMetrics: true,
      }),
    ),
  );

it("a Mono's 1:1 reads 'Out of usage this week. It resets <day time>.', with no status code and no API Error line", () => {
  render(true);
  const text = container.textContent ?? "";
  expect(text).toContain(`Out of usage this week. It resets ${resetClock(RESETS, NOW)}.`);
  expect(text).not.toMatch(/\b4\d\d\b|5\d\d\b|API Error|Usage limit reached|rate_limit/);
});

describe("plain words for each error kind, never a code", () => {
  const say = (failure: Block["failure"], text: string) => plainChatError({ text, failure }, NOW);
  it("maps the same kinds as the rail", () => {
    expect(say({ errorClass: "usage_limit" }, "Usage limit reached (429)")).toBe("Out of usage.");
    expect(say({ errorClass: "billing" }, "Billing refused (402): Insufficient credits")).toBe("Out of credits. Add credits, then try again.");
    expect(say({ errorClass: "auth" }, "Auth refused (401): OAuth token has expired")).toBe("Signed out of the model. Sign in again, then try again.");
    expect(say({ errorClass: "overloaded" }, "API overloaded (529)")).toBe("The model is overloaded. Try again in a moment.");
    expect(say({ errorClass: "provider_error", retryable: true }, "Provider error (500): boom")).toBe("The model's API failed.");
    expect(say(undefined, "API Error: 500 Example: something broke (500)")).toBe("Example: something broke");
  });
});
