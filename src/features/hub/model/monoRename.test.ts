// @vitest-environment happy-dom
// An existing ash-lead is left as it is. hub-lead is created as that project's normal lead. Nothing deletes the Mono,
// rewrites the records that name it, or merges the two.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findMono, listMonos } from "../../monos/model/mono";
import { ensureProjectLeads, leadFor } from "./hubLeads";
import { renameAshLeadToHubLead, rewriteStoredIds } from "./monoRename";
import type { HubProject } from "./types";

const HUB: HubProject = { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge", folder: "/Users/ash/Projects/monocode-hub" };

const ASH_LEAD = {
  id: "ash-lead",
  name: "Harness lead",
  mascot: "letter",
  color: "x",
  projects: ["/Users/ash/Projects/monocode-hub", "/Users/ash/Projects/exo-cc-studio"],
  sessionId: "6b7776e4-62b3-41db-ac44-cb9f501b40b8",
};
const MINA = { id: "mina", name: "Mina", mascot: "letter", color: "x", projects: [], sessionId: "df9afb39" };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:mono-roster", JSON.stringify([MINA, ASH_LEAD]));
});

describe("an existing ash-lead stays, and hub-lead is a normal lead", () => {
  it("does not rename ash-lead; the project still gets hub-lead beside it", async () => {
    const rename = vi.fn(async () => ({}));
    const unregister = vi.fn(async () => ({}));
    expect(await renameAshLeadToHubLead({ rename, unregister })).toBe("not-needed");
    expect(rename).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    ensureProjectLeads([HUB]);
    expect(findMono("ash-lead")).toMatchObject({
      name: "Harness lead",
      sessionId: ASH_LEAD.sessionId,
      projects: ASH_LEAD.projects,
    });
    expect(findMono("hub-lead")).toMatchObject({ name: "Hub lead" });
    expect(listMonos().map((m) => m.id)).toEqual(["mina", "ash-lead", "hub-lead"]);
    expect(leadFor("ash-lead")).toBeUndefined();
    expect(leadFor("hub-lead")?.projectId).toBe("hub");
    expect(await renameAshLeadToHubLead({ rename, unregister })).toBe("not-needed");
    expect(rename).not.toHaveBeenCalled();
    expect(findMono("ash-lead")?.name).toBe("Harness lead");
  });

  it("leaves records that name ash-lead, and anything that is not a Mono id", async () => {
    localStorage.setItem("monocode:open-mono", "ash-lead");
    localStorage.setItem("monocode:hub-lead-adopted", JSON.stringify(["ash-lead"]));
    localStorage.setItem("monocode:hub-team-tied", JSON.stringify(["mina|/x", "ash-lead|/Users/ash/Projects/monocode-hub"]));
    localStorage.setItem("monocode:hub-bot-changes", JSON.stringify([{ id: "retire:ash-lead:1", monoId: "ash-lead", file: "SOUL.md" }]));
    localStorage.setItem("monocode:mono-background:ash-lead", "blue");
    localStorage.setItem("monocode:notes", "the ash-leadership doc, and smash-lead");
    localStorage.setItem("other-app:ash-lead", "untouched");
    await renameAshLeadToHubLead({ rename: async () => ({}) });
    ensureProjectLeads([HUB]);
    expect(localStorage.getItem("monocode:open-mono")).toBe("ash-lead");
    expect(JSON.parse(localStorage.getItem("monocode:hub-lead-adopted")!)).toEqual(["ash-lead"]);
    expect(JSON.parse(localStorage.getItem("monocode:hub-team-tied")!)).toEqual(["mina|/x", "ash-lead|/Users/ash/Projects/monocode-hub"]);
    expect(JSON.parse(localStorage.getItem("monocode:hub-bot-changes")!)).toEqual([{ id: "retire:ash-lead:1", monoId: "ash-lead", file: "SOUL.md" }]);
    expect(localStorage.getItem("monocode:mono-background:ash-lead")).toBe("blue");
    expect(localStorage.getItem("monocode:notes")).toBe("the ash-leadership doc, and smash-lead");
    expect(localStorage.getItem("other-app:ash-lead")).toBe("untouched");
    expect(findMono("ash-lead")).toBeTruthy();
  });

  it("does not try a folder move, so a move that would fail changes nothing", async () => {
    localStorage.setItem("monocode:open-mono", "ash-lead");
    const rename = vi.fn(async () => {
      throw "hub-lead already has files, so ash-lead wasn't renamed";
    });
    expect(await renameAshLeadToHubLead({ rename })).toBe("not-needed");
    expect(rename).not.toHaveBeenCalled();
    expect(listMonos().map((m) => m.id)).toEqual(["mina", "ash-lead"]);
    expect(localStorage.getItem("monocode:open-mono")).toBe("ash-lead");
  });

  it("does not merge two Monos: both stay, and neither is deleted", async () => {
    localStorage.setItem(
      "monocode:mono-roster",
      JSON.stringify([ASH_LEAD, { ...ASH_LEAD, id: "hub-lead", name: "Hub lead", sessionId: "other" }]),
    );
    const rename = vi.fn(async () => ({}));
    expect(await renameAshLeadToHubLead({ rename })).toBe("not-needed");
    expect(rename).not.toHaveBeenCalled();
    expect(findMono("ash-lead")?.sessionId).toBe(ASH_LEAD.sessionId);
    expect(findMono("hub-lead")?.sessionId).toBe("other");
    ensureProjectLeads([HUB]);
    expect(findMono("ash-lead")?.name).toBe("Harness lead");
    expect(findMono("hub-lead")?.sessionId).toBe("other");
  });

  it("a stored-id rewrite keeps a record the new id already has of its own", () => {
    localStorage.setItem("monocode:mono-background:ash-lead", "old");
    localStorage.setItem("monocode:mono-background:hub-lead", "new");
    rewriteStoredIds("ash-lead", "hub-lead");
    expect(localStorage.getItem("monocode:mono-background:hub-lead")).toBe("new");
    expect(localStorage.getItem("monocode:mono-background:ash-lead")).toBe("old");
  });
});
