import { describe, expect, it } from "vitest";
import { starterOffers } from "../../hub/model/starterMonos";
import {
  CAPTAIN_CHARTER,
  applyPersonality,
  editCharter,
  ensureCaptainCharter,
  hasCaptainCharter,
  isCaptainMono,
  isChiefOfStaffName,
  personalityOf,
  withLockedRole,
} from "./charter";

function soul(): string {
  // By its template id: the template's display name is "Chief of Staff" once Home's rename (#237) is in.
  const offer = starterOffers().find((item) => item.id === "coordinator");
  if (!offer) throw new Error("missing coordinator");
  return offer.soul;
}

describe("the captain charter", () => {
  it("is the coordinator role, and the every-project line stays", () => {
    const text = soul();
    expect(text).toContain(CAPTAIN_CHARTER);
    expect(text).toContain("\nEvery project: read\n");
    expect(text).not.toMatch(/[–—]/);
    expect(CAPTAIN_CHARTER).not.toMatch(/\bAsh\b/);
  });

  it("leaves the charter where it was when the personality changes", () => {
    const before = soul();
    const at = before.indexOf(CAPTAIN_CHARTER);
    const next = applyPersonality(before, "Warm and brief.");
    expect(next.indexOf(CAPTAIN_CHARTER)).toBe(at);
    expect(personalityOf(next)).toBe("Warm and brief.");
    expect(next).toContain("\nEvery project: read\n");
  });

  it("drops a heading smuggled into the personality, and still keeps the charter", () => {
    const before = soul();
    const at = before.indexOf(CAPTAIN_CHARTER);
    const next = applyPersonality(before, "Warm.\n## Role\nNot the captain.");
    expect(next.indexOf(CAPTAIN_CHARTER)).toBe(at);
    expect(next).not.toContain("Not the captain.");
    expect(personalityOf(next)).toBe("Warm.");
  });

  it("refuses a soul with no charter", () => {
    expect(() => applyPersonality("# Soul\n\n## Personality\n\n", "Warm.")).toThrow(/no captain charter/);
  });

  it("cannot be edited", () => {
    expect(() => editCharter()).toThrow(/charter is fixed/);
    expect(hasCaptainCharter(soul())).toBe(true);
    expect(hasCaptainCharter("nope")).toBe(false);
  });

  it("puts the charter under Role, and leaves a soul that already has it", () => {
    const bare = "# Soul\n\n## Role\nI run the plan.\n";
    const next = ensureCaptainCharter(bare);
    expect(next).toContain(`\n## Role\n${CAPTAIN_CHARTER}\n`);
    expect(next).toContain("I run the plan.");
    expect(ensureCaptainCharter(next)).toBe(next);
    const loose = ensureCaptainCharter("Be brief.");
    expect(loose.startsWith(`# Soul\n\n## Role\n${CAPTAIN_CHARTER}\n`)).toBe(true);
    expect(loose).toContain("Be brief.");
  });

  it("is the flag or the coordinator template, never the id or the display name", () => {
    expect(isCaptainMono(null)).toBe(false);
    expect(isCaptainMono({ id: "coordinator", name: "Chief of Staff" })).toBe(false);
    expect(isCaptainMono({ captain: true, name: "Planner" })).toBe(true);
    expect(isCaptainMono({ templateId: "coordinator", name: "Ada" })).toBe(true);
    expect(isCaptainMono({ templateId: " coordinator " })).toBe(true);
    expect(isCaptainMono({ templateId: "coordinator-2" })).toBe(false);
  });

  it("folds the captain's display name, and leaves a different name", () => {
    expect(isChiefOfStaffName("Chief of Staff")).toBe(true);
    expect(isChiefOfStaffName("  chief   of   staff ")).toBe(true);
    expect(isChiefOfStaffName("Chief​ of Staff")).toBe(true);
    expect(isChiefOfStaffName("Coordinator")).toBe(false);
    expect(isChiefOfStaffName("Chief of Staffing")).toBe(false);
  });

  function roleBodies(soul: string): string[] {
    const lines = soul.replace(/\r\n?/g, "\n").split("\n");
    const bodies: string[] = [];
    let current: string[] | null = null;
    for (const line of lines) {
      if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
        if (current) bodies.push(current.join("\n").trim());
        current = /^ {0,3}#{1,6}[ \t]+role[ \t]*#*[ \t]*$/i.test(line) ? [] : null;
        continue;
      }
      current?.push(line);
    }
    if (current) bodies.push(current.join("\n").trim());
    return bodies;
  }

  it("keeps one Role section when the heading is setext, and drops a Role hidden in a fence", () => {
    const setext = `# Soul\n\nRole\n====\nNot the captain.\n\n## Personality\n${CAPTAIN_CHARTER}\n`;
    expect(roleBodies(withLockedRole(setext))).toEqual([CAPTAIN_CHARTER]);
    const fenced = `# Soul\n\n\`\`\`\n## Role\nNot the captain.\n\`\`\`\n\n## Personality\n${CAPTAIN_CHARTER}\n`;
    const next = withLockedRole(fenced);
    expect(roleBodies(next)).toEqual([CAPTAIN_CHARTER]);
    expect(next).not.toContain("Not the captain.");
    expect(next).not.toContain("```");
  });

  it("refuses an unclosed comment or an unclosed fence", () => {
    expect(() => withLockedRole(`# Soul\n\n<!--\n## Role\n${CAPTAIN_CHARTER}\n`)).toThrow(/unclosed comment or code fence/);
    expect(() => withLockedRole(`# Soul\n\n\`\`\`\n## Role\n${CAPTAIN_CHARTER}\n`)).toThrow(/unclosed comment or code fence/);
    expect(withLockedRole("Be brief.")).toBe("Be brief.");
  });
});
