import { describe, expect, it } from "vitest";
import {
  briefRelativePath,
  draftId,
  parseProgrammeRows,
  placeDrafts,
  PROGRAMME_NOTE_CAP,
  PROGRAMME_ROW_CAP,
  type ProgrammeRow,
} from "./programme";

const NOW = 1_700_000_000_000;

function candidate(title: string, text = "Map it to a source already in the table.", source = "firstmate") {
  return { source, title, text };
}

function row(over: Partial<ProgrammeRow> = {}): ProgrammeRow {
  const id = over.id ?? "draft-firstmate-notes";
  return {
    id,
    wp: "",
    title: "Notes",
    briefPath: briefRelativePath(id),
    branch: "",
    status: "building",
    securityPark: false,
    draft: true,
    priority: 0,
    notes: "",
    projectId: "crew",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("programme drafts", () => {
  it("writes nothing while the scout is off, and never starts work", () => {
    const existing = [row({ status: "queued", id: draftId("firstmate", "Notes") })];
    const placed = placeDrafts({
      enabled: false,
      maxDrafts: 3,
      existing,
      briefs: {},
      candidates: [candidate("A new draft"), candidate("Auth for the desk")],
      now: NOW,
      projectId: "crew",
    });
    expect(placed.rows).toEqual(existing);
    expect(placed.launched).toBe(false);
    expect(placed.merged).toBe(false);
    expect(placed.spent).toBe(false);
    expect(placed.notified).toBe(false);
    expect(placed.rows.some((item) => item.status === "building" && item.id !== existing[0].id)).toBe(false);
  });

  it("lands at most N drafts, parks a sensitive one, and leaves a building row alone", () => {
    const building = row({ id: draftId("firstmate", "Already going"), title: "Already going", status: "building" });
    const placed = placeDrafts({
      enabled: true,
      maxDrafts: 2,
      existing: [building],
      briefs: { [building.id]: "Keep this brief.\n" },
      candidates: [
        candidate("Queue notes"),
        candidate("Auth for the desk", "Add authentication before the call."),
        candidate("A third one"),
        candidate("Queue notes"),
      ],
      now: NOW,
      projectId: "crew",
    });
    expect(placed.rows).toHaveLength(3);
    expect(placed.rows[0]).toEqual(building);
    expect(placed.briefs[building.id]).toBe("Keep this brief.\n");
    const added = placed.rows.slice(1);
    expect(added.map((item) => item.status)).toEqual(["queued", "parked"]);
    expect(added[1].securityPark).toBe(true);
    expect(added[1].notes).toBe("security-park");
    expect(added.every((item) => item.draft)).toBe(true);
    expect(added.every((item) => item.branch === "")).toBe(true);
    expect(added.every((item) => item.briefPath === briefRelativePath(item.id))).toBe(true);
    expect(added.every((item) => !item.briefPath.startsWith("/"))).toBe(true);
    expect(placed.rows.some((item) => item.title === "A third one")).toBe(false);
    expect(Object.values(placed).includes("building")).toBe(false);
  });

  it("treats 0 as a night that writes nothing, and drops a private or absolute brief", () => {
    const quiet = placeDrafts({
      enabled: true,
      maxDrafts: 0,
      existing: [],
      briefs: {},
      candidates: [candidate("Queue notes")],
      now: NOW,
      projectId: "crew",
    });
    expect(quiet.rows).toEqual([]);
    const poisoned = {
      ...row(),
      briefPath: "/work/secret.md",
      notes: "x".repeat(PROGRAMME_NOTE_CAP + 20),
    };
    expect(parseProgrammeRows([poisoned, null, { id: "not-a-draft" }], NOW)).toEqual([]);
    const full = Array.from({ length: PROGRAMME_ROW_CAP + 5 }, (_, index) =>
      row({ id: `draft-row-${index}`, title: `Row ${index}` }),
    );
    expect(parseProgrammeRows(full, NOW)).toHaveLength(PROGRAMME_ROW_CAP);
  });

  it("does not queue the same draft twice when it is already parked", () => {
    const parked = row({
      id: draftId("firstmate", "Auth for the desk"),
      title: "Auth for the desk",
      status: "parked",
      securityPark: true,
      notes: "security-park",
    });
    const placed = placeDrafts({
      enabled: true,
      maxDrafts: 3,
      existing: [parked],
      briefs: {},
      candidates: [candidate("Auth for the desk", "Add authentication.")],
      now: NOW,
      projectId: "not a project id",
    });
    expect(placed.rows).toEqual([parked]);
  });
});
