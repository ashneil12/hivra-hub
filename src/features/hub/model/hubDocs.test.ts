// The hub docs every chat's note points at (docs/hub/README.md, shipped as hub-docs/README.md): a Mono reading them
// learns it can just make a new Mono with Ash in chat (AD13: Monos kept telling Ash it could only be done in Settings).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const readme = readFileSync(join(__dirname, "../../../../docs/hub/README.md"), "utf8");

it("the hub docs say Ash can just ask a Mono to make a new Mono (mono_create), with no trip to Settings", () => {
  expect(readme).toContain("Ash can just ask any Mono for these in chat; nothing needs Settings.");
  expect(readme).toMatch(/A new Mono: `mono_create`/);
  expect(readme).not.toMatch(/only (be made )?in Settings/i);
});

it("the hub docs describe the plain group chat and the quiet brake strip", () => {
  expect(readme).toContain("If he names nobody, every other seat then gets one turn to reply in its own voice.");
  expect(readme).toContain("The pause shows in a quiet strip above the composer, not as a message.");
  expect(readme).not.toMatch(/lane his message touches/);
});
