// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { TeamWorkspaceSetting } from "./TeamWorkspaceSetting";

const LABEL = "Share projects with my team";
const OFF = { enabled: false, endpoint: "", endpointConfigured: false, signedIn: false, active: false };

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
    root.render(createElement(TeamWorkspaceSetting));
  });
}

function toggle(): HTMLInputElement {
  const input = host.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("missing switch");
  return input;
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`missing button ${text}`);
  return found;
}

function field(label: string): HTMLInputElement {
  const input = host.querySelector(`input[aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`missing field ${label}`);
  return input;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("is off by default, with a plain label, and says nothing leaves the computer", async () => {
  vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
  await render();
  expect(host.textContent).toContain(LABEL);
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(true);

  act(() => root.unmount());
  root = createRoot(host);
  vi.mocked(invoke).mockResolvedValue(OFF);
  await render();
  expect(invoke).toHaveBeenCalledWith("team_workspace_status");
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(false);
  expect(host.textContent).toContain("Off. Nothing leaves this computer.");
  expect(host.textContent).not.toMatch(/[—–]/);
  expect(host.textContent).not.toContain("/Users/");
});

it("turning it on saves the switch with the address, and shows the next step", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(OFF);
  await render();
  vi.mocked(invoke).mockResolvedValueOnce({ ...OFF, enabled: true });
  await act(async () => {
    toggle().click();
  });
  expect(invoke).toHaveBeenLastCalledWith("team_workspace_save", { enabled: true, endpoint: "" });
  expect(toggle().checked).toBe(true);
  expect(host.textContent).toContain("On. Add the team server address to start sharing.");
});

it("saves a server address with the switch and shows it is in use once a token is held", async () => {
  let saved = { ...OFF, enabled: true };
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "team_workspace_status") return saved;
    if (command === "team_workspace_presence") return [];
    if (command === "team_workspace_save") {
      saved = {
        enabled: true,
        endpoint: "https://team.example.test/v1",
        endpointConfigured: true,
        signedIn: true,
        active: true,
      };
      return saved;
    }
    throw new Error(`unexpected ${command}`);
  });
  await render();
  await act(async () => {
    type(field("Team server address"), " https://team.example.test/v1 ");
  });
  await act(async () => {
    button("Save").click();
  });
  expect(invoke).toHaveBeenCalledWith("team_workspace_save", {
    enabled: true,
    endpoint: "https://team.example.test/v1",
  });
  expect(host.textContent).toContain("On. Shared projects sync with the team server.");
});

it("goes back to off when the app refuses the change, and says why", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(OFF);
  await render();
  vi.mocked(invoke).mockRejectedValueOnce("the endpoint must be an https address");
  await act(async () => {
    toggle().click();
  });
  expect(toggle().checked).toBe(false);
  expect(host.textContent).toContain("the endpoint must be an https address");
});

it("joins with an invitation only once the switch is on and an address is saved", async () => {
  const onAndAddressed = {
    ...OFF,
    enabled: true,
    endpoint: "https://team.example.test/v1",
    endpointConfigured: true,
  };
  const joined = { ...onAndAddressed, signedIn: true, active: true };
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "team_workspace_status") return onAndAddressed;
    if (command === "team_workspace_presence") return [];
    if (command === "team_workspace_accept") return joined;
    throw new Error(`unexpected ${command}`);
  });
  await render();
  expect(button("Join").disabled).toBe(true);

  await act(async () => {
    type(field("Invitation code"), "  abc123  ");
    type(field("Your name"), " ann ");
  });
  await act(async () => {
    button("Join").click();
  });
  expect(invoke).toHaveBeenCalledWith("team_workspace_accept", {
    invitation: "abc123",
    account: "ann",
  });
  expect(host.textContent).not.toContain("abc123");
});

it("lists who is checked in at the team server while sharing is active", async () => {
  const active = {
    ...OFF,
    enabled: true,
    endpoint: "https://team.example.test/v1",
    endpointConfigured: true,
    signedIn: true,
    active: true,
  };
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "team_workspace_presence") return ["ann", "ben"];
    return active;
  });
  await render();
  expect(invoke).toHaveBeenCalledWith("team_workspace_presence");
  expect(host.textContent).toContain("Here now: ann, ben");
});

it("shows nobody here while the switch is off, and asks the server for nothing", async () => {
  vi.mocked(invoke).mockResolvedValue(OFF);
  await render();
  expect(invoke).not.toHaveBeenCalledWith("team_workspace_presence");
  expect(host.textContent).not.toContain("Here now");
});
