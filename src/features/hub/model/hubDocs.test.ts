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

it("the hub docs say a Mono can propose a team (team_create) for an area, made only on Ash's yes (A6)", () => {
  expect(readme).toMatch(/A new team: `team_create`/);
  expect(readme).toContain("a team goes in only on Ash's yes");
  expect(readme).toMatch(/Undo \(the team and its room go; its Monos stay\)/);
});

it("the hub docs describe the plain group chat and the quiet brake strip", () => {
  expect(readme).toContain("If he names nobody, every other seat then gets one turn to reply in its own voice.");
  expect(readme).toContain("The pause shows in a quiet strip above the composer, not as a message.");
  expect(readme).not.toMatch(/lane his message touches/);
});

it("the hub docs say how a Mono is deleted: only by Ash, from the sidebar, with the app's confirm (AD16 run f451: CoS searched the hub's source and test files for a delete tool)", () => {
  expect(readme).toContain("Deleting a Mono: there is no tool for it, so no Mono deletes one.");
  expect(readme).toContain("Delete mono…");
});

it("the hub docs say what's shipped and what's stuck come from the hub and the local checkout, never gh (AD14 runs f451 and 08f7: the Hivra coding chat asked to run gh pr list and sat on the Allow card)", () => {
  expect(readme).toContain("## What's shipped, what's stuck");
  expect(readme).toContain("never from GitHub: no `gh`, `git fetch` or anything else that goes online");
  expect(readme).toMatch(/`task_status`/);
  expect(readme).toContain("`jobs.read` (done jobs carry `finishedAt`)");
  // The docs must never tell a chat to reach for gh.
  expect(readme).not.toMatch(/`gh (pr|api|issue|run)/);
});
