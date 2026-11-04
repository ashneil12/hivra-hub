// @vitest-environment happy-dom
// Ash OS's internal tags ("Autofix: health:") never reach a row the store hands on.
import { describe, expect, it } from "vitest";
import { mapJob, mapNeed, plainWorkText } from "../model/hubStore";

describe("Ash OS's internal tags never reach a row", () => {
  it("a job about a job loses the inner 'Autofix: health:' tags mid-sentence, keeping the words", () => {
    expect(plainWorkText("Fixing a studio health problem: running 10h: Autofix: health: light surface combo-lab did not finish")).toBe(
      "Fixing a studio health problem: running 10h: light surface combo-lab did not finish",
    );
    expect(plainWorkText("Stuck; harness: rerun the merge")).toBe("Stuck; rerun the merge");
    // Ordinary words are left alone, and a tag at the very start is Ash OS's own to word.
    expect(plainWorkText("Fixing the harness: it broke")).toBe("Fixing the harness: it broke");
    expect(plainWorkText("Unsticking merge queue")).toBe("Unsticking merge queue");
  });

  it("is applied where Today reads Needs and jobs", () => {
    const n = mapNeed({ id: "n1", projectId: "exo", title: "Fixing a studio health problem: running 10h: Autofix: health: x", why: "w", detail: "y: Autofix: z" })!;
    expect(n.title).toBe("Fixing a studio health problem: running 10h: x");
    expect(n.detail).toBe("y: z");
    const j = mapJob({ id: "j1", projectId: "exo", state: "stuck", title: "a: Autofix: health: b", reason: "c: Harness: d" })!;
    expect(j.title).toBe("a: b");
    expect(j.reason).toBe("c: d");
  });
});
