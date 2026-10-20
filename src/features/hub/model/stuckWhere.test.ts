// Today's Stuck rows named the project twice: "EXO · EXO lead · Run the movement tests" (Ash, 20 Oct). A Lead is named for
// its project, so the project is kept only when the Mono's name doesn't already carry it.
import { describe, expect, it } from "vitest";
import { projectBefore, stuckWhere } from "./stuckWhere";

const EXO = { name: "EXO", shortName: "EXO" };
const HUB = { name: "MonoCode Hub", shortName: "Hub" };

describe("what a Stuck row says before its title", () => {
  it("drops the project when the Lead is named for it", () => {
    expect(stuckWhere(EXO, "EXO lead")).toBe("EXO lead");
    expect(stuckWhere({ name: "Hivra", shortName: "Hivra" }, "Hivra lead")).toBe("Hivra lead");
    expect(stuckWhere({ name: "Nibbii" }, "NIBBII lead")).toBe("NIBBII lead");
  });

  it("drops it when the Lead carries the project's short name, which is what a Lead is named for", () => {
    expect(stuckWhere(HUB, "Hub lead")).toBe("Hub lead");
    expect(stuckWhere(HUB, "MonoCode Hub lead")).toBe("MonoCode Hub lead");
  });

  it("keeps the project for a Mono whose name doesn't carry it", () => {
    expect(stuckWhere(EXO, "Chief of Staff")).toBe("EXO · Chief of Staff");
    expect(stuckWhere({ name: "Hivra", shortName: "Hivra" }, "its Lead")).toBe("Hivra · its Lead");
    expect(projectBefore(HUB, "Harness lead")).toBe("MonoCode Hub");
  });

  it("matches whole words, not letters: a name that merely starts with the project's doesn't carry it", () => {
    expect(stuckWhere({ name: "Hub" }, "Hubert")).toBe("Hub · Hubert");
    expect(stuckWhere({ name: "EXO" }, "Exodus lead")).toBe("EXO · Exodus lead");
    expect(stuckWhere({ name: "Staff" }, "Chief of Staff")).toBe("Chief of Staff"); // the word is in the name
  });

  it("says just the Mono when the project isn't known or is left out, and nothing for a blank project", () => {
    expect(stuckWhere(null, "EXO lead")).toBe("EXO lead");
    expect(stuckWhere(undefined, "Chief of Staff")).toBe("Chief of Staff");
    expect(stuckWhere({ name: "  ", shortName: "" }, "Alfred")).toBe("Alfred");
    expect(projectBefore(EXO, "EXO lead")).toBeUndefined();
  });
});
