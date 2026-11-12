// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { COMPUTER_USE_LABEL, ComputerUseSetting } from "./ComputerUseSetting";
import { rememberComputerUse, type ComputerUseView } from "../model/computerUse";

let root: Root;
let host: HTMLDivElement;

const off: ComputerUseView = {
  settings: { enabled: false, mode: "observe", allowedApps: [], allowCoordinates: false, chats: {} },
  settingsPath: "/data/computer-use.json",
  sidecar: null,
  supported: true,
};

function answer(responses: Record<string, unknown>) {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const value = responses[command];
    return typeof value === "function" ? (value as (a: unknown) => unknown)(args) : value;
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  rememberComputerUse(undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => {
    root.render(createElement(ComputerUseSetting));
  });
}

const main = () => host.querySelector(`button[aria-label="${COMPUTER_USE_LABEL}"]`) as HTMLButtonElement;

describe("ComputerUseSetting (WP-255)", () => {
  it("is off and says how to install the helper, in plain words", async () => {
    answer({ computer_use_get: off, computer_use_activity: [] });
    await render();
    expect(host.querySelector("#setting-computer-use")?.getAttribute("data-setting-id")).toBe("computer-use");
    expect(main().getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("npm i -g open-computer-use");
    expect(host.textContent).toContain("always refused");
    expect(host.textContent).not.toMatch(/[—–]/);
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("turns on through the app and then shows the choices", async () => {
    const on = { ...off, settings: { ...off.settings, enabled: true }, sidecar: "/opt/homebrew/bin/open-computer-use" };
    answer({ computer_use_get: off, computer_use_activity: [], computer_use_put: on });
    await render();
    await act(async () => main().click());
    expect(invoke).toHaveBeenCalledWith("computer_use_put", {
      change: { enabled: true, mode: "observe", allowedApps: [], allowCoordinates: false },
    });
    expect(main().getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Look only");
    expect(host.textContent).toContain("Look and use");
    expect(host.textContent).not.toContain("npm i -g");
  });

  it("lists chats with their own say and the newest activity, never typed text", async () => {
    const on: ComputerUseView = {
      ...off,
      sidecar: "/x/open-computer-use",
      settings: { ...off.settings, enabled: true, mode: "control", chats: { "chat-1": "observe-only" } },
    };
    answer({
      computer_use_get: on,
      computer_use_activity: [
        { at: 1, chat: "chat-1", tool: "computer_type_text", app: "Notes", detail: "type 5 characters", allowed: true },
        { at: 0, chat: "chat-1", tool: "computer_get_app_state", app: "1Password", detail: "get app state", allowed: false },
      ],
      computer_use_set_chat: { ...on, settings: { ...on.settings, chats: {} } },
    });
    await render();
    expect(host.textContent).toContain("Look only in this chat");
    expect(host.textContent).toContain("Notes: type 5 characters");
    expect(host.textContent).toContain("refused");
    const follow = [...host.querySelectorAll("button")].find((b) => b.textContent === "Follow Settings")!;
    await act(async () => follow.click());
    expect(invoke).toHaveBeenCalledWith("computer_use_set_chat", { chat: "chat-1", mode: null });
    expect(host.textContent).not.toContain("Chats with their own say");
  });

  it("shows nothing off a Mac", async () => {
    answer({ computer_use_get: { ...off, supported: false }, computer_use_activity: [] });
    await render();
    expect(host.querySelector("#setting-computer-use")).toBeNull();
  });
});
