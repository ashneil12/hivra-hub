import { expect, it } from "vitest";
import { usageChipLabel } from "./rateLimits";
import { wantsClaudeChip } from "../../../app/shell/UsageFooter";
import { claudeRunsOnGrok } from "../../../integrations/harness/providers/claude/claudeGrokBridge";

const now = Date.UTC(2026, 9, 31, 12);
const min = 60_000;

it("r102: when the Claude chip shows, its label names the provider it measures", () => {
  expect(usageChipLabel("weekly", { usedPercent: 40, windowMinutes: 10080, resetsAt: now + 60 * min }, now, false, "Claude")).toBe("Claude week: 40% used · resets in 1h");
  expect(usageChipLabel("session", { usedPercent: 3, windowMinutes: 300, resetsAt: null }, now, false, "Claude")).toBe("Claude 5h: 3% used of 5h");
  expect(usageChipLabel("weekly", { usedPercent: 99, windowMinutes: 10080, resetsAt: now + 60 * min }, now, false, "Claude")).toBe("Claude weekly limit nearly used, resets in 1h");
});

it("r102: set up like the Grok bridge, the Claude usage chip is hidden (no sample numbers)", () => {
  expect(wantsClaudeChip(["claude", "codex"], claudeRunsOnGrok("/Users/ash/.local/bin/claude-grok", false))).toBe(false);
  expect(wantsClaudeChip(["claude"], claudeRunsOnGrok(null, true))).toBe(false);
  expect(wantsClaudeChip(["claude"], claudeRunsOnGrok("/usr/local/bin/claude", false))).toBe(true);
  expect(wantsClaudeChip(["codex"], false)).toBe(false);
});
