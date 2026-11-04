// @vitest-environment happy-dom
// An existing ash-lead is the hub lead. The rename moves it to hub-lead when the folder can move. When it cannot,
// ash-lead stays the hub lead. A second hub-lead is never made beside it, and two Monos are never merged.
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

describe("an existing ash-lead stays the hub lead", () => {
  it("renames ash-lead to hub-lead, and the project does not get a second lead", async () => {
    const rename = vi.fn(async () => ({}));
    const unregister = vi.fn(async () => ({}));
    expect(await renameAshLeadToHubLead({ rename, unregister })).toBe("renamed");
    expect(rename).toHaveBeenCalledWith("ash-lead", "hub-lead");
    expect(unregister).toHaveBeenCalledWith("ash-lead", "hub");
    expect(findMono("hub-lead")).toMatchObject({
      name: "MonoCode Hub lead",
      sessionId: ASH_LEAD.sessionId,
      projects: ASH_LEAD.projects,
    });
    expect(findMono("ash-lead")).toBeUndefined();
    ensureProjectLeads([HUB]);
    expect(listMonos().map((m) => m.id)).toEqual(["mina", "hub-lead"]);
    expect(findMono("hub-lead")?.sessionId).toBe(ASH_LEAD.sessionId);
    expect(leadFor("hub-lead")?.projectId).toBe("hub");
    expect(await renameAshLeadToHubLead({ rename, unregister })).toBe("not-needed");
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("rewrites the app's own records that name it, and nothing else", async () => {
    localStorage.setItem("monocode:open-mono", "ash-lead");
    localStorage.setItem("monocode:hub-lead-adopted", JSON.stringify(["ash-lead"]));
    localStorage.setItem("monocode:hub-team-tied", JSON.stringify(["mina|/x", "ash-lead|/Users/ash/Projects/monocode-hub"]));
    localStorage.setItem("monocode:hub-bot-changes", JSON.stringify([{ id: "retire:ash-lead:1", monoId: "ash-lead", file: "SOUL.md" }]));
    localStorage.setItem("monocode:mono-background:ash-lead", "blue");
    localStorage.setItem("monocode:notes", "the ash-leadership doc, and smash-lead");
    localStorage.setItem("other-app:ash-lead", "untouched");
    await renameAshLeadToHubLead({ rename: async () => ({}) });
    expect(localStorage.getItem("monocode:open-mono")).toBe("hub-lead");
    expect(JSON.parse(localStorage.getItem("monocode:hub-lead-adopted")!)).toEqual(["hub-lead"]);
    expect(JSON.parse(localStorage.getItem("monocode:hub-team-tied")!)).toEqual(["mina|/x", "hub-lead|/Users/ash/Projects/monocode-hub"]);
    expect(JSON.parse(localStorage.getItem("monocode:hub-bot-changes")!)).toEqual([{ id: "retire:hub-lead:1", monoId: "hub-lead", file: "SOUL.md" }]);
    expect(localStorage.getItem("monocode:mono-background:hub-lead")).toBe("blue");
    expect(localStorage.getItem("monocode:mono-background:ash-lead")).toBeNull();
    expect(localStorage.getItem("monocode:notes")).toBe("the ash-leadership doc, and smash-lead");
    expect(localStorage.getItem("other-app:ash-lead")).toBe("untouched");
  });

  it("keeps ash-lead as the hub lead when the folder cannot move, and does not create hub-lead", async () => {
    localStorage.setItem("monocode:open-mono", "ash-lead");
    const rename = vi.fn(async () => {
      throw "hub-lead already has files, so ash-lead wasn't renamed";
    });
    expect(await renameAshLeadToHubLead({ rename })).toBe("failed");
    expect(rename).toHaveBeenCalledWith("ash-lead", "hub-lead");
    ensureProjectLeads([HUB]);
    expect(findMono("hub-lead")).toBeUndefined();
    expect(findMono("ash-lead")).toMatchObject({ sessionId: ASH_LEAD.sessionId });
    expect(listMonos().map((m) => m.id)).toEqual(["mina", "ash-lead"]);
    expect(leadFor("ash-lead")?.projectId).toBe("hub");
    expect(localStorage.getItem("monocode:open-mono")).toBe("ash-lead");
  });

  it("does not merge two Monos, and does not make a third lead", async () => {
    localStorage.setItem(
      "monocode:mono-roster",
      JSON.stringify([ASH_LEAD, { ...ASH_LEAD, id: "hub-lead", name: "Hub lead", sessionId: "other" }]),
    );
    const rename = vi.fn(async () => ({}));
    expect(await renameAshLeadToHubLead({ rename })).toBe("both-exist");
    expect(rename).not.toHaveBeenCalled();
    ensureProjectLeads([HUB]);
    expect(listMonos().map((m) => m.id).sort()).toEqual(["ash-lead", "hub-lead"]);
    expect(findMono("ash-lead")?.sessionId).toBe(ASH_LEAD.sessionId);
    expect(findMono("hub-lead")?.sessionId).toBe("other");
    expect(leadFor("hub-lead")?.projectId).toBe("hub");
  });

  it("a stored-id rewrite keeps a record the new id already has of its own", () => {
    localStorage.setItem("monocode:mono-background:ash-lead", "old");
    localStorage.setItem("monocode:mono-background:hub-lead", "new");
    rewriteStoredIds("ash-lead", "hub-lead");
    expect(localStorage.getItem("monocode:mono-background:hub-lead")).toBe("new");
    expect(localStorage.getItem("monocode:mono-background:ash-lead")).toBe("old");
  });
});
