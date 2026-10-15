// @vitest-environment happy-dom
// "Retire <Project> Lead too": the Lead's folder moves into the archive (never deleted), the row lands in Changes →
// Bot changes, and Undo (there, or the 10s toast) brings back the same Lead, folder first, in its old roster place.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubProject } from "../model/types";

let root: Root;
let container: HTMLElement;
const hivra: HubProject = { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/ash/harness/hivra" };

/** A fake disk: the folders in monos/ and monos/.archive/. */
function fakeDisk() {
  const live = new Map<string, string>([["hivra-lead", "memory: the waitlist ships Friday"], ["frank", "frank's own"]]);
  const archived = new Map<string, string>();
  return {
    live, archived,
    archive: vi.fn(async (id: string, stamp: string) => {
      const name = `${id}-${stamp}`;
      archived.set(name, live.get(id) ?? "");
      live.delete(id);
      return name;
    }),
    restore: vi.fn(async (id: string, name: string) => {
      if (!archived.has(name)) throw "The archived folder isn't there any more";
      live.set(id, archived.get(name)!);
      archived.delete(name);
    }),
  };
}

async function load() {
  localStorage.clear();
  vi.resetModules();
  const mono = await import("../../monos/model/mono");
  const disk = fakeDisk();
  (await import("../../monos/model/monoArchive")).setMonoArchive(disk);
  for (const m of [{ id: "frank", name: "frank" }, { id: "hivra-lead", name: "Hivra lead", sessionId: "s-hivra" }, { id: "alfred", name: "Alfred" }])
    mono.addMono({ ...m, mascot: "mono", color: "gray", projects: [] });
  return { mono, disk, prefs: await import("../model/projectPrefs"), changes: await import("../model/botChanges"), menu: await import("./ProjectMenu") };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

describe("retire the Lead with its project", () => {
  it("archives the Lead's folder (never deletes it) and logs it under Bot changes", async () => {
    const { mono, disk, prefs, changes } = await load();
    await prefs.removeFromHub(hivra, { retireLead: true });
    expect(mono.listMonos().map((m) => m.id)).toEqual(["frank", "alfred"]);
    expect(disk.live.has("hivra-lead")).toBe(false);
    expect([...disk.archived.values()]).toEqual(["memory: the waitlist ships Friday"]);
    expect(disk.live.get("frank")).toBe("frank's own");
    const row = changes.botChangeRows().find((r) => r.kind === "one" && r.change.retired)!;
    expect(row.kind === "one" && row.change.line).toBe("Hivra lead was retired with Hivra");
    expect(JSON.parse(localStorage.getItem("monocode:hub-bot-changes")!)[0].retired.mono.sessionId).toBe("s-hivra");
  });

  it("Undo in Bot changes restores the same Lead: folder back, same chat, same place", async () => {
    const { mono, disk, prefs, changes } = await load();
    await prefs.removeFromHub(hivra, { retireLead: true });
    const row = changes.botChangeRows().find((r) => r.kind === "one" && r.change.retired)!;
    await changes.undoBotChange([row.kind === "one" ? row.change.id : ""]);
    expect(mono.listMonos().map((m) => m.id)).toEqual(["frank", "hivra-lead", "alfred"]);
    expect(mono.findMono("hivra-lead")?.sessionId).toBe("s-hivra");
    expect(disk.live.get("hivra-lead")).toBe("memory: the waitlist ships Friday");
    expect(disk.archived.size).toBe(0);
  });

  it("the toast's Undo puts the project and the Lead back", async () => {
    const { mono, prefs } = await load();
    await prefs.removeFromHub(hivra, { retireLead: true });
    expect(prefs.applyProjectPrefs([hivra])).toEqual([]);
    await prefs.pendingUndo()!.undo();
    expect(prefs.applyProjectPrefs([hivra]).map((p) => p.id)).toEqual(["hivra"]);
    expect(mono.listMonos().map((m) => m.id)).toEqual(["frank", "hivra-lead", "alfred"]);
    expect(prefs.pendingUndo()).toBeUndefined();
  });

  it("keeping the Lead (the default) touches no Mono folder", async () => {
    const { mono, disk, prefs } = await load();
    await prefs.removeFromHub(hivra);
    expect(disk.archive).not.toHaveBeenCalled();
    expect(mono.listMonos()).toHaveLength(3);
  });

  it("an Undo that can't find the archive says so and leaves the row not undone", async () => {
    const { disk, prefs, changes } = await load();
    await prefs.removeFromHub(hivra, { retireLead: true });
    disk.archived.clear();
    const row = changes.botChangeRows().find((r) => r.kind === "one" && r.change.retired)!;
    const id = row.kind === "one" ? row.change.id : "";
    await changes.undoBotChange([id]);
    const after = changes.botChangeRows().find((r) => r.kind === "one" && r.change.id === id)!;
    expect(after.kind === "one" && after.change.undone).toBeFalsy();
    expect(after.kind === "one" && after.change.problem).toBe("The archived folder isn't there any more");
  });

  it("the dialog says Retire, and needs the typed name only for it", async () => {
    const { menu, disk } = await load();
    act(() => root.render(createElement(menu.RemoveFromHub, { project: hivra, anchor: { x: 10, y: 10 }, onClose: () => {} })));
    const q = (s: string) => document.querySelector(s) as HTMLElement;
    expect(document.body.textContent).toContain("Retire Hivra lead too");
    expect(document.body.textContent).not.toContain("Remove Hivra lead too");
    expect((q("[data-project-remove]") as HTMLButtonElement).disabled).toBe(false);
    act(() => q('[data-lead-choice="remove"]').click());
    expect((q("[data-project-remove]") as HTMLButtonElement).disabled).toBe(true);
    const input = q('[aria-label="Project name to confirm"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(input, "Hivra"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect((q("[data-project-remove]") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { q("[data-project-remove]").click(); });
    expect(disk.archive).toHaveBeenCalledWith("hivra-lead", expect.any(String));
  });
});
