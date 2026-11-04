// @vitest-environment happy-dom
// A failed send, retry or stop does not try again by itself. The note must not say it does.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resetCrewFocus } from "../model/focus";
import { registerCrewDelegate } from "../model/retry";
import { CrewPanel } from "./CrewPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const PROJECT = "/work/proj";

function row(status: string, id: string) {
  return {
    id,
    project: PROJECT,
    title: "Fix the save bug",
    status,
    brief: "Fix the save bug in the project.",
    ownerSession: "lead",
    childSession: `chat-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("crew notes when an action does not run", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetCrewFocus();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    registerCrewDelegate(null);
    resetCrewFocus();
    vi.unstubAllGlobals();
  });

  async function mount(status: string, id: string) {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "delegations_list_open" || cmd === "delegations_recent") return [row(status, id)];
      if (cmd === "steering_record" || cmd === "delegations_cancel") throw new Error("not now");
      return [];
    });
    await act(async () => {
      root.render(createElement(CrewPanel, { project: PROJECT, sessions: [], onOpenSession: () => {} }));
    });
  }

  it("says to try again, and does not claim a send, retry or stop is already retrying", async () => {
    await mount("working", "live");
    await vi.waitFor(() => {
      expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Message")).toBe(true);
    });
    const message = [...container.querySelectorAll("button")].find((button) => button.textContent === "Message");
    act(() => message?.click());
    const input = container.querySelector("input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Hold on.");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent === "Send");
    await act(async () => {
      send?.click();
    });
    expect(container.textContent).toContain("Couldn't send that. Try again.");
    expect(container.textContent).not.toContain("Trying again.");

    act(() => root.unmount());
    root = createRoot(container);
    registerCrewDelegate(async () => {
      throw new Error("not now");
    });
    await mount("failed", "broke");
    await vi.waitFor(() => {
      expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
    });
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    await act(async () => {
      retry?.click();
    });
    expect(container.textContent).toContain("Couldn't retry that. Try again.");
    expect(container.textContent).not.toContain("Trying again.");

    act(() => root.unmount());
    root = createRoot(container);
    await mount("working", "live");
    await vi.waitFor(() => {
      expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Stop")).toBe(true);
    });
    const stop = [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop");
    act(() => stop?.click());
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop it");
    await act(async () => {
      confirm?.click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Couldn't stop that. Try again."));
    expect(container.textContent).not.toContain("Trying again.");
  });
});
