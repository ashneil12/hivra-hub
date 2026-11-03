import { describe, expect, it } from "vitest";
import { LocalHub, memoryDisk } from "./localHub";
import { createLocalTransport } from "./localTransport";
import { delegationDecisions, delegationJobGroups } from "./decisions";
import { runAshOsImport, IMPORT_KEY, type ImportFound } from "./ashOsImport";
import type { Delegation } from "../../../monos/model/delegations";

const blocks = (title: string) => ({ kind: "blocks", title, blocks: [{ kind: "note", title: "n", text: "t" }] });

describe("the local hub store (WP-04)", () => {
  it("keeps projects, Monos per project and Pages across a restart", async () => {
    const disk = memoryDisk();
    const first = new LocalHub(disk);
    await first.projectCreate({ name: "EXO game", project_id: "exo", folder: "/tmp/exo" });
    await first.projectCreate({ name: "Nibbii" });
    await first.monoProjectAdd({ mono_id: "exo-lead", project_id: "exo", role: "lead" });
    await first.monoProjectAdd({ mono_id: "frank", project_id: "nibbii" });
    await first.pageUpdate({ pageId: "pg-1", projectId: "exo", spec: blocks("Builds"), kept: true });
    await first.projectRename({ project_id: "exo", name: "EXO" });

    // A restart: a new store on the same disk.
    const again = new LocalHub(disk);
    const { projects } = await again.projects();
    expect(projects.map((p) => [p.id, p.name, p.folder])).toEqual([
      ["exo", "EXO", "/tmp/exo"],
      ["nibbii", "Nibbii", null],
    ]);
    expect((await again.monoProjects()).byProject).toEqual({ exo: ["exo-lead"], nibbii: ["frank"] });
    const { pages } = await again.pages();
    expect(pages.map((p) => [p.id, p.state, p.projectId])).toEqual([["pg-1", "kept", "exo"]]);
  });

  it("refuses a clash, takes a project off the strip and brings it back", async () => {
    const hub = new LocalHub(memoryDisk());
    await hub.projectCreate({ name: "EXO game", project_id: "exo" });
    await expect(hub.projectCreate({ name: "exo game" })).rejects.toThrow(/already/);
    expect((await hub.projectArchive({ project_id: "exo" })).needsConfirm).toBe(true);
    await hub.projectArchive({ project_id: "exo", confirm: true });
    expect((await hub.projects()).projects).toEqual([]);
    expect((await hub.projects({ include_archived: true })).projects).toHaveLength(1);
    expect((await hub.layout()).strip).toEqual([]);
    await hub.projectArchive({ project_id: "exo", archived: false });
    expect((await hub.layout()).strip.map((p) => p.id)).toEqual(["exo"]);
  });

  it("removes and restores a kept page, and only allows what a page asked for", async () => {
    const hub = new LocalHub(memoryDisk());
    const bespoke = { kind: "bespoke", title: "Feed", html: "<p>x</p>", permissions: ["agents.message"] };
    await hub.pageUpdate({ pageId: "pg-2", spec: bespoke, kept: true, permissions: ["agents.message"] });
    await expect(hub.pageUpdate({ pageId: "pg-2", permissions: ["files.write"] })).rejects.toThrow(/didn't ask/);
    await hub.pageRemove({ pageId: "pg-2" });
    expect((await hub.pages()).pages).toEqual([]);
    expect((await hub.pages({ include_removed: true })).pages[0].removed).toBe(true);
    await hub.pageRemove({ pageId: "pg-2", restore: true });
    expect((await hub.pages()).pages[0].permissions).toEqual(["agents.message"]);
  });

  it("answers the store's calls locally and tells the store's feed when something changed", async () => {
    const t = createLocalTransport(new LocalHub(memoryDisk()), delegationDecisions(async () => []));
    const events: string[][] = [];
    t.openFeed(0, { onEvent: (e) => events.push(e.topics), onState: () => undefined });
    await t.call("project-create", { name: "EXO game", project_id: "exo" });
    expect(((await t.call("projects")) as { projects: unknown[] }).projects).toHaveLength(1);
    expect(events[0]).toEqual(["projects", "layout", "pages"]);
    expect(await t.call("needs")).toMatchObject({ projects: [], setup: [] });
    await expect(t.call("since")).rejects.toMatchObject({ kind: "refused" });
    await expect(t.call("project-create", { name: "EXO game" })).rejects.toThrow(/already/);
  });
});

describe("Being built from the app's own delegations", () => {
  const row = (patch: Partial<Delegation>): Delegation =>
    ({ id: "d1", rootId: "d1", ownerMono: "exo-lead", project: "exo", title: "Fix the save bug", state: "running", createdAt: 1_000, updatedAt: 2_000, parentId: null, pendingQuestion: null, ...patch }) as Delegation;

  it("groups open delegations by project and owner; a question reads as waiting; settled ones go", () => {
    const { groups } = delegationJobGroups([
      row({}),
      row({ id: "d2", rootId: "d2", state: "question", pendingQuestion: "Which save slot?" }),
      row({ id: "d3", rootId: "d3", state: "completed" }),
      row({ id: "d4", rootId: "d4", project: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect((groups[0].jobs as Array<{ id: string; state: string }>).map((j) => [j.id, j.state])).toEqual([
      ["d1", "working"],
      ["d2", "waiting"],
    ]);
  });
});

describe("the one-time Ash OS import", () => {
  const found: ImportFound = {
    reachable: true,
    projects: [{ id: "exo", name: "EXO game", folder: "/tmp/exo", iconShape: "gamepad" }],
    memberships: [{ monoId: "exo-lead", projectId: "exo", role: "lead" }, { monoId: "x", projectId: "gone" }],
    pages: [
      { id: "pg-1", projectId: "exo", state: "kept", spec: blocks("Builds") },
      { id: "pg-2", projectId: "exo", state: "removed", removed: true, spec: blocks("Old") },
    ],
  };

  it("asks once, imports what Ash OS held, and never asks again", async () => {
    const disk = memoryDisk();
    const hub = new LocalHub(disk);
    const asked: string[] = [];
    const deps = { fetch: async () => found, ask: async (q: string) => (asked.push(q), true) };
    const decision = await runAshOsImport(hub, deps);
    expect(decision).toMatchObject({ decided: "imported", added: { projects: 1, memberships: 1, pages: 1 } });
    expect(asked[0]).toMatch(/1 project and 1 kept Page/);
    expect(await runAshOsImport(hub, deps)).toMatchObject({ decided: "imported" });
    expect(asked).toHaveLength(1);
    const again = new LocalHub(disk);
    expect((await again.projects()).projects.map((p) => p.iconShape)).toEqual(["gamepad"]);
    expect((await again.pages()).pages.map((p) => p.id)).toEqual(["pg-1"]);
  });

  it("starts clean when Ash OS doesn't answer or Ash says no", async () => {
    const quiet = new LocalHub(memoryDisk());
    const none = await runAshOsImport(quiet, { fetch: async () => ({ ...found, reachable: false }), ask: async () => true });
    expect(none.decided).toBe("none");
    expect((await quiet.projects()).projects).toEqual([]);
    const declined = new LocalHub(memoryDisk());
    expect((await runAshOsImport(declined, { fetch: async () => found, ask: async () => false })).decided).toBe("declined");
    expect((await declined.projects()).projects).toEqual([]);
    expect(await declined.disk.read(IMPORT_KEY)).toMatchObject({ decided: "declined" });
  });

  it("only adds: a project already here keeps its own name", async () => {
    const hub = new LocalHub(memoryDisk());
    await hub.projectCreate({ name: "My EXO", project_id: "exo" });
    await runAshOsImport(hub, { fetch: async () => found, ask: async () => true });
    expect((await hub.projects()).projects.map((p) => p.name)).toEqual(["My EXO"]);
  });
});
