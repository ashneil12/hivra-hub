// @vitest-environment happy-dom
// r27b (ed, against Ash's words): red "Needs you" is any Lead problem only Ash can fix, not only a Lead giving up.
// A Lead's failed turn is classed by the error kind the app already has (the provider's error class, read by
// plainFailure): billing and sign-in, and a request the model refuses, are the red Needs you with the plain reason and
// "Open <Lead>'s chat", on the rail as on Today and Being built (MonoFailureCard); a usage limit, an overloaded model, a
// dropped connection or an unknown failure is a grey "Can't answer". No amber anywhere.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../integrations/harness/core/apply";
import type { ProviderErrorClass } from "../../integrations/harness/core/types";
import { newSession, type Session } from "../../features/sessions/model/session";
import { createMono, saveMonoName, saveMonoSessionId } from "../../features/monos/model/mono";
import { monoFailures, noteMonoFailures, resetMonoFailures, setMonoFailuresHost } from "../../features/monos/model/monoFailures";
import { plainFailure } from "../../features/monos/model/turnFailure";
import { MonoFailureList } from "../../features/monos/ui/MonoFailureCard";
import { failureChip } from "../../features/hub/model/statusChip";
import { MonoRailSection } from "./MonoRailSection";

let root: Root;
let container: HTMLElement;
let lead = "";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  resetMonoFailures();
  const mono = createMono(["/p/tally"]);
  saveMonoName(mono.id, "Example: Tally lead");
  saveMonoSessionId(mono.id, "lead-chat");
  lead = mono.id;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("which failures are Ash's to fix", () => {
  const chip = (errorClass: ProviderErrorClass | undefined, detail: string, retryable?: boolean) =>
    failureChip(plainFailure({ errorClass, ...(retryable !== undefined ? { retryable } : {}) }, detail).tone);
  it("billing, sign-in and a refused request are the red Needs you; a limit, overload, lost connection or unknown are a grey Can't answer", () => {
    expect(chip("billing", "Insufficient credits")).toEqual({ word: "Needs you", tone: "red" });
    expect(chip("billing", "Card declined")).toEqual({ word: "Needs you", tone: "red" });
    expect(chip("auth", "OAuth token has expired. Please run /login")).toEqual({ word: "Needs you", tone: "red" });
    expect(chip("auth", "invalid x-api-key")).toEqual({ word: "Needs you", tone: "red" });
    expect(chip("provider_error", "400 invalid model", false)).toEqual({ word: "Needs you", tone: "red" });
    expect(chip("usage_limit", "")).toEqual({ word: "Can't answer", tone: "grey" });
    expect(chip("overloaded", "529")).toEqual({ word: "Can't answer", tone: "grey" });
    expect(chip("provider_error", "socket hang up", false)).toEqual({ word: "Can't answer", tone: "grey" });
    expect(chip("provider_error", "500", true)).toEqual({ word: "Can't answer", tone: "grey" });
    expect(chip(undefined, "")).toEqual({ word: "Can't answer", tone: "grey" });
  });
});

const mount = (state: { status: "failed"; activity: string; tone: "red" | "grey" }, onOpen = vi.fn()) => {
  act(() =>
    root.render(createElement(MonoRailSection, { states: new Map([[lead, state]]) as never, onOpen, onCreate: () => {}, onDelete: () => {} })),
  );
  return onOpen;
};

describe("a Lead's failed turn on the rail", () => {
  it("only Ash can fix it: the red Needs you, the plain reason, and Open <Lead>'s chat", () => {
    const onOpen = mount({ status: "failed", activity: "Out of credits", tone: "red" });
    const line = container.querySelector<HTMLElement>(`[data-mono-failed="${lead}"]`)!;
    expect(line.dataset.monoFailedChip).toBe("Needs you");
    expect(line.querySelector("[data-hub-circle=red]")?.textContent).toBe("Needs you");
    expect(line.querySelector("[data-hub-needs-reason]")?.textContent).toBe("Out of credits");
    const link = line.querySelector<HTMLButtonElement>("[data-hub-open-lead]")!;
    expect(link.textContent).toBe("Open Example: Tally lead's chat");
    act(() => link.click());
    expect(onOpen).toHaveBeenCalledWith(lead);
    expect(container.querySelectorAll(".text-amber-400, .bg-amber-400")).toHaveLength(0);
    // No spinning or working mark on a Needs you (Critiquito, r27c).
    expect(line.querySelector("[data-mono-failed-retry], .animate-spin, [class*='animate-']")).toBeNull();
  });

  it("it should come right by itself: a grey Can't answer with the reason, nothing red or amber", () => {
    mount({ status: "failed", activity: "The model is overloaded", tone: "grey" });
    const line = container.querySelector<HTMLElement>(`[data-mono-failed="${lead}"]`)!;
    expect(line.dataset.monoFailedChip).toBe("Can't answer");
    expect(line.querySelector("[data-hub-circle=grey]")?.getAttribute("aria-label")).toBe("Can't answer");
    expect(line.querySelector("[data-mono-failed-reason]")?.textContent).toBe("The model is overloaded");
    expect(line.querySelector("[data-mono-failed-retry]")).not.toBeNull(); // Try again can help here
    expect(container.querySelectorAll("[data-hub-circle=red], .text-red-400, .bg-red-400, .text-amber-400, .bg-amber-400")).toHaveLength(0);
  });
});

