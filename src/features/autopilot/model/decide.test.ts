import { describe, expect, it } from "vitest";
import type { UserQuestionPrompt } from "../../sessions/model/userQuestion";
import { approvalVerdict, chatProject, decideCall, handBackText, questionVerdict, recommendedOptions } from "./decide";

const UNTIL = Date.parse("2026-10-19T09:00:00");

function prompt(questions: UserQuestionPrompt["questions"], title?: string): UserQuestionPrompt {
  return { requestId: 7, ...(title ? { title } : {}), questions };
}

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

describe("a chat's question under autopilot", () => {
  it("takes the option the agent marked (Recommended)", () => {
    const verdict = questionVerdict(
      prompt([
        {
          id: "q1",
          prompt: "Which lighting pass first?",
          multiSelect: false,
          allowCustom: true,
          options: [
            { id: "dusk", label: "Dusk (Recommended)" },
            { id: "night", label: "Night" },
          ],
        },
      ]),
      "Mon 9:00",
    );
    expect(verdict).toMatchObject({ kind: "answer", handedBack: false, taken: "Dusk", what: "Which lighting pass first?" });
    if (verdict.kind === "answer") expect(verdict.reply).toEqual({ kind: "answered", answers: { q1: ["dusk"] } });
  });

  it("finds a recommendation in the description too, and never picks Other", () => {
    expect(
      recommendedOptions({
        id: "q",
        prompt: "?",
        multiSelect: false,
        allowCustom: true,
        options: [
          { id: "a", label: "Keep it", description: "recommended: smallest change" },
          { id: "o", label: "Other (recommended)" },
        ],
      }).map((o) => o.id),
    ).toEqual(["a"]);
  });

  it("hands an unmarked question back to the agent in words", () => {
    const verdict = questionVerdict(
      prompt([{ id: "q1", prompt: "Which name?", multiSelect: false, allowCustom: true, options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }]),
      "Mon 9:00",
    );
    expect(verdict).toMatchObject({ kind: "answer", handedBack: true });
    if (verdict.kind === "answer") {
      expect(verdict.reply.custom?.q1).toBe(handBackText("Mon 9:00"));
      expect(verdict.reply.answers).toEqual({});
    }
  });

  it("takes the first option when no free text is allowed and none is marked, and a lone option as is", () => {
    const verdict = questionVerdict(
      prompt([
        { id: "q1", prompt: "Pick", multiSelect: false, allowCustom: false, options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
        { id: "q2", prompt: "Confirm", multiSelect: false, allowCustom: true, options: [{ id: "ok", label: "Go ahead" }, { id: "__custom__", label: "Other" }] },
      ]),
      "Mon 9:00",
    );
    if (verdict.kind !== "answer") throw new Error("expected an answer");
    expect(verdict.reply.answers).toEqual({ q1: ["a"], q2: ["ok"] });
    expect(verdict.taken).toContain("Alpha (its first option; none was marked recommended)");
    expect(verdict.taken).toContain("Go ahead");
  });

  it("holds a question that touches the red list, even when the agent marked a pick", () => {
    const verdict = questionVerdict(
      prompt([
        {
          id: "q1",
          prompt: "The customer was charged twice. What now?",
          multiSelect: false,
          allowCustom: true,
          options: [{ id: "r", label: "Refund the second charge (Recommended)" }, { id: "w", label: "Wait" }],
        },
      ]),
      "Mon 9:00",
    );
    expect(verdict).toEqual({ kind: "held", red: "money", what: "The customer was charged twice. What now?" });
  });

  it("holds a plain-looking question when the chat was told to ask Ash a red call", () => {
    const verdict = questionVerdict(
      prompt([{ id: "q1", prompt: "OK to go ahead?", multiSelect: false, allowCustom: true, options: [{ id: "y", label: "Yes (Recommended)" }] }], "Go ahead?"),
      "Mon 9:00",
      "prod-host",
    );
    expect(verdict).toEqual({ kind: "held", red: "prod-host", what: "Go ahead?" });
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
