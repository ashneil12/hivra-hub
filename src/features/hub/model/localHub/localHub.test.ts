import { describe, expect, it } from "vitest";
import { LocalHub, memoryDisk } from "./localHub";
import { createLocalTransport } from "./localTransport";
import { delegationDecisions, delegationJobGroups } from "./decisions";
import { answerOf, importFromAshOsAgain, importOutcome, offersAshOsImport, resetAshOsImportStartForTest, runAshOsImport, startAshOsImport, IMPORT_KEY, type ImportAnswer, type ImportFound } from "./ashOsImport";
import type { Delegation } from "../../../monos/model/delegations";

const blocks = (title: string) => ({ kind: "blocks", title, blocks: [{ kind: "note", title: "n", text: "t" }] });

describe("the local hub store (WP-04)", () => {
  it("keeps projects, Monos per project and Pages across a restart", async () => {
    const disk = memoryDisk();
    const first = new LocalHub(disk);
    await first.projectCreate({ name: "EXO game", project_id: "exo", folder: "/tmp/exo" });
    await first.projectCreate({ name: "Nibbii" });
    await first.monoProjectAdd({ mono_id: "exo-lead", project_id: "exo", role: "lead" });
    await first.monoProjectAdd({ mono_id: "ed", project_id: "nibbii" });
    await first.pageUpdate({ pageId: "pg-1", projectId: "exo", spec: blocks("Builds"), kept: true });
    await first.projectRename({ project_id: "exo", name: "EXO" });

    // A restart: a new store on the same disk.
    const again = new LocalHub(disk);
    const { projects } = await again.projects();
    expect(projects.map((p) => [p.id, p.name, p.folder])).toEqual([
      ["exo", "EXO", "/tmp/exo"],
      ["nibbii", "Nibbii", null],
    ]);
    expect((await again.monoProjects()).byProject).toEqual({ exo: ["exo-lead"], nibbii: ["ed"] });
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

describe("two windows on one database (WP-04 review)", () => {
  it("neither overwrites the other's change: each starts from the disk, not its own copy", async () => {
    const disk = memoryDisk();
    const one = new LocalHub(disk);
    const two = new LocalHub(disk);
    // Both have read the record before either writes.
    await one.projects();
    await two.projects();
    await one.projectCreate({ name: "EXO game", project_id: "exo" });
    await two.projectCreate({ name: "Nibbii", project_id: "nibbii" });
    await one.monoProjectAdd({ mono_id: "exo-lead", project_id: "exo", role: "lead" });
    await two.monoProjectAdd({ mono_id: "ed", project_id: "exo" });
    // two knew nothing of exo from its own copy, and adds to it all the same.
    const fresh = new LocalHub(disk);
    expect((await fresh.projects()).projects.map((p) => p.id)).toEqual(["exo", "nibbii"]);
    expect((await fresh.monoProjects()).byProject).toEqual({ exo: ["exo-lead", "ed"] });
  });

  it("a write from an older copy is refused on disk and made again on top", async () => {
    const disk = memoryDisk();
    const one = new LocalHub(disk);
    await one.projectCreate({ name: "EXO game", project_id: "exo" });
    // Another window writes between one's read and its write, once.
    const write = disk.write.bind(disk);
    let raced = false;
    disk.write = async (key, value, rev) => {
      if (!raced && key === "projects") {
        raced = true;
        const now = (await disk.readDoc("projects")).value as { projects: unknown[] };
        await write("projects", { projects: [...now.projects, { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "folder", folder: null }] });
      }
      return write(key, value, rev);
    };
    await one.projectRename({ project_id: "exo", name: "EXO" });
    const names = (await new LocalHub(disk).projects()).projects.map((p) => p.name);
    expect(names).toEqual(["EXO", "Nibbii"]);
  });

  it("G8: a pin from an older copy of the pages is refused on disk and made again on top of the other window's page", async () => {
    const disk = memoryDisk();
    const one = new LocalHub(disk);
    await one.pageUpdate({ pageId: "pg-1", projectId: "today", spec: blocks("Builds"), kept: true });
    const write = disk.write.bind(disk);
    const refused: Array<number | undefined> = [];
    let raced = false;
    disk.write = async (key, value, rev) => {
      if (!raced && key === "pages") {
        raced = true;
        // Another window keeps a page between one's read and its write.
        await new LocalHub(disk).pageUpdate({ pageId: "pg-2", projectId: "today", spec: blocks("Costs"), kept: true });
      }
      const at = await write(key, value, rev);
      if (at === null) refused.push(rev);
      return at;
    };
    await one.pageUpdate({ pageId: "pg-1", pinned: true });
    expect(refused).toEqual([1]);
    const { pages } = await new LocalHub(disk).pages();
    expect(pages.map((p) => [p.id, p.pinned ?? false]).sort()).toEqual([["pg-1", true], ["pg-2", false]]);
  });

  it("changes in one window run in order, even when called together", async () => {
    const disk = memoryDisk();
    const hub = new LocalHub(disk);
    await hub.projectCreate({ name: "EXO game", project_id: "exo" });
    await Promise.all(["a", "b", "c", "d"].map((m) => hub.monoProjectAdd({ mono_id: m, project_id: "exo" })));
    expect((await new LocalHub(disk).monoProjects()).byProject.exo).toEqual(["a", "b", "c", "d"]);
  });

  it("the other window hears the change and reads again; its own writes don't make it re-read", async () => {
    const disk = memoryDisk();
    const one = new LocalHub(disk);
    const two = new LocalHub(disk);
    await two.projects();
    let heardByTwo = 0;
    let heardByOne = 0;
    two.onChange(() => (heardByTwo += 1));
    one.onChange(() => (heardByOne += 1));
    await one.projectCreate({ name: "EXO game", project_id: "exo" });
    expect(heardByTwo).toBe(1);
    expect(heardByOne).toBe(1); // its own change, once
    expect((await two.projects()).projects.map((p) => p.id)).toEqual(["exo"]);
  });

  it("a change that fails leaves the record and the window's copy as they were", async () => {
    const hub = new LocalHub(memoryDisk());
    await hub.pageUpdate({ pageId: "pg-1", projectId: "today", spec: blocks("Builds"), kept: true });
    await expect(hub.pageUpdate({ pageId: "pg-1", spec: blocks("New title"), permissions: ["camera"] })).rejects.toThrow(/didn't ask/);
    expect((await hub.pages()).pages.map((p) => p.title)).toEqual(["Builds"]);
  });

  it("a first read that fails is tried again next time", async () => {
    const disk = memoryDisk();
    const readDoc = disk.readDoc.bind(disk);
    let fail = true;
    disk.readDoc = async (key) => {
      if (fail) throw new Error("database busy");
      return readDoc(key);
    };
    const hub = new LocalHub(disk);
    await expect(hub.projects()).rejects.toThrow("database busy");
    fail = false;
    expect((await hub.projects()).projects).toEqual([]);
  });
});

describe("the one-time Ash OS import", () => {
  const found: ImportFound = {
    state: "found",
    projects: [{ id: "exo", name: "EXO game", folder: "/tmp/exo", iconShape: "gamepad" }],
    memberships: [{ monoId: "exo-lead", projectId: "exo", role: "lead" }, { monoId: "x", projectId: "gone" }],
    pages: [
      { id: "pg-1", projectId: "exo", state: "kept", spec: blocks("Builds") },
      { id: "pg-2", projectId: "exo", state: "removed", removed: true, spec: blocks("Old") },
    ],
  };
  const yes = async (): Promise<ImportAnswer> => "import";

  it("asks once, imports what Ash OS held, and never asks again", async () => {
    const disk = memoryDisk();
    const hub = new LocalHub(disk);
    const asked: string[] = [];
    const deps = { fetch: async () => found, ask: async (q: string) => (asked.push(q), "import" as const) };
    const decision = await runAshOsImport(hub, deps);
    expect(decision).toMatchObject({ decided: "imported", added: { projects: 1, memberships: 1, pages: 1 } });
    expect(asked[0]).toMatch(/1 project and 1 kept Hub/);
    expect(await runAshOsImport(hub, deps)).toMatchObject({ decided: "imported" });
    expect(asked).toHaveLength(1);
    const again = new LocalHub(disk);
    expect((await again.projects()).projects.map((p) => p.iconShape)).toEqual(["gamepad"]);
    expect((await again.pages()).pages.map((p) => p.id)).toEqual(["pg-1"]);
  });

  it("starts clean for good when there is no Ash OS here, or Ash says Start clean", async () => {
    const quiet = new LocalHub(memoryDisk());
    let reads = 0;
    const absent = { fetch: async () => (reads++, { ...found, state: "absent" as const, message: "Ash OS isn't set up on this Mac." }), ask: yes };
    expect((await runAshOsImport(quiet, absent)).decided).toBe("none");
    expect((await runAshOsImport(quiet, absent)).decided).toBe("none");
    expect(reads).toBe(1);
    expect((await quiet.projects()).projects).toEqual([]);
    const declined = new LocalHub(memoryDisk());
    expect((await runAshOsImport(declined, { fetch: async () => found, ask: async () => "clean" })).decided).toBe("declined");
    expect((await declined.projects()).projects).toEqual([]);
    expect(await declined.disk.read(IMPORT_KEY)).toMatchObject({ decided: "declined" });
  });

  it("a bad moment decides nothing: not answering, an error, or the question closed; the next start tries again (review)", async () => {
    const hub = new LocalHub(memoryDisk());
    const unreachable = { fetch: async () => ({ ...found, state: "unreachable" as const, message: "Ash OS answered ash-hub-pages with an error (500)." }), ask: yes };
    expect(await runAshOsImport(hub, unreachable)).toMatchObject({ decided: "later", message: expect.stringMatching(/500/) });
    expect(await hub.disk.read(IMPORT_KEY)).toBeNull();
    const thrown = { fetch: async (): Promise<ImportFound> => { throw new Error("plugin not ready"); }, ask: yes };
    expect((await runAshOsImport(hub, thrown)).decided).toBe("later");
    expect(await hub.disk.read(IMPORT_KEY)).toBeNull();
    // Esc on the question.
    expect((await runAshOsImport(hub, { fetch: async () => found, ask: async () => "later" })).decided).toBe("later");
    expect(await hub.disk.read(IMPORT_KEY)).toBeNull();
    expect((await hub.projects()).projects).toEqual([]);
    // Next start, Ash OS answers: it asks, and imports.
    expect((await runAshOsImport(hub, { fetch: async () => found, ask: yes })).decided).toBe("imported");
    expect((await hub.projects()).projects.map((p) => p.id)).toEqual(["exo"]);
  });

  it("Settings runs it again whatever was decided, and it still only adds", async () => {
    const hub = new LocalHub(memoryDisk());
    await runAshOsImport(hub, { fetch: async () => found, ask: async () => "clean" });
    const again = await importFromAshOsAgain(hub, { fetch: async () => found, ask: yes });
    expect(again).toMatchObject({ decided: "imported", added: { projects: 1 } });
    expect(importOutcome(again)).toBe("Brought over 1 project, 1 Mono's project and 1 kept Hub.");
    const twice = await importFromAshOsAgain(hub, { fetch: async () => found, ask: yes });
    expect(importOutcome(twice)).toBe("Everything Ash OS held is already here.");
    expect(importOutcome(await importFromAshOsAgain(hub, { fetch: async () => ({ ...found, state: "unreachable", message: "Ash OS isn't running." }), ask: yes }))).toBe(
      "Ash OS didn't answer (Ash OS isn't running.). Try again when it's running.",
    );
  });

  it("asks only in the main window: a hidden quick-session window never pops the question (review)", async () => {
    const hub = new LocalHub(memoryDisk());
    let asked = 0;
    const importDeps = { fetch: async () => found, ask: async (): Promise<ImportAnswer> => (asked++, "later") };
    for (const label of ["session-abc", "floating-mono-ed", undefined]) {
      resetAshOsImportStartForTest();
      expect(await startAshOsImport(hub, { inTauri: true, label: async () => label, importDeps })).toBeUndefined();
    }
    expect(asked).toBe(0);
    resetAshOsImportStartForTest();
    expect(await startAshOsImport(hub, { inTauri: true, label: async () => "main", importDeps })).toMatchObject({ decided: "later" });
    expect(asked).toBe(1);
    // Once per launch, even in main.
    expect(await startAshOsImport(hub, { inTauri: true, label: async () => "main", importDeps })).toBeUndefined();
    expect(asked).toBe(1);
    resetAshOsImportStartForTest();
  });

  it("Settings offers the row unless the app knows there's no Ash OS here", async () => {
    const hub = new LocalHub(memoryDisk());
    expect(await offersAshOsImport(hub)).toBe(true);
    await runAshOsImport(hub, { fetch: async () => ({ ...found, state: "absent" }), ask: yes });
    expect(await offersAshOsImport(hub)).toBe(false);
    await hub.disk.write(IMPORT_KEY, { decided: "declined", at: "x" });
    expect(await offersAshOsImport(hub)).toBe(true);
  });

  it("reads the dialog: Import, Start clean, and closing it", () => {
    expect([answerOf("Import"), answerOf("Start clean"), answerOf("Not now"), answerOf("Cancel")]).toEqual(["import", "clean", "later", "later"]);
  });

  it("only adds: a project already here keeps its own name", async () => {
    const hub = new LocalHub(memoryDisk());
    await hub.projectCreate({ name: "My EXO", project_id: "exo" });
    await runAshOsImport(hub, { fetch: async () => found, ask: yes });
    expect((await hub.projects()).projects.map((p) => p.name)).toEqual(["My EXO"]);
  });
});

describe("sharing a project with the team (WP-80)", () => {
  it("is a flag on the project that only the sharing call sets, and it survives a restart", async () => {
    const disk = memoryDisk();
    const first = new LocalHub(disk);
    await first.projectCreate({ name: "EXO game", project_id: "exo", folder: "/tmp/exo" });
    expect((await first.projects()).projects[0].shared).toBeUndefined();

    await first.projectRename({ project_id: "exo", shared: true });
    const again = new LocalHub(disk);
    const [shared] = (await again.projects()).projects;
    expect(shared.shared).toBe(true);
    // The local folder stays on this machine; sharing does not touch it.
    expect(shared.folder).toBe("/tmp/exo");

    await again.projectRename({ project_id: "exo", shared: false });
    expect((await again.projects()).projects[0].shared).toBe(false);
  });

  it("does not share anything on its own when a project is only renamed", async () => {
    const hub = new LocalHub(memoryDisk());
    await hub.projectCreate({ name: "EXO game", project_id: "exo" });
    await hub.projectRename({ project_id: "exo", name: "EXO" });
    expect((await hub.projects()).projects[0].shared).toBeUndefined();
  });
});
