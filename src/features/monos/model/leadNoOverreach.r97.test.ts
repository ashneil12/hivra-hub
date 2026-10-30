// r97 (frank f, c02 BLIND 242d +340s): the Lead sent off a median fix nobody asked for, just to turn npm test green,
// after its workers had left that failure alone. The no-overreach rule holds for the Lead too: report, don't fix.
import { expect, it } from "vitest";
import { codingTeamContext, TEAM_CHAT_RULES } from "./monoFiles";

it("tells the Lead not to change code or tests just to turn a check green", () => {
  expect(TEAM_CHAT_RULES).toMatch(/edit code or tests to turn green a check a worker left failing or called expected: ask Ash\./);
  const prompt = codingTeamContext({ projectId: "tally", projectName: "Tally", folder: "/tmp/tally" });
  expect(prompt).toContain("edit code or tests to turn green a check a worker left failing or called expected");
});
