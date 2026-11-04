// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it, vi } from "vitest";
import type { PageSpec } from "../../pages/model/pageSpec";
import { PanelTabs, type CatalogPanel } from "./PanelTabs";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string, args: { key?: string }) => {
    if (cmd === "page_frame_put") return `page-${args.key}`;
    return undefined;
  }),
  convertFileSrc: (path: string) => `monoartifact://localhost/${path}`,
}));

const spec: PageSpec = {
  kind: "bespoke",
  title: "Example: board",
  html: "<p>Example: board</p>",
  js: "hub.watch('tasks.read', function () {})",
  permissions: ["tasks.read"],
};

const panel: CatalogPanel = { plugin: "my-panels", panelId: "board", title: spec.title, spec };

it("loads a bespoke panel through the Pages frame scheme, not srcdoc", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(PanelTabs, {
      catalog: [panel],
      rev: 1,
      onTurnOff: () => undefined,
    }));
  });
  const open = host.querySelector("[data-panel-open]") as HTMLButtonElement;
  await act(async () => {
    open.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const frame = host.querySelector("[data-panel-tab] iframe");
  expect(frame?.getAttribute("src") ?? "").toMatch(/^monoartifact:\/\/localhost\/page-/);
  expect(frame?.hasAttribute("srcdoc")).toBe(false);
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  await act(async () => {
    root.unmount();
  });
  host.remove();
});
