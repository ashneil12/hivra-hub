// @vitest-environment happy-dom
// The Autopilot screen against the in-memory store: off, turning it on for a project with an end time, the log and the
// held red-list calls, and turning it off.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHubDataSource, type HubDataSource } from "../../hub/model/hubData";
import { setAutopilotBackend } from "../model/autopilot";
import { memoryAutopilot, type MemoryAutopilot } from "../model/memoryAutopilot";
import { AutopilotView } from "./AutopilotView";

let root: Root;
let container: HTMLElement;
let backend: MemoryAutopilot;

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}" in: ${container.textContent}`);
  return found as HTMLButtonElement;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  backend = memoryAutopilot();
  setAutopilotBackend(backend);
  setHubDataSource({
    listProjects: () => [
      { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/p/hivra" },
      { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "ghost", folder: "/p/exo" },
    ],
  } as unknown as HubDataSource);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  container.remove();
  setAutopilotBackend(null);
  setHubDataSource(undefined);
});

describe("AutopilotView", () => {
  it("starts off, with the red list and the usage-limit setting", async () => {
    await act(async () => root.render(createElement(AutopilotView)));
    await settle();
    expect(container.querySelector("[data-autopilot-switch]")?.getAttribute("data-autopilot-switch")).toBe("off");
    expect(container.textContent).toContain("Autopilot is off.");
    expect([...container.querySelectorAll("[data-autopilot-red-list] li")].map((li) => li.textContent)).toEqual([
      "Moving money, refunds or charges",
      "Deleting data without a restorable backup",
      "Production host maintenance",
      "Mass destructive operations",
      "Messages sent as Ash",
      "Credentials",
    ]);
    expect(container.querySelector('[data-autopilot-auto-resume] [role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("turns on for one project until the chosen time, logs it, and turns off", async () => {
    await act(async () => root.render(createElement(AutopilotView)));
    await settle();
    await act(async () => button("Hivra").click());
    await act(async () => button("For 8 hours").click());
    await act(async () => button("Turn on").click());
    await settle();
    const sw = backend.switches.get("hivra");
    expect(sw?.setBy).toBe("ash");
    expect(Math.abs(sw!.untilMs - (Date.now() + 8 * 3_600_000))).toBeLessThan(5 * 60_000);
    expect(backend.switches.has("*")).toBe(false);
    expect(container.querySelector("[data-autopilot-on='hivra']")?.textContent).toContain("On for Hivra until");
    expect(container.textContent).toContain("You turned it on here");
    expect(container.querySelector("[data-autopilot-keeps-going]")?.textContent).toContain("The Mac stays awake until it ends.");
    expect(container.querySelector("[data-autopilot-keeps-going]")?.textContent).toContain("Dev copies don't relaunch themselves.");
    expect(container.querySelector("[data-autopilot-log]")?.textContent).toContain("Autopilot on for hivra");
    await act(async () => button("Turn off").click());
    await settle();
    expect(backend.switches.size).toBe(0);
    expect(container.querySelector("[data-autopilot-switch]")?.getAttribute("data-autopilot-switch")).toBe("off");
  });

  it("shows each call with its pick, and the red-list calls waiting for Ash", async () => {
    await backend.set({ scopes: ["*"], untilMs: Date.now() + 40 * 3_600_000, by: "mono:chief-of-staff", said: "go autopilot until monday", who: "Chief of Staff" });
    await backend.log({ kind: "decision", outcome: "taken", what: "Split the fix into two PRs?", recommendation: "Yes, two PRs", who: "Hivra lead", project: "hivra", chatId: "c1" });
    await backend.log({ kind: "decision", outcome: "held", what: "Refund the double charge?", recommendation: "Refund it", red: "money", who: "Hivra lead", chatId: "c1" });
    await act(async () => root.render(createElement(AutopilotView)));
    await settle();
    const held = container.querySelector("[data-autopilot-held]")!;
    expect(held.textContent).toContain("Refund the double charge?");
    expect(held.textContent).toContain("Waiting for you: moving money, refunds or charges");
    const log = container.querySelector("[data-autopilot-log]")!.textContent!;
    expect(log).toContain("Split the fix into two PRs?");
    expect(log).toContain("→ Yes, two PRs");
    expect(log).toContain("Took its recommendation · Hivra lead · Hivra");
    // Leaving the page marks the log seen.
    await act(async () => root.unmount());
    root = createRoot(container);
    await settle();
    expect((await backend.status()).unseen).toBe(0);
  });
});
