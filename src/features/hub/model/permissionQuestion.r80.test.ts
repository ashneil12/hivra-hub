// r80 (Critiquito, c02): a card's question says what the step does, not the tool's name ("use Read on validate.ts").
import { expect, it } from "vitest";
import { permissionQuestion } from "./chatQuestions";

const held = (tool: string, paths?: string[], command?: string) =>
  [{ id: "b1", role: "assistant", text: "", approval: { requestId: 7, decided: false, call: { tool, paths, command } } }] as never;

it("says what the step does in plain words; the raw command stays behind Open", () => {
  expect(permissionQuestion(held("Read", ["/tmp/x/packages/shared/src/validate.ts"]))?.question).toBe("Allow it to look at validate.ts?");
  expect(permissionQuestion(held("Edit", ["/tmp/x/server.ts"]))?.question).toBe("Allow it to change server.ts?");
  expect(permissionQuestion(held("Grep", ["/tmp/x/src"]))?.question).toBe("Allow it to look through src?");
  const q = permissionQuestion(held("Bash", undefined, "cd /tmp/p/tally-worktrees/mc-1 && npm test"))?.question ?? "";
  expect(q).not.toMatch(/\/tmp|mc-1|npm/);
});

// r81 (Critiquito): no tool names, and who is asking instead of "it".
it("never names a tool, and says who is asking", async () => {
  const { askedBy, whoAsks } = await import("./chatQuestions");
  expect(permissionQuestion(held("Read", ["/tmp/x/validate.ts"]))?.question).toBe("Allow it to look at validate.ts?");
  expect(permissionQuestion(held("NotebookRead", ["/tmp/x/a.ipynb"]))?.question).toBe("Allow it to look at a.ipynb?");
  expect(permissionQuestion(held("mcp__x__thing"))?.question).toBe("Allow it to take its next step?");
  expect(permissionQuestion(held("WebFetch"))?.question).toBe("Allow it to look something up online?");
  expect(askedBy("Allow it to run the tests?", whoAsks({ title: "Health" }))).toBe("Allow the health worker to run the tests?");
  expect(askedBy("Allow it to look at App.tsx?", whoAsks({ monoName: "Tally Lead" }))).toBe("Allow the Tally Lead to look at App.tsx?");
  expect(askedBy("Allow it to look at App.tsx?", whoAsks({ monoName: "Pip" }))).toBe("Allow Pip to look at App.tsx?");
  expect(askedBy("Allow it to run the tests?", whoAsks({ title: "mc-89dad719" }))).toBe("Allow it to run the tests?");
});

it("r82 (c02): no harness in the name, and a coding-team chat is a chat, not a worker", async () => {
  const { askedBy, whoAsks } = await import("./chatQuestions");
  expect(whoAsks({ title: "claude · Health" })).toBe("the health worker");
  expect(askedBy("Allow it to look at App.tsx?", whoAsks({ title: "claude · Tally health, bumps, and totals", orchestrator: true }))).toBe(
    "Allow the Tally health, bumps, and totals chat to look at App.tsx?",
  );
});
