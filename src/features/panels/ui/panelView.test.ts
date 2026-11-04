// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it } from "vitest";
import { CSP, SANDBOX } from "../../pages/model/sandbox";
import type { PageSpec } from "../../pages/model/pageSpec";
import { PanelTabs, type CatalogPanel } from "./PanelTabs";

const spec: PageSpec = {
  kind: "bespoke",
  title: "Example: board",
  html: "<p>Example: board</p>",
  permissions: ["tasks.read"],
};

const panel: CatalogPanel = { plugin: "my-panels", panelId: "board", title: spec.title, spec };

it("renders a panel in the sandbox and removes the tab when the plugin is turned off", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let catalog = [panel];
  let rev = 1;
  const draw = () => {
    root.render(createElement(PanelTabs, {
      catalog,
      rev,
      onTurnOff: () => {
        catalog = [];
        rev = 2;
        draw();
      },
    }));
  };
  await act(async () => {
    draw();
  });
  expect(host.querySelector("h2")?.textContent).toBe("My panels");
  const open = host.querySelector("[data-panel-open]") as HTMLButtonElement;
  await act(async () => {
    open.click();
  });
  const tab = host.querySelector("[data-panel-tab]");
  expect(tab?.getAttribute("data-panel-grants")).toBe("tasks.read");
  expect(tab?.getAttribute("data-panel-plugin")).toBe("my-panels");
  const frame = tab?.querySelector("iframe");
  expect(frame?.getAttribute("sandbox")).toBe(SANDBOX);
  expect(frame?.getAttribute("srcdoc")).toContain(CSP);
  expect(frame?.getAttribute("srcdoc")).toContain("Example: board");
  const turnOff = host.querySelector("[data-panel-turn-off]") as HTMLButtonElement;
  await act(async () => {
    turnOff.click();
  });
  expect(host.querySelector("[data-panel-tab]")).toBeNull();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});
