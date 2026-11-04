import { describe, expect, it } from "vitest";
import { e2eEvidence } from "./e2eEvidence";

describe("e2eEvidence", () => {
  it("keeps proof under .e2e and drops everything else", () => {
    expect(e2eEvidence([
      ".e2e/report.json",
      ".e2e/results/home/trace.md",
      ".e2e\\shot.png",
      "https://example.com/run",
      "../secret.png",
      ".e2e/../../etc/passwd",
      "/.e2e/report.json",
      "C:\\.e2e\\report.json",
      ".e2e",
      ".e2e/",
      ".e2e/./shot.png",
      12,
      ".e2e/report.json",
    ])).toEqual([
      ".e2e/report.json",
      ".e2e/results/home/trace.md",
      ".e2e/shot.png",
    ]);
  });

  it("is empty when the list isn't a list", () => {
    expect(e2eEvidence(undefined)).toEqual([]);
    expect(e2eEvidence(".e2e/report.json")).toEqual([]);
  });
});
