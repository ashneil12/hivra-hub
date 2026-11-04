// @vitest-environment happy-dom
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

describe("crew retry", () => {
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

  it("sends the same brief again through the delegate path", async () => {
    const brief = "Fix the save bug in the project.";
    const row = {
      id: "failed",
      project: PROJECT,
      title: "Save bug",
      status: "failed",
      brief,
      goal: "The save test passes.",
      ownerSession: "lead",
      childSession: "chat-failed",
      createdAt: 1,
      updatedAt: 1,
    };
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "delegations_list_open" || cmd === "delegations_recent") return [row];
      return [];
    });
    const sent: Array<{ owner: string; requestId: string; input: Record<string, unknown> }> = [];
    registerCrewDelegate(async (owner, requestId, input) => {
      sent.push({ owner, requestId, input });
    });
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
      expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
    });
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    await act(async () => {
      retry?.click();
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.owner).toBe("lead");
    expect(sent[0]?.input.brief).toBe(brief);
    expect(sent[0]?.input.redoes).toBe("failed");
    expect(sent[0]?.input.goal).toBe("The save test passes.");
    expect(sent[0]?.requestId).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
  });
});