describe("the same failure on Today and Being built (MonoFailureCard)", () => {
  const chat = (errorClass: "billing" | "overloaded", message: string): Session => {
    const s: Session = { ...newSession("claude", "/p/tally"), id: "lead-chat", busy: true, blocks: [{ id: "u", role: "user", text: "status?" }] };
    return { ...applyHarnessEvent(s, { type: "session.error", message, errorClass, retryable: errorClass !== "billing" }), busy: false };
  };
  it("out of credits: the red Needs you with why and Open <Lead>'s chat; overloaded: a grey Can't answer", () => {
    const open = vi.fn();
    setMonoFailuresHost({ retry: () => true, open });
    noteMonoFailures([chat("billing", "Billing refused (402): Insufficient credits")]);
    act(() => root.render(createElement(MonoFailureList, { failures: monoFailures(), now: Date.now() })));
    const card = container.querySelector<HTMLElement>("[data-mono-failure]")!;
    expect(card.querySelector("[data-hub-circle=red]")?.textContent).toBe("Needs you");
    expect(card.querySelector("[data-mono-failure-line]")?.textContent).toContain("Out of credits");
    const link = card.querySelector<HTMLButtonElement>("[data-hub-open-lead]")!;
    expect(link.textContent).toBe("Open Example: Tally lead's chat");
    act(() => link.click());
    expect(open).toHaveBeenCalledWith(lead);
    noteMonoFailures([chat("overloaded", "API overloaded (529)")]);
    act(() => root.render(createElement(MonoFailureList, { failures: monoFailures(), now: Date.now() })));
    expect(container.querySelector("[data-mono-failure] [data-hub-circle]")?.getAttribute("data-hub-circle")).toBe("grey");
    expect(container.querySelector("[data-mono-failure] [data-hub-chip]")?.textContent).toBe("Can't answer");
    expect(container.querySelectorAll("[data-hub-circle=red], .text-red-400, .text-amber-400")).toHaveLength(0);
  });
});

// r28: "Open <Lead>'s chat" sat inline on some rows and on its own line on others. Every one is on its own line, under
// the reason: the rail's line and the failure card, as on Today and Being built (statusChips.test.ts).
it("puts Open <Lead>'s chat on its own line under the reason, on the rail and the failure card", () => {
  mount({ status: "failed", activity: "Out of credits", tone: "red" });
  const links = [...container.querySelectorAll<HTMLElement>("[data-hub-open-lead]")];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    const line = link.parentElement!;
    expect(line.hasAttribute("data-hub-needs-link")).toBe(true);
    expect(line.tagName).toBe("DIV");
    expect(line.children).toHaveLength(1);
    // Its reason comes before it, not beside it.
    expect(line.previousElementSibling?.textContent).toContain("Out of credits");
  }
});

// Critiquito on r30: a red row's "Open <Lead>'s chat" was a plain underlined link while the grey rows' was a button.
it("gives a red row's Open <Lead>'s chat the same button look as the grey rows'", () => {
  mount({ status: "failed", activity: "Out of credits", tone: "red" });
  const links = [...container.querySelectorAll<HTMLElement>("[data-hub-open-lead]")];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.className).toMatch(/\bborder\b/);
    expect(link.className).not.toMatch(/\bbg-accent\b/);
    expect(link.className).not.toMatch(/bg-content\/8/);
    expect(link.className).not.toMatch(/underline/);
  }
});
