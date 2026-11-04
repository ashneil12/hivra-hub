import { describe, expect, it } from "vitest";
import { filterEntries, readEntries, type ActivityEntry, type Who } from "./activity";

const person: Who = { role: "person" };
const ada: Who = { role: "first-mate", id: "lead-1", name: "Ada" };
const nia: Who = { role: "mono", id: "mono-9", name: "Nia" };

function row(patch: Partial<ActivityEntry> & Pick<ActivityEntry, "id" | "summary">): ActivityEntry {
  return {
    seq: 1,
    kind: "git.push",
    actor: ada,
    initiator: person,
    project: "acme/web",
    target: "work",
    link: "",
    at: 1_700_000_000_000,
    ...patch,
  };
}

const rows: ActivityEntry[] = [
  row({ id: "merge", summary: "Merged acme/web#7.", kind: "git.merge", target: "acme/web#7" }),
  row({
    id: "pct",
    summary: "Pushed 100%_done.",
    target: "100%_done",
    actor: nia,
    initiator: nia,
    seq: 2,
  }),
  row({ id: "other", summary: "Opened a pull request into main.", kind: "git.pr", project: "other", seq: 3 }),
];

describe("filterEntries", () => {
  it("keeps every row when the filters are blank", () => {
    expect(filterEntries(rows, { project: "  ", agent: "", kind: " ", search: "\n" }).map((r) => r.id)).toEqual([
      "merge",
      "pct",
      "other",
    ]);
  });

  it("matches the project and the kind exactly", () => {
    expect(filterEntries(rows, { project: " acme/web " }).map((r) => r.id)).toEqual(["merge", "pct"]);
    expect(filterEntries(rows, { project: "acme" })).toEqual([]);
    expect(filterEntries(rows, { kind: "git.merge" }).map((r) => r.id)).toEqual(["merge"]);
    expect(filterEntries(rows, { kind: "git" })).toEqual([]);
  });

  it("matches an agent by id or by name, and treats % and _ as letters", () => {
    expect(filterEntries(rows, { agent: "lead-1" }).map((r) => r.id)).toEqual(["merge", "other"]);
    expect(filterEntries(rows, { agent: "ada" }).map((r) => r.id)).toEqual(["merge", "other"]);
    expect(filterEntries(rows, { agent: "Lead-1" }).map((r) => r.id)).toEqual(["merge", "other"]);
    expect(filterEntries(rows, { agent: "a_b" })).toEqual([]);
    expect(filterEntries(rows, { search: "100%_done" }).map((r) => r.id)).toEqual(["pct"]);
    expect(filterEntries(rows, { search: "100X_done" })).toEqual([]);
    expect(filterEntries(rows, { search: "%" }).map((r) => r.id)).toEqual(["pct"]);
    expect(filterEntries(rows, { search: "_" }).map((r) => r.id)).toEqual(["pct"]);
  });

  it("searches the summary, target, project, kind and names, not the link", () => {
    const linked = row({ id: "linked", summary: "Pushed work.", link: "https://secret-word.example/pr" });
    expect(filterEntries([linked], { search: "secret-word" })).toEqual([]);
    expect(filterEntries([linked], { search: "git.push" }).map((r) => r.id)).toEqual(["linked"]);
    expect(filterEntries(rows, { search: "Nia" }).map((r) => r.id)).toEqual(["pct"]);
  });
});

describe("readEntries", () => {
  it("is an empty list when the command returns nothing or a bad page", () => {
    expect(readEntries(undefined)).toEqual([]);
    expect(readEntries(null)).toEqual([]);
    expect(readEntries({})).toEqual([]);
    expect(readEntries({ entries: [{ summary: "no id" }, null, "x"] })).toEqual([]);
  });

  it("keeps a real row and reads an unknown role as the app", () => {
    const [entry] = readEntries({
      entries: [
        {
          id: "a",
          kind: "git.push",
          summary: "Pushed work.",
          at: 5,
          actor: { role: "stranger" },
          initiator: { role: "person" },
        },
      ],
    });
    expect(entry?.actor).toEqual({ role: "app" });
    expect(entry?.initiator).toEqual({ role: "person" });
    expect(entry?.project).toBe("");
  });
});
