import { describe, expect, it } from "vitest";
import { roleLeadName } from "./leadRoleName";

const HUB = { id: "hub", name: "MonoCode Hub", shortName: "Hub" };
const EXO = { id: "vg-game", name: "EXO", shortName: "EXO" };

describe("roleLeadName", () => {
  it("names a project's own Lead by its role, from its id or the old seat it adopted", () => {
    expect(roleLeadName(HUB, "ash-lead", "ash-lead")).toBe("Hub lead");
    expect(roleLeadName(HUB, "hub-lead", "MonoCode Hub lead")).toBe("Hub lead");
    expect(roleLeadName(EXO, "vg-game-lead", "studio lead")).toBe("EXO lead");
    expect(roleLeadName(HUB, null, "ash-lead")).toBe("Hub lead");
  });
  it("leaves a Mono that isn't the project's Lead, and a missing Lead, as Ash OS named it", () => {
    expect(roleLeadName(HUB, "chief-of-staff", "Chief of Staff")).toBe("Chief of Staff");
    expect(roleLeadName(HUB, null, "Nobody yet")).toBe("Nobody yet");
    expect(roleLeadName(undefined, "ash-lead", "ash-lead")).toBe("ash-lead");
  });
});
