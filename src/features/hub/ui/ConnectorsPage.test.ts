// @vitest-environment happy-dom
// Settings → Connectors and Settings → Teams render against stand-ins for the Rust commands: every direct connector
// listed with its state, Composio off until switched on, a token sign-in that sends the secret only to the login
// command, and a new Marketing team made from the page.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubDataSource } from "../model/types";

let root: Root;
let container: HTMLElement;
const text = () => container.textContent ?? "";
const HIVRA = "/Users/ash/Projects/hivra";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.resetModules();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function setup() {
  const hub = await import("../model/hubData");
  const mock = await import("../model/mockData");
  hub.setHubDataSource({
    ...mock.mockHubData,
    listProjects: () => [{ id: "hivra", name: "Hivra", folder: HIVRA, iconShape: "sparkles" }],
  } as unknown as HubDataSource);
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const view = {
    settings: { composio: false, googleClient: false, connectors: {} as Record<string, unknown>, monos: {} },
    launcher: "/app/monocode",
    subcommand: "connector-run",
    kind: "dev",
  };
  const c = await import("../model/hubConnectors");
  c.setConnectorsBackend(async <T,>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "connectors_set_composio") view.settings.composio = args?.on as boolean;
    if (command === "connector_save_login")
      view.settings.connectors[args?.id as string] = { signedIn: true, method: "token", allow: args?.allow ?? [] };
    if (command === "connector_test") return { ok: true, message: "Connected as ash · 40 tools" } as T;
    return structuredClone(view) as T;
  });
  return { calls, view, c };
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Settings → Connectors", () => {
  it("lists every direct connector by category, with Composio off by default", async () => {
    const { c } = await setup();
    const { ConnectorsPage } = await import("./ConnectorsPage");
    await act(async () => root.render(createElement(ConnectorsPage)));
    await act(async () => c.loadConnectors());
    for (const name of ["GitHub", "Gmail", "Google Calendar", "Notion", "Slack", "Linear", "Supabase", "Vercel", "Stripe", "Telegram"])
      expect(text()).toContain(name);
    expect(container.querySelectorAll("[data-hub-connector]").length).toBe(c.directEntries().length);
    expect(container.querySelector('[data-hub-composio]')?.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[data-hub-connector="composio"]')).toBeNull();
    expect(text()).toContain("This dev copy keeps its own logins");
  });

  it("a pasted token goes only to the login command, then the row is Connected and tested", async () => {
    const { calls, c } = await setup();
    const { ConnectorsPage } = await import("./ConnectorsPage");
    await act(async () => root.render(createElement(ConnectorsPage)));
    await act(async () => c.loadConnectors());
    const row = () => container.querySelector('[data-hub-connector="github"]')!;
    await act(async () => (row().querySelector("button") as HTMLButtonElement).click());
    const field = row().querySelector('[data-hub-connector-field="token"]') as HTMLInputElement;
    expect(field.type).toBe("password");
    await act(async () => type(field, "ghp_SENTINEL_TOKEN"));
    const hivra = [...row().querySelectorAll("label")].find((l) => l.textContent === "Hivra")!.querySelector("input")!;
    await act(async () => hivra.click());
    await act(async () => (row().querySelector("[data-hub-connector-save]") as HTMLButtonElement).click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const carrying = calls.filter((x) => JSON.stringify(x.args ?? {}).includes("ghp_SENTINEL_TOKEN")).map((x) => x.command);
    expect(carrying).toEqual(["connector_save_login"]);
    expect(calls.find((x) => x.command === "connector_save_login")?.args?.allow).toEqual([HIVRA]);
    expect(calls.some((x) => x.command === "connector_test")).toBe(true);
    expect(container.querySelector('[data-hub-connectors-connected] [data-hub-connector="github"]')).not.toBeNull();
    expect(container.innerHTML).not.toContain("ghp_SENTINEL_TOKEN");
  });

  it("switching Composio on shows where its logins live and its own row", async () => {
    const { c } = await setup();
    const { ConnectorsPage } = await import("./ConnectorsPage");
    await act(async () => root.render(createElement(ConnectorsPage)));
    await act(async () => c.loadConnectors());
    await act(async () => (container.querySelector("[data-hub-composio]") as HTMLButtonElement).click());
    expect(container.querySelector("[data-hub-composio-note]")?.textContent).toContain("Composio's servers");
    expect(container.querySelector('[data-hub-connector="composio"]')).not.toBeNull();
  });
});

describe("Settings → Teams", () => {
  it("makes a Marketing team with its room, then its first Mono", async () => {
    await setup();
    const { TeamsPage } = await import("./TeamsPage");
    const teams = await import("../model/hubTeams");
    await act(async () => root.render(createElement(TeamsPage)));
    expect(text()).toContain("No teams yet");
    await act(async () => button("New team").click());
    await act(async () => type(container.querySelector("[data-hub-team-name]") as HTMLInputElement, "Marketing"));
    await act(async () => type(container.querySelector("[data-hub-team-brief]") as HTMLTextAreaElement, "Grow Hivra"));
    await act(async () => (container.querySelector('[data-hub-team-project="hivra"]') as HTMLInputElement).click());
    await act(async () => button("Make team").click());
    expect(teams.listTeams().map((t) => t.name)).toEqual(["Marketing"]);
    expect(text()).toContain("Marketing team is made, with its room");
    await act(async () => type(container.querySelector("[data-hub-mono-name]") as HTMLInputElement, "Maya"));
    expect(button("Make Maya")).toBeTruthy();
  });
});
