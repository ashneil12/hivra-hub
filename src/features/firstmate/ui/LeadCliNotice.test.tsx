// @vitest-environment happy-dom
// WP-120: the lead strip shows only when this CLI cannot lead, and it offers only
// the CLIs Ash ticked at first launch that can lead and are installed here. It speaks of this chat, not of the
// lead or of a crew the chat may not have, and Ash can close it for a chat.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitHarnessAvailability,
  setHarnessAvailability,
  type HarnessAvailability,
} from "../../../integrations/harness/core/availabilityState";
import { resetCodingTeamHomes, saveChosenClis } from "../../hub/model/codingTeamHome";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { applyLeadSwitch } from "../model/leadCli";
import { leadStripDismissed, resetLeadStripDismissals } from "../model/leadStripDismissal";
import { LeadCliNotice } from "./LeadCliNotice";

// The real gate, wrapped so a test can see the strip call it and can make it refuse.
vi.mock("../model/leadCli", async (importOriginal) => {
  const real = await importOriginal<typeof import("../model/leadCli")>();
  return { ...real, applyLeadSwitch: vi.fn(real.applyLeadSwitch) };
});

let root: Root;
let container: HTMLElement;

function installedHere(ids: HarnessId[]): void {
  const next = Object.fromEntries(HARNESSES.map((id) => [id, false])) as HarnessAvailability;
  for (const id of ids) next[id] = true;
  setHarnessAvailability(next);
}

function show(harness: string, extra: { sessionId?: string; hasCrew?: boolean } = {}, onSwitch = vi.fn()) {
  act(() =>
    root.render(createElement(LeadCliNotice, { harness, sessionId: "chat-1", onSwitch, ...extra })),
  );
  return onSwitch;
}

const offered = () =>
  [...container.querySelectorAll("[data-lead-cli]")].map((button) => button.getAttribute("data-lead-cli"));

beforeEach(() => {
  vi.mocked(applyLeadSwitch).mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetCodingTeamHomes();
  resetLeadStripDismissals();
  vi.unstubAllGlobals();
});

