import { describe, expect, it } from "vitest";
import { emptyGapLedger } from "./ledger";
import { overlapReport } from "./overlap";
import { emptyRejections } from "./rejection";
import { costOf, measureRun, parseModelFiles } from "./run";
import { profileText } from "./profile";

const NOW = "2026-11-05T00:00:00.000Z";
const QUOTE_A = "the launch notes were wrong";
const QUOTE_B = "the launch notes were wrong again";

function model(file: string, staged: string) {
  return JSON.stringify({
    files: [
      {
        file,
        title: "Say it once",
        staged,
        sightings: [
          { sessionId: "one", quote: QUOTE_A, proposedInstruction: "Say the lesson once." },
          { sessionId: "two", quote: QUOTE_B, proposedInstruction: "Say the lesson once." },
        ],
      },
      { file: "plugins/installed/pstack/SKILL.md", title: "No", staged: "stolen\n", sightings: [] },
    ],
  });
}

describe("learn run", () => {
  it("drops model text that is not the expected shape", () => {
    expect(parseModelFiles("no json")).toEqual([]);
    expect(parseModelFiles("{")).toEqual([]);
    expect(parseModelFiles('{"files":[{"file":"AGENTS.md"}]}')).toEqual([]);
    expect(parseModelFiles('{"files":[{"file":"AGENTS.md","staged":"x","sightings":[{"sessionId":1}]}]}')).toEqual([
      { file: "AGENTS.md", title: "", staged: "x", sightings: [] },
    ]);
  });

  it("counts a shared store once", () => {
    const once = costOf([
      { source: "opencode", root: "/db", rel: "a", bytes: 400 },
      { source: "opencode", root: "/db", rel: "b", bytes: 400 },
      { source: "pi", root: "/pi", rel: "a.jsonl", bytes: 40 },
    ]);
    expect(once).toBe(Math.ceil(440 / 4));
    expect(costOf([])).toBe(0);
    expect(costOf([{ source: "pi", root: "/pi", rel: "a.jsonl", bytes: Number.NaN }])).toBe(0);
  });

  it("proposes a named file from two chats and ignores a plugin path", () => {
    const original = "Keep the old line.\n";
    const staged = "Keep the old line.\nSay the lesson once.\n";
    const result = measureRun({
      named: [{ path: "opinions.md", role: "opinions", original }],
      modelText: model("opinions.md", staged),
      transcripts: [
        { id: "one", text: `user: ${QUOTE_A}` },
        { id: "two", text: `user: ${QUOTE_B}` },
      ],
      ledger: emptyGapLedger(),
      rejections: emptyRejections(),
      pluginRoots: ["/data/plugins"],
      now: NOW,
    });
    expect(result.refused).toBeNull();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].quotes).toHaveLength(2);
    expect(result.proposals[0].file).toBe("opinions.md");
    expect(result.proposals[0].diff).toContain("Say the lesson once.");
  });

  it("refuses a plugin file even when the run names it", () => {
    const result = measureRun({
      named: [{ path: "plugins/installed/pstack/SKILL.md", role: "skill", original: "old\n" }],
      modelText: model("plugins/installed/pstack/SKILL.md", "new\n"),
      transcripts: [
        { id: "one", text: QUOTE_A },
        { id: "two", text: QUOTE_B },
      ],
      ledger: emptyGapLedger(),
      rejections: emptyRejections(),
      pluginRoots: [],
      now: NOW,
    });
    expect(result.proposals).toEqual([]);
    expect(result.refused).toMatch(/plugin/i);
  });

  it("gives agents opinions, and voice only when the turn drafts in the person's name", () => {
    const opinions = "# Opinions\n\n## Small commits\n\nThey are easier to read.\n\nEvidence: session:one, session:two\n";
    const voice = "# Voice\n\nShort sentences.\n";
    expect(profileText("# Opinions\n", voice, "fix the bug")).toBeNull();
    expect(profileText(opinions, voice, "fix the bug")).toContain("Small commits");
    expect(profileText(opinions, voice, "fix the bug")).not.toContain("Short sentences");
    expect(profileText(opinions, voice, "Write this in my name")).toContain("Short sentences");
  });

  it("reports overlap and does not change the lines it was given", () => {
    const lines = ["Say the lesson once, in the file the run named."];
    const skills = [
      { name: "lesson", description: "Say the lesson once, in the file the run named." },
      { name: "other", description: "Ship on Friday." },
    ];
    const before = JSON.stringify({ lines, skills });
    const hits = overlapReport(lines, skills);
    expect(hits.map((hit) => hit.skill)).toEqual(["lesson"]);
    expect(hits[0].surface).toBe("description");
    expect(JSON.stringify({ lines, skills })).toBe(before);
  });
});
