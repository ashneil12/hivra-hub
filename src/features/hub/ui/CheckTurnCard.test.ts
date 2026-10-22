// @vitest-environment happy-dom
// A `[MonoCode check]` turn in a Lead's chat is one quiet collapsed line (CheckTurnCard.tsx): never Ash's words, the
// checker's note and the Lead's answer only behind a click, an approval it waits on still in plain sight.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";
import { AgentTranscript } from "../../sessions/ui/AgentTranscript";

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

const ash: Block = { id: "u1", role: "user", text: "Fix the save bug on mission two and make the HUD calmer.", startedAt: Date.UTC(2026, 9, 20, 8, 20) };
const reply: Block = { id: "a1", role: "assistant", text: "Recorded the save bug and delegated it." };
const prompt: Block = {
  id: "p1",
  role: "user",
  text: "[MonoCode check] The checker looked at Ash's message from 20 Oct 08:20 that this chat owns (dump d_1020a) and found: the HUD ask was not recorded. Is this right?",
  internal: true,
  appRequestId: "mono-check-ck_1",
  monoCheck: { id: "ck_1", dumpId: "d_1020a", finding: "The HUD ask was not recorded. Is this right?" },
  startedAt: Date.UTC(2026, 9, 20, 9, 23),
};
const answer: Block = { id: "a2", role: "assistant", text: "Right: Ash said the HUD can wait until after the demo." };

function render(blocks: Block[], busy = false) {
  act(() =>
    root.render(
      createElement(AgentTranscript, {
        blocks,
        busy,
        inlineWork: true,
        bottomAligned: true,
        agentName: "EXO lead",
        agentMascot: { mascot: "robot", color: "#888" },
        daySeparators: true,
        hideTurnMetrics: true,
      }),
    ),
  );
}

it("shows the check as one quiet collapsed line, never as Ash's words", () => {
  render([ash, reply, prompt, answer]);
  const card = container.querySelector('[data-mono-check="ck_1"]')!;
  expect(card).not.toBeNull();
  expect(card.textContent).toContain("Checker's note · answered: right");
  expect(container.textContent).not.toContain("[MonoCode check]");
  // The note and the answer wait behind the click.
  expect(container.textContent).not.toContain("the HUD can wait");
  expect(container.textContent).toContain("Recorded the save bug and delegated it.");
  const toggle = card.querySelector("button")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  act(() => toggle.click());
  expect(card.textContent).toContain("The checker noticed: The HUD ask was not recorded. Is this right?");
  expect(card.textContent).toContain("EXO lead answered: Right: Ash said the HUD can wait until after the demo.");
});

it("says it is looking while the Lead answers", () => {
  render([ash, reply, prompt], true);
  expect(container.querySelector('[data-mono-check="ck_1"]')!.textContent).toContain("Checker's note · looking at it");
});

it("marks a fixed answer with nothing behind it as not proven, and says what it was worth", () => {
  const fixed: Block = { id: "a3", role: "assistant", text: "Fixed: the save path retries." };
  render([prompt, fixed]);
  const card = container.querySelector('[data-mono-check="ck_1"]')!;
  expect(card.textContent).toContain("Checker's note · answered: fixed, not proven");
  act(() => card.querySelector("button")!.click());
  expect(card.querySelector("[data-claim-confidence]")?.getAttribute("data-claim-confidence")).toBe("guess");
  expect(card.textContent).toContain("Evidence: Says it's fixed");
  expect(card.textContent).toContain("nothing the app can see was run to check it");
});

it("marks a fixed answer with a check it ran and passed as verified", () => {
  const run: Block = {
    id: "t1",
    role: "tool",
    text: "",
    tool: { callId: "c1", title: "npx vitest run src/save.test.ts", kind: "execute", status: "completed" },
  };
  const fixed: Block = { id: "a3", role: "assistant", text: "Fixed: the save path retries." };
  render([prompt, run, fixed]);
  const card = container.querySelector('[data-mono-check="ck_1"]')!;
  expect(card.textContent).toContain("Checker's note · answered: fixed, verified");
  act(() => card.querySelector("button")!.click());
  expect(card.querySelector("[data-claim-confidence]")?.getAttribute("data-claim-confidence")).toBe("verified");
  expect(card.textContent).toContain("1 check ran in this turn and passed (npx vitest run src/save.test.ts)");
});

it("keeps an approval the answer waits on in plain sight", () => {
  const approval: Block = { id: "ap", role: "approval", text: "Run ash_record?", approval: { requestId: 7 } };
  render([prompt, approval], true);
  expect(container.querySelector('[data-mono-check="ck_1"]')).toBeNull();
});
