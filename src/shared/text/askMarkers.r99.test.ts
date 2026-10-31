// r99 (Critiquito 1): no "Needs the user:" / "Needs Ash:" / "My pick:" markers in the reply Ash reads, and never
// "the user" or "Ash" about him in his own chat. The saved text keeps the markers (the ask card is parsed from it).
import { expect, it } from "vitest";
import { withoutAskMarkers } from "./askMarkers";
import { parseNeedsAsh } from "../../features/hub/model/chatQuestions";

const reply = [
  "Parked 34 of them.",
  "",
  "Needs the user: The privacy page is legal copy, so I'll wait for the user's wording. Publish it now, or wait?",
  "My pick: Don't publish it yet.",
  "",
  "**Needs Ash (red line):** Should Ash sign off on the Hivra price change?",
  "```",
  "Needs Ash: inside code stays",
  "```",
].join("\n");

it("drops the markers and speaks to Ash in the second person", () => {
  const shown = withoutAskMarkers(reply);
  const prose = shown.split("```")[0]!;
  expect(prose).not.toMatch(/Needs (?:the user|Ash)\b/);
  expect(prose).not.toMatch(/My pick\s*:|the user|\bAsh\b/);
  expect(shown).toContain("The privacy page is legal copy, so I'll wait for your wording. Publish it now, or wait?");
  expect(shown).toContain("I'd go with don't publish it yet.");
  expect(shown).toContain("Should you sign off on the Hivra price change?");
  expect(shown).toContain("Needs Ash: inside code stays");
  expect(shown.split("\n")[0]).toBe("Parked 34 of them.");
});

it("leaves the saved text alone, so the ask card still comes from it", () => {
  expect(parseNeedsAsh(reply)).not.toBeNull();
  expect(withoutAskMarkers("No asks here.")).toBe("No asks here.");
});

it("the ask card speaks to Ash too", () => {
  const ask = parseNeedsAsh(reply.split("```")[0]!);
  expect(ask?.question).not.toMatch(/the user|\bAsh\b/);
  const card = parseNeedsAsh("Needs the user: The privacy page is legal copy, so I'll wait for the user's wording. Publish it now, or wait?\nMy pick: Don't publish it yet.");
  expect(card?.question).toContain("I'll wait for your wording.");
  expect(card?.pick).toBe("Don't publish it yet.");
});
