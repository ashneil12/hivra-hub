// Evidence behind a done or fixed claim (board I5): a claim the app can check is verified, a claim with nothing behind it
// is a guess, and both say so in one plain line.
import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import {
  claimEvidenceOf,
  claimOf,
  declaredConfidence,
  lastReply,
  ranChecks,
  saidChecks,
} from "./claimEvidence";

const says = (text: string) => ({ role: "assistant", text }) as unknown as Block;
const ran = (title: string, status = "completed") =>
  ({ role: "assistant", text: "", tool: { callId: title, title, kind: "execute", status } }) as unknown as Block;

describe("reading a claim", () => {
  it("takes the first line that says fixed or done, in the agent's usual shapes", () => {
    expect(claimOf("Fixed: the save path retries")).toBe("fixed");
    expect(claimOf("Done — the export works")).toBe("done");
    expect(claimOf("**Fixed:** memory leak")).toBe("fixed");
    expect(claimOf("- Done.")).toBe("done");
    expect(claimOf("It's working now")).toBe("working");
    expect(claimOf("Shipped: v2.1")).toBe("shipped");
  });

  it("leaves an ordinary reply alone", () => {
    expect(claimOf("I looked at the two options and left the code as it was.")).toBeUndefined();
    expect(claimOf("The test file is at src/save.test.ts.")).toBeUndefined();
    expect(claimOf("")).toBeUndefined();
  });

  it("takes the checks and the confidence it declares, when it declares them", () => {
    expect(saidChecks("Checks: npx vitest run src/a (7 passed); npx tsc --noEmit")).toEqual([
      "npx vitest run src/a (7 passed)",
      "npx tsc --noEmit",
    ]);
    expect(saidChecks("Ran: none")).toEqual([]);
    expect(declaredConfidence("Fixed.\nConfidence: likely")).toBe("likely");
    expect(declaredConfidence("Confidence - verified")).toBe("verified");
    expect(declaredConfidence("Confidence: very high")).toBeUndefined();
  });
});

describe("what the turn actually ran", () => {
  it("counts test, type and lint runs, and not a read or a build", () => {
    const turn = [
      ran("npx vitest run src/a.test.ts"),
      ran("npx tsc --noEmit"),
      ran("cargo clippy -D warnings"),
      ran("npm run build"),
      ran("git status"),
    ];
    expect(ranChecks(turn)).toEqual([
      { command: "npx vitest run src/a.test.ts", passed: true },
      { command: "npx tsc --noEmit", passed: true },
      { command: "cargo clippy -D warnings", passed: true },
    ]);
  });

  it("does not count a run still going, and keeps the last run of the same command", () => {
    expect(ranChecks([ran("pnpm test", "pending")])).toEqual([]);
    expect(ranChecks([ran("pnpm test", "failed"), ran("pnpm test")])).toEqual([{ command: "pnpm test", passed: true }]);
  });
});

describe("what a claim is worth", () => {
  it("is verified when a check it ran passed, and says which", () => {
    const evidence = claimEvidenceOf("Fixed: the save path retries", [ran("npx vitest run src/save.test.ts")]);
    expect(evidence).toMatchObject({ claim: "fixed", confidence: "verified", backed: true });
    expect(evidence!.ran).toEqual([{ command: "npx vitest run src/save.test.ts", passed: true }]);
    expect(evidence!.line).toContain("Says it's fixed");
    expect(evidence!.line).toContain("ran in this turn and passed (npx vitest run src/save.test.ts)");
  });

  it("is a guess when any check it ran failed, and the line says so", () => {
    const evidence = claimEvidenceOf("Done — the export works", [ran("npm test", "failed"), ran("npx tsc --noEmit")]);
    expect(evidence).toMatchObject({ confidence: "guess", backed: false });
    expect(evidence!.line).toContain("a check it ran failed (npm test)");
    expect(evidence!.line).toContain("Not proven.");
  });

  it("is likely when it names checks the app did not see run", () => {
    const evidence = claimEvidenceOf("Fixed: the save path retries.\nChecks: npx vitest run src/save.test.ts (7 passed)");
    expect(evidence).toMatchObject({ confidence: "likely", backed: false });
    expect(evidence!.said).toHaveLength(1);
    expect(evidence!.line).toContain("names npx vitest run src/save.test.ts (7 passed)");
    expect(evidence!.line).toContain("no test or type-check run was seen");
  });

  it("is likely when it says the checks passed in its own words, and the app saw none", () => {
    const evidence = claimEvidenceOf("Fixed the endpoint; 12 tests pass.");
    expect(evidence).toMatchObject({ confidence: "likely", backed: false });
    expect(evidence!.line).toContain("says the checks passed");
    expect(evidence!.line).toContain("the app saw no test or type-check run in this turn");
  });

  it("is likely when it says so itself", () => {
    expect(claimEvidenceOf("Done.\nConfidence: likely")).toMatchObject({ confidence: "likely", declared: "likely" });
  });

  it("is a guess when nothing was run, and reads as not proven", () => {
    const evidence = claimEvidenceOf("Fixed: the save path retries", [ran("cat src/save.ts")]);
    expect(evidence).toMatchObject({ confidence: "guess", backed: false });
    expect(evidence!.line).toContain("nothing the app can see was run to check it");
    expect(evidence!.line).toContain("Not proven.");
  });

  it("is nothing at all when the reply makes no claim", () => {
    expect(claimEvidenceOf("I read the save path and left it as it was.", [ran("npx vitest run")])).toBeUndefined();
  });
});

