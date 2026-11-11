// @vitest-environment happy-dom
// G7: the teams Ash set up and the proposals (Settings > Teams) live in the app's database, the local hub document
// `hub-teams` (src-tauri/src/local_hub.rs), with its revision rule. What one window's storage held before comes across
// once and never twice; the old key stays as it was.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "./localHub/localHub";
import { createTeamsStore, LEGACY_TEAMS_KEY, TEAMS_DOC_KEY, TEAMS_IMPORTED_KEY, type TeamsDoc } from "./hubTeamsStore";
import type { MonoProposal, Team } from "./hubTeams";

vi.setConfig({ testTimeout: 30_000 });

const team = (id: string, name = id): Team => ({ id, name, brief: "", projects: ["hivra"], memberIds: [], roomChatId: `hivra:${id}`, roomProjectId: "hivra", createdAt: "2026-11-11T00:00:00Z" });
const proposal = (id: string, status: MonoProposal["status"] = "pending"): MonoProposal => ({
  id, spec: { name: id, brief: "", engine: "claude", projects: [], connectors: [] }, proposedBy: { name: "Alfred" }, at: "2026-11-11T00:00:00Z", status,
});
const addTeam = (t: Team) => (doc: TeamsDoc): TeamsDoc => (doc.teams.some((x) => x.id === t.id) ? doc : { ...doc, teams: [...doc.teams, t] });
const ids = (doc: TeamsDoc) => doc.teams.map((t) => t.id);

beforeEach(() => localStorage.clear());

