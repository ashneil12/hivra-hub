// r80 (Critiquito, c02): a card's question says what the step does, not the tool's name ("use Read on validate.ts").
import { expect, it } from "vitest";
import { permissionQuestion } from "./chatQuestions";

const held = (tool: string, paths?: string[], command?: string) =>
  [{ id: "b1", role: "assistant", text: "", approval: { requestId: 7, decided: false, call: { tool, paths, command } } }] as never;

it("says what the step does in plain words; the raw command stays behind Open", () => {
  expect(permissionQuestion(held("Read", ["/tmp/x/packages/shared/src/validate.ts"]))?.question).toBe("Allow it to read validate.ts?");
  expect(permissionQuestion(held("Edit", ["/tmp/x/server.ts"]))?.question).toBe("Allow it to change server.ts?");
  expect(permissionQuestion(held("Grep", ["/tmp/x/src"]))?.question).toBe("Allow it to look through src?");
  const q = permissionQuestion(held("Bash", undefined, "cd /tmp/p/tally-worktrees/mc-1 && npm test"))?.question ?? "";
  expect(q).not.toMatch(/\/tmp|mc-1|npm/);
});
