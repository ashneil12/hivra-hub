// @vitest-environment happy-dom
// Gap A7: the card a quiet ask's Needs you row opens. Its three answers each do their own thing and say so: Answer it
// takes the person to the chat and leaves the card as it is; Let it go and Remind say what they did.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ask } from "../../asks/model/asks";
import { resetAnswered } from "../model/answeredNeeds";
import { needsYou, type NeedsItem } from "../model/needsYou";
import { quietAskFacts, type QuietAskDeps } from "../model/quietAsks";
import { NeedDetail, AnsweredLine } from "./NeedDetail";
import { needSummary } from "./InboxNeeds";
import { useLastAnswered } from "../model/answeredNeeds";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 15, 12);
const ASKED = NOW - 50 * HOUR;
let container: HTMLDivElement;
let root: Root;

const row: Ask = {
  id: "ask-4-blk4",
  n: 4,
  mateId: "mia",
  sessionId: "mia-chat",
  blockId: "blk4",
  quote: "Example: fix the invoice export so it stops dropping the last row",
  summary: "Fix the invoice export",
  kind: "do",
  status: "heard",
  heardBy: "model",
  createdAt: ASKED,
  updatedAt: ASKED,
  history: [{ at: ASKED, status: "heard", by: "app" }],
  chase: { at: ASKED, checks: 2, raisedAt: NOW - HOUR },
};

function deps(over: Partial<QuietAskDeps> = {}): QuietAskDeps {
  return {
    now: NOW,
    mate: () => ({ name: "Mia", projectId: "exo" }),
    jump: vi.fn(),
    letGo: vi.fn(async () => undefined),
    remind: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    ...over,
  };
}

function need(d: QuietAskDeps): NeedsItem {
  return needsYou({ asks: quietAskFacts([row], d) }, NOW)[0];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetAnswered();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAnswered();
  vi.unstubAllGlobals();
});

async function show(item: NeedsItem, compact = false) {
  await act(async () => {
    root.render(createElement(NeedDetail, { item, now: NOW, compact }));
  });
}

const choice = (letter: string) => container.querySelector(`[data-need-choice="${letter}"]`) as HTMLButtonElement;
const state = () => container.querySelector("[data-need-choices]")?.getAttribute("data-need-choices");

it("shows the ask as the title, the quiet line under it, and the three answers lettered", async () => {
  await show(need(deps()));
  expect(container.querySelector("[data-need-kind]")?.textContent).toBe("Ask");
  expect(container.querySelector("[data-need-sentence]")?.textContent).toBe("You asked: Example: fix the invoice export so it stops dropping the last row");
  expect(container.querySelector("[data-need-line]")?.textContent).toBe("Still open since Friday. Mia hasn't moved it.");
  expect(container.querySelector("[data-need-from]")?.textContent).toBe("Mia · 2 d ago");
  expect(["a", "b", "c"].map((letter) => choice(letter).textContent)).toEqual(["aAnswer it", "bLet it go", "cRemind Mia"]);
  expect(container.querySelector("[data-need-reply] textarea")).not.toBeNull();
  expect(container.textContent).not.toMatch(/[—–]/);
  expect(container.textContent).not.toMatch(/\bStuck\b/);
});

it("the row says how many answers it offers", () => {
  expect(needSummary(need(deps()))).toBe("3 answers");
});

it("Answer it opens the chat and leaves the card as it was: no 'Sent', nothing answered", async () => {
  const d = deps();
  await show(need(d));
  await act(async () => choice("a").click());
  expect(d.jump).toHaveBeenCalledTimes(1);
  expect(state()).toBe("idle");
  expect(container.querySelector("[data-need-choice-state]")).toBeNull();
  expect(choice("b").disabled).toBe(false);
});

it("Let it go says it was let go, and the answered line says the same when the row is gone", async () => {
  const d = deps();
  const item = need(d);
  await show(item);
  await act(async () => choice("b").click());
  expect(d.letGo).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-need-choice-state='answered']")?.textContent).toBe("Let go. It is off your list.");
  function Gone() {
    const entry = useLastAnswered(item.key);
    return entry ? createElement(AnsweredLine, { entry }) : null;
  }
  await act(async () => {
    root.render(createElement(Gone));
  });
  expect(container.querySelector("[data-need-answered]")?.textContent).toBe("Let go. It is off your list.");
});

it("Remind says the first mate was reminded", async () => {
  const d = deps();
  await show(need(d));
  await act(async () => choice("c").click());
  expect(d.remind).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-need-choice-state='answered']")?.textContent).toBe("Reminded Mia.");
});

it("a refused answer says why and keeps the card", async () => {
  const d = deps({ letGo: vi.fn(async () => "That one moved while you were looking.") });
  await show(need(d));
  await act(async () => choice("b").click());
  expect(container.querySelector("[data-need-choice-state='refused']")?.textContent).toBe("That one moved while you were looking.");
});

it("the box sends a few words to that chat", async () => {
  const d = deps();
  await show(need(d));
  const box = container.querySelector("[data-need-reply] textarea") as HTMLTextAreaElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(box, "Do the CSV one first");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => (container.querySelector("[data-need-reply] button[type='submit']") as HTMLButtonElement).click());
  expect(d.reply).toHaveBeenCalledWith(expect.objectContaining({ id: "ask-4-blk4" }), NOW - HOUR, "Do the CSV one first");
  expect(container.querySelector("[data-need-reply-state='answered']")?.textContent).toBe("Sent. Mia has it.");
});

it("opened under its row (the Chief's list) it shows the same answers", async () => {
  await show(need(deps()), true);
  expect(["a", "b", "c"].map((letter) => choice(letter)?.textContent)).toEqual(["aAnswer it", "bLet it go", "cRemind Mia"]);
});
