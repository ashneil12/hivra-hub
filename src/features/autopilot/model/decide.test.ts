import { describe, expect, it } from "vitest";
import { approvalVerdict, chatProject, decideCall, handBackText } from "./decide";

const UNTIL = Date.parse("2026-10-19T09:00:00");

describe("autopilot.decide", () => {
  it("is off without a covering switch", () => {
    expect(decideCall({ question: "Split into two PRs?", recommendation: "Yes", until: undefined })).toEqual({ outcome: "off" });
  });

  it("takes the agent's recommendation while on", () => {
    expect(decideCall({ question: "Split into two PRs?", recommendation: "Yes, two PRs", until: UNTIL })).toEqual({
      outcome: "taken",
      answer: "Yes, two PRs",
      until: UNTIL,
    });
  });

  it("never takes a red-list call: by its words, its options, or the agent's own mark", () => {
    expect(decideCall({ question: "What about the duplicate charge?", recommendation: "Refund the customer", until: UNTIL })).toMatchObject({ outcome: "held", red: "money" });
    expect(decideCall({ question: "Clean up?", recommendation: "Option B", options: ["A: keep", "B: DROP TABLE sessions"], until: UNTIL })).toMatchObject({ outcome: "held", red: "delete" });
    expect(decideCall({ question: "Ship the banner copy?", recommendation: "Yes", declaredRed: "send-as-ash", until: UNTIL })).toMatchObject({ outcome: "held", red: "send-as-ash" });
    expect(decideCall({ question: "Rotate the API key?", recommendation: "Yes", declaredRed: "none", until: UNTIL })).toMatchObject({ outcome: "held", red: "credentials" });
  });
});

describe("a question with no pick", () => {
  it("is handed back with the end time and the red list", () => {
    const text = handBackText("Mon 9:00");
    expect(text).toContain("until Mon 9:00");
    expect(text).toContain("take your own recommendation");
    expect(text).toContain("still waits for him");
  });
});

describe("a tool approval under autopilot", () => {
  it("allows ordinary tool calls", () => {
    expect(approvalVerdict({ text: "Run tests", tool: { title: "npm run check", kind: "execute" } })).toEqual({ kind: "allow", what: "npm run check" });
  });

  it("holds red-list commands", () => {
    expect(approvalVerdict({ text: "", tool: { title: "rm -rf ~/Library/Application Support/x", kind: "execute" } })).toMatchObject({ kind: "held", red: "delete" });
    expect(approvalVerdict({ text: "", tool: { title: "git push --force origin main", kind: "execute" } })).toMatchObject({ kind: "held", red: "mass-destructive" });
    expect(approvalVerdict({ text: "", tool: { title: "mcp__slack__chat_postMessage", kind: "other" } })).toMatchObject({ kind: "held", red: "send-as-ash" });
    expect(approvalVerdict({ text: "", tool: { title: "Read file", detail: "cat ~/.ssh/id_ed25519" } })).toMatchObject({ kind: "held", red: "credentials" });
  });
});

describe("which project a chat belongs to", () => {
  const projects = [
    { id: "hivra", folder: "/Users/ash/Projects/hivra" },
    { id: "hub", folder: "/Users/ash/Projects/monocode-hub" },
    { id: "ash", folder: null },
  ];

  it("a Lead is its project; a one-project Mono that project; a multi-project Mono none", () => {
    expect(chatProject({ cwd: "/Users/ash" }, projects, { projects: [], leadProjectId: "vg-game" })).toBe("vg-game");
    expect(chatProject({ cwd: "/Users/ash" }, projects, { projects: ["/Users/ash/Projects/hivra"] })).toBe("hivra");
    expect(chatProject({ cwd: "/Users/ash" }, projects, { projects: ["/Users/ash/Projects/hivra", "/Users/ash/Projects/monocode-hub"] })).toBeNull();
  });

  it("any other chat goes by its folder", () => {
    expect(chatProject({ cwd: "/Users/ash/Projects/monocode-hub" }, projects)).toBe("hub");
    expect(chatProject({ cwd: "/Users/ash/Projects/hivra/dashboard" }, projects)).toBe("hivra");
    expect(chatProject({ cwd: "/Users/ash/Projects/hivra-old" }, projects)).toBeNull();
    expect(chatProject({ cwd: "/tmp/x", worktreeCwd: "/Users/ash/Projects/hivra" }, projects)).toBe("hivra");
  });
});
