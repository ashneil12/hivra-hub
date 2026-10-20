// @vitest-environment happy-dom
// ash-lead becomes hub-lead (decided 20 Oct): its folder (mono.rs, stood in for here), its roster entry and every
// record in the WebView that names it move to the new id, once; it keeps its chat, look, projects and place.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findMono, listMonos } from "../../monos/model/mono";
import { leadFor } from "./hubLeads";
import { renameAshLeadToHubLead, rewriteStoredIds } from "./monoRename";

const ASH_LEAD = {
  id: "ash-lead",
  name: "MonoCode Hub lead",
  mascot: "letter",
  color: "x",
  projects: ["/Users/ash/Projects/monocode-hub", "/Users/ash/Projects/exo-cc-studio"],
  sessionId: "6b7776e4-62b3-41db-ac44-cb9f501b40b8",
};
const COS = { id: "chief-of-staff", name: "Chief of Staff", mascot: "letter", color: "x", projects: [], sessionId: "df9afb39" };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:mono-roster", JSON.stringify([COS, ASH_LEAD]));
});

describe("ash-lead becomes hub-lead", () => {
  it("moves its folder first, then takes the new id in place with the same chat, look and projects", async () => {
    const rename = vi.fn(async () => ({}));
    const unregister = vi.fn(async () => ({}));
    expect(await renameAshLeadToHubLead({ rename, unregister })).toBe("renamed");
    expect(rename).toHaveBeenCalledWith("ash-lead", "hub-lead");
    expect(listMonos().map((m) => m.id)).toEqual(["chief-of-staff", "hub-lead"]);
    expect(findMono("hub-lead")).toMatchObject({
      name: "MonoCode Hub lead",
      sessionId: ASH_LEAD.sessionId,
      projects: ASH_LEAD.projects,
    });
    expect(findMono("ash-lead")).toBeUndefined();
    // Ash OS stops filing hub work under the old id; hub-lead is registered by ensureProjectLeads.
    expect(unregister).toHaveBeenCalledWith("ash-lead", "hub");
    // It is the hub's Lead under its own id now.
    expect(leadFor("hub-lead")?.projectId).toBe("hub");
    // Once: nothing left to rename.
    expect(await renameAshLeadToHubLead({ rename, unregister })).toBe("not-needed");
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("rewrites the app's own records that name it, and nothing else", async () => {
    localStorage.setItem("monocode:open-mono", "ash-lead");
    localStorage.setItem("monocode:hub-lead-adopted", JSON.stringify(["ash-lead"]));
    localStorage.setItem("monocode:hub-team-tied", JSON.stringify(["frank|/x", "ash-lead|/Users/ash/Projects/monocode-hub"]));
    localStorage.setItem("monocode:hub-bot-changes", JSON.stringify([{ id: "retire:ash-lead:1", monoId: "ash-lead", file: "SOUL.md" }]));
    localStorage.setItem("monocode:mono-background:ash-lead", "blue");
    localStorage.setItem("monocode:notes", "the ash-leadership doc, and smash-lead");
    localStorage.setItem("other-app:ash-lead", "untouched");
    await renameAshLeadToHubLead({ rename: async () => ({}) });
    expect(localStorage.getItem("monocode:open-mono")).toBe("hub-lead");
    expect(JSON.parse(localStorage.getItem("monocode:hub-lead-adopted")!)).toEqual(["hub-lead"]);
    expect(JSON.parse(localStorage.getItem("monocode:hub-team-tied")!)).toEqual(["frank|/x", "hub-lead|/Users/ash/Projects/monocode-hub"]);
    expect(JSON.parse(localStorage.getItem("monocode:hub-bot-changes")!)).toEqual([{ id: "retire:hub-lead:1", monoId: "hub-lead", file: "SOUL.md" }]);
    expect(localStorage.getItem("monocode:mono-background:hub-lead")).toBe("blue");
    expect(localStorage.getItem("monocode:mono-background:ash-lead")).toBeNull();
    expect(localStorage.getItem("monocode:notes")).toBe("the ash-leadership doc, and smash-lead");
    expect(localStorage.getItem("other-app:ash-lead")).toBe("untouched");
  });

  it("changes nothing when the folder can't be moved (hub-lead already has files)", async () => {
    localStorage.setItem("monocode:open-mono", "ash-lead");
    const result = await renameAshLeadToHubLead({
      rename: async () => {
        throw "hub-lead already has files, so ash-lead wasn't renamed";
      },
    });
    expect(result).toBe("failed");
    expect(listMonos().map((m) => m.id)).toEqual(["chief-of-staff", "ash-lead"]);
    expect(localStorage.getItem("monocode:open-mono")).toBe("ash-lead");
  });

  it("never merges two Monos: with both on the roster it leaves them for Ash", async () => {
    localStorage.setItem("monocode:mono-roster", JSON.stringify([ASH_LEAD, { ...ASH_LEAD, id: "hub-lead", sessionId: "other" }]));
    const rename = vi.fn(async () => ({}));
    expect(await renameAshLeadToHubLead({ rename })).toBe("both-exist");
    expect(rename).not.toHaveBeenCalled();
  });

  it("keeps a record the new id already has of its own", () => {
    localStorage.setItem("monocode:mono-background:ash-lead", "old");
    localStorage.setItem("monocode:mono-background:hub-lead", "new");
    rewriteStoredIds("ash-lead", "hub-lead");
    expect(localStorage.getItem("monocode:mono-background:hub-lead")).toBe("new");
  });
});
