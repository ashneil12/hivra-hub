import { expect, it } from "vitest";
import { usageChipLabel } from "./rateLimits";
import { wantsClaudeChip } from "../../../app/shell/UsageFooter";

const now = Date.UTC(2026, 9, 31, 12);
const min = 60_000;

it("when the Claude chip shows, its label names the provider it measures", () => {
  expect(usageChipLabel("weekly", { usedPercent: 40, windowMinutes: 10080, resetsAt: now + 60 * min }, now, false, "Claude")).toBe("Claude week: 40% used · resets in 1h");
  expect(usageChipLabel("session", { usedPercent: 3, windowMinutes: 300, resetsAt: null }, now, false, "Claude")).toBe("Claude 5h: 3% used of 5h");
  expect(usageChipLabel("weekly", { usedPercent: 99, windowMinutes: 10080, resetsAt: now + 60 * min }, now, false, "Claude")).toBe("Claude weekly limit nearly used, resets in 1h");
});

it("on the DeepSeek launcher the Claude usage chip is hidden", () => {
  expect(wantsClaudeChip(["claude", "codex"], true)).toBe(false);
  expect(wantsClaudeChip(["claude"], true)).toBe(false);
  expect(wantsClaudeChip(["claude"], false)).toBe(true);
  expect(wantsClaudeChip(["codex"], false)).toBe(false);
});
