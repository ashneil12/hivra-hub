// The ast-grep rules (rules/, rule-tests/, sgconfig.yml). This test does not run the rules (ast-grep-guard.test.mjs
// runs `ast-grep test` when the binary is installed): it checks that every rule file has the keys ast-grep needs, that severity is only a warning
// or a hint, and that every rule has a test file with at least one valid and one invalid snippet.
// To run the rules themselves: `npx ast-grep test` and `npx ast-grep scan`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ruleDir = path.join(repo, "rules");
const testDir = path.join(repo, "rule-tests");
const ruleFiles = readdirSync(ruleDir).filter((name) => name.endsWith(".yml"));

/** Top-level keys of a simple YAML mapping (lines that start in column 0). */
function topKeys(text) {
  return [...text.matchAll(/^([A-Za-z][A-Za-z0-9_-]*):/gm)].map((match) => match[1]);
}

test("there are rules", () => {
  assert.ok(ruleFiles.length >= 3);
  assert.match(readFileSync(path.join(repo, "sgconfig.yml"), "utf8"), /ruleDirs:\s*\n\s*- rules/);
});

for (const name of ruleFiles) {
  const text = readFileSync(path.join(ruleDir, name), "utf8");
  const id = /^id:\s*(\S+)\s*$/m.exec(text)?.[1];

  test(`${name} has the keys ast-grep needs`, () => {
    const keys = topKeys(text);
    for (const key of ["id", "language", "rule", "message", "severity"]) {
      assert.ok(keys.includes(key), `${name} has no ${key}`);
    }
    assert.equal(id, name.replace(/\.yml$/, ""), "the id matches the file name");
    assert.match(text, /^language:\s*(?:rust|typescript|tsx|javascript)\s*$/m);
    assert.match(text, /^rule:\s*\n {2}\S/m, "rule has a body");
  });

  test(`${name} is a warning or a hint, never an error`, () => {
    const severity = /^severity:\s*(\S+)\s*$/m.exec(text)?.[1];
    assert.ok(["warning", "hint"].includes(severity), `severity is ${severity}`);
  });

  test(`${name} has a test with a valid and an invalid example`, () => {
    const testText = readFileSync(path.join(testDir, `${id}-test.yml`), "utf8");
    assert.match(testText, new RegExp(`^id:\\s*${id}\\s*$`, "m"));
    assert.match(testText, /^valid:\s*\n\s*- \|/m);
    assert.match(testText, /^invalid:\s*\n\s*- \|/m);
  });
}

test("every rule test names a rule that exists", () => {
  for (const name of readdirSync(testDir).filter((file) => file.endsWith("-test.yml"))) {
    const id = name.replace(/-test\.yml$/, "");
    assert.ok(ruleFiles.includes(`${id}.yml`), `${name} has no rule`);
  }
});
