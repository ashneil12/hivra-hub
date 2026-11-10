import { describe, expect, it } from "vitest";
import { briefText, curate, parseSources } from "./curate";

const hidden = `/${"Users"}/secret/notes`;
const windowsHidden = `${"\\"}Users${"\\"}secret`;

const SOURCES = `
# Sources

## The sources

| Source | Licence | What Hivra takes | How | Packages |
| --- | --- | --- | --- | --- |
| [firstmate](https://example.com/firstmate) | MIT | durable queue | Port | 10, 11 |
| [Orbit](https://example.com/orbit) | Apache-2.0 | board | Vendor | 70 |
| [later](https://example.com/later) | MIT | also ten | Port | 10 |
| [demo](https://example.com/demo) | MIT | port 12 ideas | Port | 4 |
| [skip](https://example.com/skip) | MIT | ${hidden} notes | Port | 3 |
| [MonoCode](https://example.com/mono) | MIT | the app | Fork | all |

## Vision to packages

| [not-a-source](https://example.com/no) | MIT | invented | Port | 999 |
`;

describe("source table", () => {
  it("reads names and package numbers, and stops at the vision list", () => {
    const rows = parseSources(SOURCES);
    expect(rows.map((row) => row.name)).toEqual(["firstmate", "Orbit", "later", "demo", "MonoCode"]);
    expect(rows[0]?.packages).toEqual([10, 11]);
    expect(rows.find((row) => row.name === "demo")?.packages).toEqual([4]);
    expect(rows.find((row) => row.name === "MonoCode")?.packages).toEqual([]);
    expect(parseSources("no table here")).toEqual([]);
    expect(parseSources("| [only](https://example.com/only) | MIT | a queue | Port | 8 |")).toEqual([
      { name: "only", licence: "MIT", takes: "a queue", packages: [8] },
    ]);
  });
});

describe("curate", () => {
  const watch = [
    "firstmate: Show the queue on the desk",
    "Orbit | Board notes | asked for the board",
    "Build a social network",
    "unknown: invent a product",
    "WP-10: Wake the queue",
    "FIRSTMATE: Show the queue on the desk",
    "firstmate:",
    "firstmate extra: Not this",
    "WP-12: Missing package",
    `firstmate: ${hidden}`,
    `Orbit | Board notes | ${windowsHidden}`,
    "wp-4: Count the demo",
    "# a comment",
    "",
  ].join("\r\n");

  it("keeps only lines that name a source in the table", () => {
    const proposals = curate(SOURCES, watch);
    expect(proposals.map((proposal) => `${proposal.source}: ${proposal.title}`)).toEqual([
      "firstmate: Show the queue on the desk",
      "Orbit: Board notes",
      "firstmate: Wake the queue",
      "demo: Count the demo",
    ]);
    expect(proposals[1]?.note).toBe("asked for the board");
    expect(proposals[2]?.source).toBe("firstmate");
    expect(curate(SOURCES, "")).toEqual([]);
    expect(curate(SOURCES, "   \n")).toEqual([]);
    expect(curate("", "firstmate: Show the queue on the desk")).toEqual([]);
    expect(curate(SOURCES, `firstmate | Show the queue | ${hidden}`)).toEqual([]);
  });

  it("quotes the source row and does not add a feature", () => {
    const [proposal] = curate(SOURCES, "Orbit | Board notes | asked for the board");
    expect(proposal).toBeDefined();
    if (!proposal) return;
    const text = briefText(proposal);
    expect(text).toContain("Source: Orbit (Apache-2.0).");
    expect(text).toContain("Already taken: board");
    expect(text).toContain("Packages: 70.");
    expect(text).toContain("The person asked: Board notes.");
    expect(text).toContain("Note: asked for the board");
    expect(text).toContain("This draft does not start work.");
    expect(text).not.toContain("social");
    const plain = curate(SOURCES, "MonoCode: Keep the fork");
    expect(briefText(plain[0]!).includes("Packages: none listed.")).toBe(true);
  });
});
