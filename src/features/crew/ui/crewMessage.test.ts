// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resetCrewFocus } from "../model/focus";
import { CrewPanel } from "./CrewPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const PROJECT = "/work/proj";
// steering.rs TEXT_MAX. The store counts Unicode scalar values, not UTF-16 units.
const STORE_MAX = 8_000;

describe("crew message length", () => {
  let container: HTMLDivElement;
  let root: Root;
  let recorded: string[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetCrewFocus();
    recorded = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "delegations_list_open" || cmd === "delegations_recent") {
        return [
          {
            id: "working",
            project: PROJECT,
            title: "Fix the save bug",
            status: "working",
            ownerSession: "lead",
            childSession: "chat-working",
            createdAt: 1,
            updatedAt: 1,
          },
        ];
      }
      if (cmd === "steering_record") {
        const input = (args as { input?: { text?: string } } | undefined)?.input;
        recorded.push(input?.text ?? "");
        return { id: "m1" };
      }
      return [];
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCrewFocus();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => {
      root.render(
        createElement(CrewPanel, {
          project: PROJECT,
          sessions: [],
          onOpenSession: () => {},
        }),
      );
    });
    await vi.waitFor(() => {
      expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Message")).toBe(
        true,
      );
    });
    const message = [...container.querySelectorAll("button")].find((button) => button.textContent === "Message");
    act(() => message?.click());
  }

  function type(value: string) {
    const input = container.querySelector("input");
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("sends a message the store can hold, counting characters the way the store does", async () => {
    await mount();
    // One emoji is two UTF-16 units and one character. The store accepts 8000 of them.
    const text = "😀".repeat(STORE_MAX);
    type(text);
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent === "Send");
    await act(async () => {
      send?.click();
    });
    await vi.waitFor(() => expect(recorded).toEqual([text]));
    expect(container.querySelector("input")).toBeNull();
  });

  it("keeps a message the store would refuse, and says how long it can be", async () => {
    await mount();
    const text = "x".repeat(STORE_MAX + 1);
    type(text);
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent === "Send");
    await act(async () => {
      send?.click();
    });
    expect(recorded).toEqual([]);
    expect(container.querySelector("input")?.value).toBe(text);
    expect(container.textContent).toContain("8000");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
  });
});
