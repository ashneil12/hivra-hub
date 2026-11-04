// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { leadFor } from "./hubLeads";
import { roleLeadName } from "./leadRoleName";

const HUB = { id: "hub", name: "MonoCode Hub", shortName: "Hub" };
const EXO = { id: "vg-game", name: "EXO", shortName: "EXO" };

beforeEach(() => localStorage.clear());

describe("roleLeadName", () => {
  it("names a project's Lead from leadFor or its `<project id>-lead` id, not from a legacy seat", () => {
    localStorage.setItem(
      "monocode:hub-project-leads",
      JSON.stringify([{ projectId: "hub", id: "desk-lead", name: "Desk lead", projectName: "MonoCode Hub" }]),
    );
    expect(leadFor("desk-lead")?.projectId).toBe("hub");
    expect(leadFor("ash-lead")).toBeUndefined();
    expect(roleLeadName(HUB, "desk-lead", "desk-lead")).toBe("Hub lead");
    expect(roleLeadName(HUB, "hub-lead", "MonoCode Hub lead")).toBe("Hub lead");
    expect(roleLeadName(EXO, "vg-game-lead", "studio lead")).toBe("EXO lead");
    expect(roleLeadName(HUB, "mina", "studio lead")).toBe("Hub lead");
    expect(roleLeadName(HUB, "ash-lead", "ash-lead")).toBe("ash-lead");
    expect(roleLeadName(HUB, null, "ash-lead")).toBe("ash-lead");
  });
  it("leaves a Mono that isn't the project's Lead, and a missing Lead, as it was named", () => {
    expect(roleLeadName(HUB, "mina", "Mina")).toBe("Mina");
    expect(roleLeadName(HUB, null, "Nobody yet")).toBe("Nobody yet");
    expect(roleLeadName(undefined, "ash-lead", "ash-lead")).toBe("ash-lead");
  });
});
