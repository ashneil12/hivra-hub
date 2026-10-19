// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { mockHubData } from "../model/mockData";
import { setHubDataSource } from "../model/hubData";
import { HubSurface } from "./HubSurface";
import type { Need } from "../model/types";
it("searches a 65-ask backlog across Later and Older without rendering the whole backlog at once", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const project = { id: "qa", name: "QA", shortName: "QA", iconShape: "folder" as const, folder: "/qa" };
  const needs: Need[] = Array.from({ length: 65 }, (_, i) => ({ id: `need-${i}`, projectId: "qa", title: `Tracked ask ${i}`, why: "Verify this", actionType: "open", actionLabel: "Open", later: i >= 5 }));
  setHubDataSource({ ...mockHubData, listProjects: () => [project], listNeeds: () => needs, listOlder: () => [{ ...needs[0], id: "old", title: "Recovered old question" }], listStuck: () => [], listSetup: () => [] });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    act(() => root.render(createElement(HubSurface, { selection: { project: "qa", item: "inbox" } })));
    expect(container.querySelectorAll("[data-hub-need]")).toHaveLength(5);
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search asks"]')!;
    act(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(search, "Tracked ask"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(container.textContent).toContain("65 matching asks");
    expect(container.querySelectorAll("[data-hub-search-results] [data-hub-need]")).toHaveLength(25);
    const more = [...container.querySelectorAll("button")].find((b) => b.textContent === "Show 25 more")!;
    act(() => more.click());
    expect(container.querySelectorAll("[data-hub-search-results] [data-hub-need]")).toHaveLength(50);
    act(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(search, "Recovered old"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(container.textContent).toContain("Recovered old question");
  } finally { act(() => root.unmount()); container.remove(); setHubDataSource(undefined); vi.unstubAllGlobals(); }
});
