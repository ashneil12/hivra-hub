import { describe, expect, it } from "vitest";
import { plainCommandQuestion } from "./plainCommand";

const T = "/private/var/folders/b4/x/T/monocode-realtest-Spyopv/projects/tally-worktrees";

describe("plainCommandQuestion (Critiquito, 29 Oct: say what the step does, never the raw command)", () => {
  it.each([
    [`WT=${T}\nfor d in mc-f46854a8 mc-89bc2fdb; do\n  echo "== $d =="\n  git -C "$WT/$d" status -sb\n  git -C "$WT/$d" diff\ndone`, "Allow it to check what's changed in two workers' copies of Tally?"],
    [`for d in ${T}/*; do echo "=== $(basename "$d") ==="; git -C "$d" status --short; done`, "Allow it to check what's changed in each worker's copy of Tally?"],
    [`git -C ${T}/mc-89dad719 diff -- packages/api/src/server.ts`, "Allow it to check what's changed in a worker's copy of Tally?"],
    ["npm test", "Allow it to run the tests?"],
    ["git worktree add ../tally-health-board", "Allow it to make a worker's copy?"],
    ["rg -n -g '*.{ts,tsx}' 'week|Monday' packages", "Allow it to search its files?"],
    ["jq '.x' data.json", "Allow it to run a command?"],
  ])("%s", (command, question) => {
    expect(plainCommandQuestion(command)).toBe(question);
  });

  it("never shows a temp path, a worker id or a backtick", () => {
    const q = plainCommandQuestion(`git -C ${T}/mc-3c34a52e status --short && git -C ${T}/mc-aa03d335 diff`);
    expect(q).not.toMatch(/\/|mc-[0-9a-f]|`/);
  });
});