describe("teams in the app's database (G7)", () => {
  it("a change shows at once, is saved in the hub document, and a reload from the store keeps it", async () => {
    const disk = memoryDisk();
    const one = createTeamsStore(disk, localStorage);
    await one.load();
    void one.change(addTeam(team("team-marketing", "Marketing")));
    // Shown before the write lands, so a sync caller (createTeam) reads its own team back.
    expect(ids(one.view())).toEqual(["team-marketing"]);
    await one.settled();
    expect((await disk.readDoc(TEAMS_DOC_KEY)).value).toMatchObject({ teams: [{ id: "team-marketing", name: "Marketing" }], proposals: [] });

    // A restart: a new store on the same database.
    const again = createTeamsStore(disk, localStorage);
    await again.load();
    expect(ids(again.view())).toEqual(["team-marketing"]);
  });

  it("what one window's storage held comes across once, never twice, and the old key stays as it was", async () => {
    const old = JSON.stringify({ teams: [team("team-old", "Old")], proposals: [proposal("p-old")] });
    localStorage.setItem(LEGACY_TEAMS_KEY, old);
    const disk = memoryDisk();
    const first = createTeamsStore(disk, localStorage);
    await first.load();
    expect(ids(first.view())).toEqual(["team-old"]);
    // A proposal still waiting in the old copy is closed, as the old load did (a Mono is made in chat now).
    expect(first.view().proposals.map((p) => [p.id, p.status])).toEqual([["p-old", "declined"]]);
    expect(localStorage.getItem(LEGACY_TEAMS_KEY)).toBe(old);
    expect(localStorage.getItem(TEAMS_IMPORTED_KEY)).not.toBeNull();

    // Ash retires the old team; the next start must not bring it back from the old key.
    await first.change((doc) => ({ ...doc, teams: doc.teams.filter((t) => t.id !== "team-old") }));
    const writes = vi.spyOn(disk, "write");
    const second = createTeamsStore(disk, localStorage);
    await second.load();
    expect(ids(second.view())).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("the import only adds: a team already in the database keeps its own record", async () => {
    const disk = memoryDisk({ [TEAMS_DOC_KEY]: { teams: [team("team-a", "Kept name")], proposals: [] } });
    localStorage.setItem(LEGACY_TEAMS_KEY, JSON.stringify({ teams: [team("team-a", "Old name"), team("team-b")], proposals: [] }));
    const store = createTeamsStore(disk, localStorage);
    await store.load();
    expect(store.view().teams.map((t) => [t.id, t.name])).toEqual([["team-a", "Kept name"], ["team-b", "team-b"]]);
  });

  it("a write from an older revision is refused and made again on top, so neither window loses its change", async () => {
    const disk = memoryDisk();
    const one = createTeamsStore(disk, localStorage);
    const two = createTeamsStore(disk, localStorage);
    await one.load();
    await two.load();
    // Both read revision 0. A write at a revision that has moved on is refused by the disk and changes nothing.
    await one.change(addTeam(team("team-one")));
    expect(await disk.write(TEAMS_DOC_KEY, { teams: [team("stale")], proposals: [] }, 0)).toBeNull();
    expect(ids((await disk.readDoc(TEAMS_DOC_KEY)).value as TeamsDoc)).toEqual(["team-one"]);

    // one writes again between two's read and two's write: two's write is refused, it reads again and goes on top.
    const write = disk.write.bind(disk);
    const refused: number[] = [];
    let raced = false;
    disk.write = async (key, value, rev) => {
      if (!raced && key === TEAMS_DOC_KEY && ids(value as TeamsDoc).includes("team-two")) {
        raced = true;
        const now = (await disk.readDoc(TEAMS_DOC_KEY)).value as TeamsDoc;
        await write(TEAMS_DOC_KEY, addTeam(team("team-three"))(now), rev);
      }
      const at = await write(key, value, rev);
      if (at === null && rev !== undefined) refused.push(rev);
      return at;
    };
    await two.change(addTeam(team("team-two")));
    expect(refused).toEqual([1]);
    const doc = await disk.readDoc(TEAMS_DOC_KEY);
    expect(ids(doc.value as TeamsDoc)).toEqual(["team-one", "team-three", "team-two"]);
    expect(doc.rev).toBe(3);
    expect(ids(two.view())).toEqual(["team-one", "team-three", "team-two"]);
  });

  it("another window's write is heard and read again", async () => {
    const disk = memoryDisk();
    const one = createTeamsStore(disk, localStorage);
    const two = createTeamsStore(disk, localStorage);
    await one.load();
    await two.load();
    const heard = vi.fn();
    two.subscribe(heard);
    await one.change(addTeam(team("team-one")));
    await vi.waitFor(() => expect(ids(two.view())).toEqual(["team-one"]));
    expect(heard).toHaveBeenCalled();
  });

  it("a change that never lands is taken back off the screen and said", async () => {
    const disk = memoryDisk();
    const store = createTeamsStore(disk, localStorage);
    await store.load();
    disk.write = async () => {
      throw new Error("database closed");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(store.change(addTeam(team("team-x")))).rejects.toThrow(/couldn't be saved/);
    expect(ids(store.view())).toEqual([]);
    expect(store.problem()).toMatch(/couldn't be saved/);
    error.mockRestore();
  });
});

describe("hubTeams writes through the store (G7)", () => {
  beforeEach(() => vi.resetModules());

  it("a team Ash makes is in the hub document, and a fresh window reads it back", async () => {
    const disk = memoryDisk();
    const hub = await import("./hubData");
    const mock = await import("./mockData");
    hub.setHubDataSource({ ...mock.mockHubData, listProjects: () => [{ id: "hivra", name: "Hivra", folder: "/Users/ash/Projects/hivra", iconShape: "sparkles" }] } as never);
    const teams = await import("./hubTeams");
    teams.setTeamsStoreForTest(createTeamsStore(disk, localStorage));
    const made = teams.createTeam({ name: "Marketing", brief: "Grow Hivra", projects: ["hivra"] });
    expect(teams.listTeams().map((t) => t.id)).toEqual([made.id]);
    await teams.teamsSettled();
    expect(((await disk.readDoc(TEAMS_DOC_KEY)).value as TeamsDoc).teams.map((t) => t.name)).toEqual(["Marketing"]);
    // Nothing goes to the window's own storage any more.
    expect(localStorage.getItem(LEGACY_TEAMS_KEY)).toBeNull();

    vi.resetModules();
    const fresh = await import("./hubTeams");
    fresh.setTeamsStoreForTest(createTeamsStore(disk, localStorage));
    await fresh.teamsSettled();
    expect(fresh.getTeam(made.id)?.name).toBe("Marketing");
  });
});