describe("what counts as evidence for the change", () => {
  const edited = (path: string) =>
    ({
      role: "assistant",
      text: "",
      tool: { callId: path, title: `Edit ${path}`, kind: "edit", status: "completed", paths: [path] },
    }) as unknown as Block;

  it("does not count a check that ran before the last edit", () => {
    const turn = [ran("npx vitest run src/save.test.ts"), edited("src/save.ts")];
    const evidence = claimEvidenceOf("Fixed: the save path retries", turn)!;
    expect(evidence).toMatchObject({ confidence: "guess", backed: false, counted: [] });
    expect(evidence.missing).toContain("a check after the last edit (save.ts)");
  });

  it("counts a passing project-wide check that ran after the change", () => {
    const turn = [edited("src/save.ts"), ran("npm test")];
    const evidence = claimEvidenceOf("Fixed: the save path retries", turn)!;
    expect(evidence).toMatchObject({ confidence: "verified", backed: true, missing: [] });
    expect(evidence.counted).toEqual([{ command: "npm test", passed: true }]);
  });

  it("counts a check that names the file the turn changed", () => {
    const turn = [edited("src/save.ts"), ran("npx vitest run src/save.test.ts")];
    expect(claimEvidenceOf("Fixed: the save path retries", turn)).toMatchObject({ confidence: "verified" });
  });

  it("does not count a check aimed at other files, and says what it would have to cover", () => {
    const turn = [edited("src/save.ts"), ran("npx vitest run src/other.test.ts")];
    const evidence = claimEvidenceOf("Done — the export works", turn)!;
    expect(evidence).toMatchObject({ confidence: "guess", backed: false, counted: [] });
    expect(evidence.missing).toContain("a check for what changed (save.ts)");
  });

  it("does not let a read of the file stand in for a check", () => {
    const read = {
      role: "assistant",
      text: "",
      tool: { callId: "r1", title: "Read src/save.ts", kind: "read", status: "completed" },
    } as unknown as Block;
    const evidence = claimEvidenceOf("Fixed: the save path retries", [edited("src/save.ts"), read])!;
    expect(evidence).toMatchObject({ confidence: "guess", ran: [] });
  });

  it("says which file the reply talks about was never read", () => {
    const evidence = claimEvidenceOf("Fixed: the save path in src/save.ts now retries.\nChecks: npm test")!;
    expect(evidence).toMatchObject({ confidence: "likely", backed: false });
    expect(evidence.missing).toContain("reading save.ts");
    expect(evidence.line).toContain("Not yet confirmed.");
    expect(evidence.line).toContain("Missing:");
  });
});

describe("reading the reply of a turn", () => {
  it("takes the last thing said, not a tool call or a hidden note", () => {
    const turn = [
      { role: "user", text: "Fix it" },
      ran("npx vitest run"),
      { role: "assistant", text: "Looking at the save path." },
      { role: "assistant", text: "A hidden note.", internal: true },
      says("Fixed: the save path retries."),
    ] as unknown as Block[];
    expect(lastReply(turn)).toBe("Fixed: the save path retries.");
  });
});
