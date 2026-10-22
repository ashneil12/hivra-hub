// @vitest-environment happy-dom
// Today's long "things waiting" list, like with like (Board 22 Oct: it read as one unsorted list), and Ash OS's
// internal tags ("Autofix: health:") never on a row.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { mockHubData } from "../model/mockData";
import { setHubDataSource } from "../model/hubData";
import { mapJob, mapNeed, plainWorkText } from "../model/hubStore";
import { HubSurface, needKind } from "./HubSurface";
import type { Need } from "../model/types";

const project = { id: "exo", name: "EXO", shortName: "EXO", iconShape: "folder" as const, folder: "/exo" };
const need = (id: string, patch: Partial<Need>): Need => ({ id, projectId: "exo", title: `Ask ${id}`, why: "", actionType: "open", actionLabel: "Open", ...patch });

describe("a project's Needs on Today", () => {
  it("sit in groups when mixed: to decide, to check, to look at, each with its count", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const needs = [
      need("a", { actionTarget: "question:q1", actionLabel: "See options" }),
      need("b", {}),
      need("c", { id: "s:c", actionType: "accept", actionLabel: "Looks right", canMarkSeen: true }),
      need("d", { actionTarget: "job:j1", jobId: "j1", actionLabel: "See options" }),
    ];
    setHubDataSource({ ...mockHubData, listProjects: () => [project], listNeeds: () => needs, listOlder: () => [], listStuck: () => [], listSetup: () => [] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(HubSurface, { selection: { project: "exo", item: "inbox" } })));
      const groups = [...container.querySelectorAll<HTMLElement>("[data-hub-need-group]")];
      expect(groups.map((g) => g.dataset.hubNeedGroup)).toEqual(["decide", "check", "read"]);
      expect(groups.map((g) => g.querySelector("h3")!.textContent)).toEqual(["To decide · 2", "To check · 1", "To look at · 1"]);
      expect(groups[0].querySelectorAll("[data-hub-need]")).toHaveLength(2);
      expect(container.querySelectorAll("[data-hub-need]")).toHaveLength(4);
    } finally {
      act(() => root.unmount());
      container.remove();
      setHubDataSource(undefined);
      vi.unstubAllGlobals();
    }
  });

  it("need no headings when they are all one kind", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const needs = [need("a", {}), need("b", {})];
    setHubDataSource({ ...mockHubData, listProjects: () => [project], listNeeds: () => needs, listOlder: () => [], listStuck: () => [], listSetup: () => [] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(HubSurface, { selection: { project: "exo", item: "inbox" } })));
      expect(container.querySelector("[data-hub-need-group]")).toBeNull();
      expect(container.querySelectorAll("[data-hub-need]")).toHaveLength(2);
    } finally {
      act(() => root.unmount());
      container.remove();
      setHubDataSource(undefined);
      vi.unstubAllGlobals();
    }
  });

  it("kind: a question or a job's options is to decide; Looks right is to check; the rest is to look at", () => {
    expect(needKind(need("a", { actionTarget: "question:q" }))).toBe("decide");
    expect(needKind(need("a", { jobId: "j" }))).toBe("decide");
    expect(needKind(need("a", { actionType: "accept" }))).toBe("check");
    expect(needKind(need("a", {}))).toBe("read");
  });
});

describe("Ash OS's internal tags never reach a row", () => {
  it("a job about a job loses the inner 'Autofix: health:' tags mid-sentence, keeping the words", () => {
    expect(plainWorkText("Fixing a studio health problem: running 10h: Autofix: health: light surface combo-lab did not finish")).toBe(
      "Fixing a studio health problem: running 10h: light surface combo-lab did not finish",
    );
    expect(plainWorkText("Stuck; harness: rerun the merge")).toBe("Stuck; rerun the merge");
    // Ordinary words are left alone, and a tag at the very start is Ash OS's own to word.
    expect(plainWorkText("Fixing the harness: it broke")).toBe("Fixing the harness: it broke");
    expect(plainWorkText("Unsticking merge queue")).toBe("Unsticking merge queue");
  });

  it("is applied where Today reads Needs and jobs", () => {
    const n = mapNeed({ id: "n1", projectId: "exo", title: "Fixing a studio health problem: running 10h: Autofix: health: x", why: "w", detail: "y: Autofix: z" })!;
    expect(n.title).toBe("Fixing a studio health problem: running 10h: x");
    expect(n.detail).toBe("y: z");
    const j = mapJob({ id: "j1", projectId: "exo", state: "stuck", title: "a: Autofix: health: b", reason: "c: Harness: d" })!;
    expect(j.title).toBe("a: b");
    expect(j.reason).toBe("c: d");
  });
});
