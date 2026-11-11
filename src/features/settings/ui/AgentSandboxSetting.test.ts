// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { AgentSandboxSetting } from "./AgentSandboxSetting";
import { AGENT_SANDBOX_DESCRIPTION, AGENT_SANDBOX_ENVIRONMENT_NOTE, AGENT_SANDBOX_LABEL } from "../model/agentSandbox";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
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
    root.render(createElement(AgentSandboxSetting));
  });
}

function toggle(): HTMLButtonElement {
  const button = host.querySelector('button[role="switch"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("missing switch");
  return button;
}

describe("AgentSandboxSetting", () => {
  it("is off and locked until the app has answered, under the plain label", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    await render();
    expect(host.querySelector("#setting-agent-sandbox")?.getAttribute("data-setting-id")).toBe("agent-sandbox");
    expect(host.textContent).toContain(AGENT_SANDBOX_LABEL);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(true);
    expect(host.textContent).not.toMatch(/[—–]/);
  });

  it("shows the app's choice once it answers", async () => {
    vi.mocked(invoke).mockResolvedValue({ supported: true, enabled: true, setByEnvironment: false });
    await render();
    expect(invoke).toHaveBeenCalledWith("agent_sandbox_status");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(toggle().disabled).toBe(false);
  });

  it("saves a change through the app and shows the answer it kept", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ supported: true, enabled: false, setByEnvironment: false })
      .mockResolvedValueOnce({ supported: true, enabled: true, setByEnvironment: false });
    await render();
    await act(async () => toggle().click());
    expect(invoke).toHaveBeenLastCalledWith("agent_sandbox_set", { enabled: true });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the last answer and says why when the app refuses the change", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ supported: true, enabled: false, setByEnvironment: false })
      .mockRejectedValueOnce("the settings folder is read-only");
    await render();
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("the settings folder is read-only");
  });

  it("cannot be changed when the environment decides, and says so", async () => {
    vi.mocked(invoke).mockResolvedValue({ supported: true, enabled: true, setByEnvironment: true });
    await render();
    expect(toggle().disabled).toBe(true);
    expect(host.textContent).toContain(AGENT_SANDBOX_ENVIRONMENT_NOTE);
  });

  it("is not shown where the sandbox does not exist", async () => {
    vi.mocked(invoke).mockResolvedValue({ supported: false, enabled: false, setByEnvironment: false });
    await render();
    expect(host.querySelector("#setting-agent-sandbox")).toBeNull();
  });

  it("describes the limit honestly: a known list, not a full cage, with what is likely to break", () => {
    expect(AGENT_SANDBOX_DESCRIPTION).toContain("Off by default");
    expect(AGENT_SANDBOX_DESCRIPTION).toContain("does not cover other files");
    expect(AGENT_SANDBOX_DESCRIPTION).toContain("not a full cage");
    expect(AGENT_SANDBOX_DESCRIPTION).toContain("security");
    expect(AGENT_SANDBOX_DESCRIPTION).toContain("git push -u");
    expect(AGENT_SANDBOX_DESCRIPTION).not.toMatch(/[—–]/);
  });
});
