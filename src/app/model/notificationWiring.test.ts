// WP-164: two things only App.tsx can do, so a test reads it. The model tests pass whether or not the app ever calls
// them; these fail when the call is taken out.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

it("the app looks for a due notable-event ping, or a held notice would never leave", () => {
  expect(app).toMatch(/import \{ useNotablePings \} from "\.\.\/features\/notifications\/hooks\/useNotablePings";/);
  // A call on a line of its own: a mention in a comment or a string does not count.
  expect(app).toMatch(/^\s*useNotablePings\(\);\s*$/m);
});

it("a turn that failed is announced as a failure, not as a finished turn that quiet hours hold", () => {
  expect(app).toMatch(/const turnFailed = controlOutcome\.status === "failed";/);
  expect(app).toMatch(/announceSessionFinished\(finished, visible, turnFailed\)/);
  // The one other caller is a habit's post to its Mono's chat, which is not a turn that ended in an error.
  expect(app.match(/announceSessionFinished\(/g)).toHaveLength(2);
});
