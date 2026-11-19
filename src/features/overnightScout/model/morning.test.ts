import { describe, expect, it } from "vitest";
import { morningDrafts } from "./morning";
import { briefRelativePath, draftId, type ProgrammeRow } from "./programme";

function row(over: Partial<ProgrammeRow> & { title: string; status: ProgrammeRow["status"] }): ProgrammeRow {
  const id = over.id ?? draftId("firstmate", over.title);
  return {
    id,
    wp: "",
    title: over.title,
    briefPath: briefRelativePath(id),
    branch: over.branch ?? "",
    status: over.status,
    securityPark: over.securityPark ?? false,
    draft: over.draft ?? true,
    priority: 0,
    notes: over.notes ?? "",
    projectId: "crew",
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
  };
}

describe("morning drafts", () => {
  it("lists waiting and parked drafts, newest first, and leaves the rest out", () => {
    const waiting = row({ title: "Show the queue", status: "queued", createdAt: 10 });
    const parked = row({ title: "Auth for the desk", status: "parked", securityPark: true, notes: "security-park", createdAt: 30 });
    const older = row({ title: "Board notes", status: "queued", createdAt: 20 });
    const rows = [
      waiting,
      parked,
      older,
      row({ title: "Already building", status: "building", createdAt: 40 }),
      row({ title: "Already merged", status: "merged", createdAt: 50 }),
      row({ title: "Not a draft", status: "queued", draft: false, createdAt: 60 }),
    ];
    const listed = morningDrafts(rows, {
      [waiting.id]: "Source: firstmate (MIT).\n",
      [parked.id]: "Parked for a security check.\n",
    });
    expect(listed.map((draft) => [draft.title, draft.parked])).toEqual([
      ["Auth for the desk", true],
      ["Board notes", false],
      ["Show the queue", false],
    ]);
    expect(listed[2]?.brief).toBe("Source: firstmate (MIT).\n");
    expect(listed[1]?.brief).toBe("");
    expect(morningDrafts([], {})).toEqual([]);
  });
});
