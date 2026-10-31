// r102 (12, Critiquito): small fixes. Rail unread counts are grey and smaller than the red badge; two picks say "both";
// an untitled chat is named by its first ask, not "New session".
import { expect, it } from "vitest";
import { RAIL_UNREAD_CLASS } from "./MonoRailSection";
import { takeAllLabel } from "../../features/hub/ui/WaitingOnYou";
import { firstAskOf, sessionDisplayTitle, shortAskTitle } from "../../features/sessions/model/session";

it("rail unread count is grey and small, never red or accent", () => {
  expect(RAIL_UNREAD_CLASS).toMatch(/text-\[9px\]/);
  expect(RAIL_UNREAD_CLASS).toMatch(/text-content\/70/);
  expect(RAIL_UNREAD_CLASS).not.toMatch(/bg-accent|bg-red|text-white/);
});

it("says 'Take both picks' for two", () => {
  expect(takeAllLabel(2)).toBe("Take both picks");
  expect(takeAllLabel(3)).toBe("Take all 3 picks");
});

it("names an untitled chat by its first ask", () => {
  expect(sessionDisplayTitle("claude", "claude", "Should the export be CSV or Excel? I'd guess CSV.")).toBe("Should the export be CSV or Excel?");
  expect(sessionDisplayTitle("claude", "claude")).toBe("New session");
  expect(sessionDisplayTitle("Real title", "claude", "anything")).toBe("Real title");
  expect(shortAskTitle("Please move the whole billing page over to the new layout and keep the old links working")).toMatch(/^Please move the whole billing page over to the…$/);
  expect(firstAskOf({ blocks: [{ role: "assistant", text: "hi" }, { role: "user", text: "Fix the login" }] })).toBe("Fix the login");
});
