// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PanelTabsScreen } from "./PanelTabs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));

const board = {
  plugin: "my-panels",
  id: "board",
  title: "Example: board",
  spec: { kind: "bespoke", title: "Example: board", html: "<p>Example: board</p>", permissions: ["tasks.read"] },
};

function calls(): { cmd: string; args: unknown }[] {
  return vi.mocked(invoke).mock.calls.map((call) => ({ cmd: String(call[0]), args: call[1] }));
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

it("asks the catalog for this view, so a preview in another view is not this list", async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "panels_migrate") return { added: [], skipped: [] };
    if (cmd === "panels_catalog") return [];
    return undefined;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(PanelTabsScreen));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const catalog = calls().filter((call) => call.cmd === "panels_catalog");
  expect(catalog).toEqual([{ cmd: "panels_catalog", args: { view: "main" } }]);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

it("turns the plugin off in every scope it is on, not only the global one", async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "panels_migrate") return { added: [], skipped: [] };
    if (cmd === "panels_catalog") return [board];
    if (cmd === "plugins_list") {
      return { plugins: { "my-panels": { name: "my-panels", enabled: { global: true, projects: ["/tmp/demo project", "/tmp/demo project"] } } } };
    }
    return undefined;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(PanelTabsScreen));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const turnOff = host.querySelector("[data-panel-turn-off='my-panels']") as HTMLButtonElement;
  expect(turnOff).toBeTruthy();
  await act(async () => {
    turnOff.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const disabled = calls().filter((call) => call.cmd === "plugins_disable");
  expect(disabled).toEqual([
    { cmd: "plugins_disable", args: { name: "my-panels" } },
    { cmd: "plugins_disable", args: { name: "my-panels", project: "/tmp/demo project" } },
  ]);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

it("does not disable anything when the plugin list cannot be read", async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "panels_migrate") return { added: [], skipped: [] };
    if (cmd === "panels_catalog") return [board];
    if (cmd === "plugins_list") throw new Error("timed out");
    return undefined;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(PanelTabsScreen));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const turnOff = host.querySelector("[data-panel-turn-off='my-panels']") as HTMLButtonElement;
  await act(async () => {
    turnOff.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls().some((call) => call.cmd === "plugins_disable")).toBe(false);
  expect(host.querySelector("[data-panel-turn-off='my-panels']")).toBeTruthy();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});
