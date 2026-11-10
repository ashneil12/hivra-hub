// @vitest-environment happy-dom
// WP-120: the lead strip shows only when this CLI cannot lead, and it offers only
// the CLIs Ash ticked at first launch that can lead and are installed here.
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

function show(harness: string, onSwitch = vi.fn()) {
  act(() => root.render(createElement(LeadCliNotice, { harness, onSwitch })));
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
    expect(container.textContent).toContain("Switch the lead. This crew and its memory stay.");
    expect(offered()).toEqual(["claude"]);
  });

  it("offers nothing when Ash chose no CLI that can lead, and still says why", () => {
    installedHere(["claude", "codex", "opencode"]);
    saveChosenClis(["opencode", "cursor"]);
    show("opencode");
    expect(offered()).toEqual([]);
    expect(container.querySelector("[data-lead-cli-reason]")?.textContent).toContain("cannot lead yet");
    expect(container.textContent).not.toContain("Switch the lead.");
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
});
