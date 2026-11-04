import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPage } from "./ActivityPage";
import type { ActivityEntry } from "../model/activity";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const person = { role: "person" as const };
const ada = { role: "first-mate" as const, id: "lead-1", name: "Ada" };

function entry(summary: string, project = "acme/web"): ActivityEntry {
  return {
    id: summary,
    seq: 1,
    kind: "git.push",
    actor: ada,
    initiator: person,
    project,
    target: "work",
    summary,
    link: "",
    at: 1_700_000_000_000,
  };
}

describe("ActivityPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset().mockImplementation(async () => undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(props: { entries?: ActivityEntry[] } = {}) {
    await act(async () => {
      root.render(createElement(ActivityPage, props));
    });
  }

  it("says when nothing is recorded, and when a filter misses", async () => {
    await render({ entries: [] });
    expect(container.textContent).toContain("Nothing has been recorded yet.");

    const project = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(project, "missing");
      project.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Nothing matches.");
  });

  it("does not ask the app when it was given rows", async () => {
    await render({ entries: [entry("Pushed work.")] });
    expect(invoke).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Pushed work.");
  });

  it("shows the server's page as it is, and a late page does not replace a newer one", async () => {
    let resolveFirst: (page: unknown) => void = () => undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    vi.mocked(invoke).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return first;
      // The server's page is shown as it is, even when the row's project is not the filter.
      return { entries: [entry("Second.", "server-said-so")], next: null };
    });
    await render();
    expect(container.textContent).toContain("Nothing has been recorded yet.");

    const project = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(project, "other");
      project.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Second.");

    await act(async () => {
      resolveFirst({ entries: [entry("First.", "other")], next: null });
      await first;
    });
    expect(container.textContent).toContain("Second.");
    expect(container.textContent).not.toContain("First.");
    expect(container.textContent).not.toContain("Nothing matches.");
  });
});
