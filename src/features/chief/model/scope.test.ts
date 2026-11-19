import { describe, expect, it } from "vitest";
import { EVERY_PROJECT_LINE, readsEveryProject, scopeOpen, soulAsks, turnRecallWide } from "./scope";

const ASKING = `# Soul\n\n${EVERY_PROJECT_LINE}\n`;

describe("soulAsks", () => {
  it("accepts only the whole marker line, including a Windows line ending", () => {
    expect(soulAsks(ASKING)).toBe(true);
    expect(soulAsks(`# Soul\r\n${EVERY_PROJECT_LINE}\r\n`)).toBe(true);
    expect(soulAsks(`  ${EVERY_PROJECT_LINE}  \n`)).toBe(true);
    expect(soulAsks("every project: read\n")).toBe(false);
    expect(soulAsks(`See ${EVERY_PROJECT_LINE} now\n`)).toBe(false);
    expect(soulAsks("")).toBe(false);
    expect(soulAsks(undefined)).toBe(false);
  });
});

describe("readsEveryProject", () => {
  it("is on only when the soul asks and the switch is exactly true", () => {
    expect(readsEveryProject({ instructions: ASKING, everyProject: true })).toBe(true);
    expect(readsEveryProject({ instructions: ASKING })).toBe(false);
    expect(readsEveryProject({ instructions: ASKING, everyProject: false })).toBe(false);
    expect(readsEveryProject({ instructions: "# Soul\n", everyProject: true })).toBe(false);
    expect(readsEveryProject({ instructions: ASKING, everyProject: "yes" as unknown as boolean })).toBe(false);
    expect(readsEveryProject({ instructions: ASKING, everyProject: 1 as unknown as boolean })).toBe(false);
    expect(readsEveryProject(undefined)).toBe(false);
  });

  it("reads the soul file when the roster copy does not ask, and a timeout stays off", async () => {
    const mono = { instructions: "# Soul\n", everyProject: true as const };
    await expect(scopeOpen(mono, async () => ASKING)).resolves.toBe(true);
    await expect(scopeOpen(mono, async () => "# Soul\n")).resolves.toBe(false);
    await expect(scopeOpen(mono, async () => {
      throw new Error("timed out");
    })).resolves.toBe(false);
    await expect(scopeOpen({ instructions: ASKING, everyProject: true }, async () => {
      throw new Error("timed out");
    })).resolves.toBe(true);
    await expect(scopeOpen({ instructions: ASKING, everyProject: false })).resolves.toBe(false);
  });
});

describe("turnRecallWide", () => {
  it("follows the soul file when the roster copy does not ask", async () => {
    const mono = { instructions: "# Soul\n", everyProject: true as const };
    await expect(turnRecallWide(mono, async () => ASKING)).resolves.toBe(true);
    await expect(turnRecallWide(mono, async () => "# Soul\n")).resolves.toBe(false);
    await expect(turnRecallWide(mono, async () => `See ${EVERY_PROJECT_LINE} now`)).resolves.toBe(false);
    await expect(turnRecallWide(mono, async () => {
      throw new Error("timed out");
    })).resolves.toBe(false);
    await expect(turnRecallWide({ instructions: ASKING, everyProject: true }, async () => {
      throw new Error("timed out");
    })).resolves.toBe(true);
    await expect(turnRecallWide({ instructions: ASKING, everyProject: false }, async () => ASKING)).resolves.toBe(false);
    await expect(turnRecallWide(undefined, async () => ASKING)).resolves.toBe(false);
  });
});