describe("the lead strip", () => {
  it("is not shown when the current CLI can lead", () => {
    installedHere(["claude", "codex"]);
    saveChosenClis(["claude", "codex"]);
    show("claude");
    expect(container.querySelector("[data-lead-cli-notice]")).toBeNull();
    show("codex");
    expect(container.querySelector("[data-lead-cli-notice]")).toBeNull();
  });

  it("offers only the capable CLIs Ash ticked, never the ones he did not", () => {
    // Codex is installed and can lead, but Ash never ticked it. Cursor and Pi were ticked but cannot lead.
    installedHere(["claude", "codex", "cursor", "grok", "opencode", "pi"]);
    saveChosenClis(["claude", "cursor", "pi"]);
    show("opencode");
    expect(container.querySelector("[data-lead-cli-reason]")?.textContent).toContain(
      "OpenCode cannot lead yet",
    );
    expect(offered()).toEqual(["claude"]);
  });

  it("offers nothing when Ash chose no CLI that can lead, and still says why", () => {
    installedHere(["claude", "codex", "opencode"]);
    saveChosenClis(["opencode", "cursor"]);
    show("opencode");
    expect(offered()).toEqual([]);
    expect(container.querySelector("[data-lead-cli-reason]")?.textContent).toContain("cannot lead yet");
    expect(container.textContent).not.toContain("Switch this chat");
  });

  it("drops a chosen CLI that is not installed here, and repeats of one he ticked twice", () => {
    installedHere(["claude"]);
    saveChosenClis(["codex", "codex", "claude", "not-a-cli"]);
    show("opencode");
    expect(offered()).toEqual(["claude"]);
  });

  it("switches to the CLI that was clicked", () => {
    installedHere(["claude", "codex"]);
    saveChosenClis(["claude", "codex"]);
    const onSwitch = show("opencode");
    const codex = container.querySelector<HTMLButtonElement>("[data-lead-cli=codex]");
    expect(codex).not.toBeNull();
    act(() => codex?.click());
    expect(onSwitch).toHaveBeenCalledWith("codex");
  });

  it("sends a pick through the switch gate and switches to what the gate returns", () => {
    installedHere(["claude", "codex"]);
    saveChosenClis(["claude", "codex"]);
    const onSwitch = show("opencode");
    act(() => container.querySelector<HTMLButtonElement>("[data-lead-cli=codex]")?.click());
    expect(applyLeadSwitch).toHaveBeenCalledTimes(1);
    expect(applyLeadSwitch).toHaveBeenCalledWith("opencode", "codex");
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith("codex");
  });

  it("does not switch when the gate refuses the pick", () => {
    installedHere(["claude", "codex"]);
    saveChosenClis(["claude", "codex"]);
    const onSwitch = show("opencode");
    vi.mocked(applyLeadSwitch).mockReturnValueOnce(null);
    act(() => container.querySelector<HTMLButtonElement>("[data-lead-cli=codex]")?.click());
    expect(applyLeadSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("does not switch to a CLI that left this machine after the strip drew", async () => {
    installedHere(["claude", "codex"]);
    saveChosenClis(["claude", "codex"]);
    const onSwitch = show("opencode");
    const codex = container.querySelector<HTMLButtonElement>("[data-lead-cli=codex]");
    expect(codex).not.toBeNull();
    // The probe reports Codex gone, and the click lands before React redraws the strip. The probe
    // runs outside React, so this emit is deliberately not inside act().
    installedHere(["claude"]);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    emitHarnessAvailability();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    codex?.click();
    expect(onSwitch).not.toHaveBeenCalled();
    await act(async () => {});
    expect(offered()).toEqual(["claude"]);
  });
  it("says it switches this chat, in plain words, and not that it switches the lead", () => {
    installedHere(["claude", "codex"]);
    saveChosenClis(["claude", "codex"]);
    show("opencode");
    const text = container.textContent ?? "";
    expect(container.querySelector("[data-lead-cli-reason]")?.textContent).toBe(
      "OpenCode cannot lead yet. The app has no way to give it the tools a lead uses to hand out jobs. Switch this chat to one that can. Its history stays.",
    );
    expect(text).not.toContain("Switch the lead");
    expect(text).not.toMatch(/\b(?:MCP|host|secret|session request|lead table)\b/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("names the crew only when this chat has one", () => {
    installedHere(["claude"]);
    saveChosenClis(["claude"]);
    show("opencode");
    expect(container.textContent).toContain("Its history stays.");
    expect(container.textContent).not.toMatch(/crew|workers/i);
    show("opencode", { hasCrew: true });
    expect(container.textContent).toContain("Its workers and history stay.");
    expect(container.textContent).not.toContain("crew");
  });

  it("closes for this chat when Ash dismisses it, and stays closed", () => {
    installedHere(["claude"]);
    saveChosenClis(["claude"]);
    show("opencode", { sessionId: "chat-1" });
    const dismiss = container.querySelector<HTMLButtonElement>("[data-lead-cli-dismiss]");
    expect(dismiss?.textContent).toBe("Dismiss");
    act(() => dismiss?.click());
    expect(container.querySelector("[data-lead-cli-notice]")).toBeNull();
    expect(leadStripDismissed("chat-1")).toBe(true);
    // Remembered: a fresh mount of the same chat, as after a restart, shows nothing.
    act(() => root.unmount());
    root = createRoot(container);
    show("opencode", { sessionId: "chat-1" });
    expect(container.querySelector("[data-lead-cli-notice]")).toBeNull();
    // Only that chat: another chat on a CLI that cannot lead still gets its strip.
    show("opencode", { sessionId: "chat-2" });
    expect(container.querySelector("[data-lead-cli-notice]")).not.toBeNull();
    expect(leadStripDismissed("chat-2")).toBe(false);
  });

  it("dismisses a strip that has no CLI to offer, too", () => {
    installedHere(["opencode"]);
    saveChosenClis(["opencode"]);
    show("opencode");
    expect(offered()).toEqual([]);
    act(() => container.querySelector<HTMLButtonElement>("[data-lead-cli-dismiss]")?.click());
    expect(container.querySelector("[data-lead-cli-notice]")).toBeNull();
  });
});
