import { describe, expect, it } from "vitest";
import { SCOUT_DEFAULTS } from "./settings";
import { runScout } from "./run";

const SOURCES = `
## The sources

| Source | Licence | What Hivra takes | How | Packages |
| --- | --- | --- | --- | --- |
| [firstmate](https://example.com/firstmate) | MIT | durable queue | Port | 10 |
| [Orbit](https://example.com/orbit) | Apache-2.0 | board | Vendor | 70 |

## Vision to packages
`;

const watch = ["firstmate: Show the queue", "firstmate: Auth for the desk", "unknown: invent a product", "Orbit: Board notes"].join(
  "\n",
);

const settings = { ...SCOUT_DEFAULTS, enabled: true, maxDrafts: 2 };

describe("one scout night", () => {
  it("writes at most the cap, parks a sensitive line, and never starts work", () => {
    const placed = runScout({
      settings,
      sourcesText: SOURCES,
      watchText: watch,
      rows: [],
      briefs: {},
      now: 50,
      projectId: "my-crew",
    });
    expect(placed.launched).toBe(false);
    expect(placed.merged).toBe(false);
    expect(placed.spent).toBe(false);
    expect(placed.notified).toBe(false);
    expect(placed.rows.map((row) => [row.title, row.status, row.notes, row.branch, row.draft])).toEqual([
      ["Show the queue", "queued", "", "", true],
      ["Auth for the desk", "parked", "security-park", "", true],
    ]);
    expect(placed.rows.every((row) => row.briefPath === `overnight-scout/briefs/${row.id}.md`)).toBe(true);
    expect(placed.rows.every((row) => row.projectId === "my-crew")).toBe(true);
    expect(placed.briefs[placed.rows[0]!.id]).toContain("Source: firstmate (MIT).");
    expect(JSON.stringify(placed)).not.toContain("invent a product");
    expect(JSON.stringify(placed)).not.toContain("/work");

    const again = runScout({
      settings,
      sourcesText: SOURCES,
      watchText: watch,
      rows: placed.rows,
      briefs: placed.briefs,
      now: 80,
      projectId: "my-crew",
    });
    expect(again.rows.map((row) => row.title)).toEqual(["Show the queue", "Auth for the desk", "Board notes"]);
    expect(again.rows[1]?.status).toBe("parked");
    expect(again.rows[0]?.createdAt).toBe(50);
    const third = runScout({
      settings,
      sourcesText: SOURCES,
      watchText: watch,
      rows: again.rows,
      briefs: again.briefs,
      now: 90,
      projectId: "my-crew",
    });
    expect(third.rows).toEqual(again.rows);
  });

  it("writes nothing while off, with an empty watch, or with a zero cap", () => {
    const off = runScout({
      settings: { ...settings, enabled: false },
      sourcesText: SOURCES,
      watchText: watch,
      rows: [],
      briefs: {},
      now: 50,
      projectId: "crew",
    });
    expect(off.rows).toEqual([]);
    const empty = runScout({
      settings,
      sourcesText: SOURCES,
      watchText: "",
      rows: [],
      briefs: {},
      now: 50,
      projectId: "crew",
    });
    expect(empty.rows).toEqual([]);
    const zero = runScout({
      settings: { ...settings, maxDrafts: 0 },
      sourcesText: SOURCES,
      watchText: watch,
      rows: [],
      briefs: {},
      now: 50,
      projectId: "crew",
    });
    expect(zero.rows).toEqual([]);
  });
});
