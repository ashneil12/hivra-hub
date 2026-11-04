import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, skillEntries, splitPurpose } from "./pstack-index.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "pstack-index-"));
  dirs.push(dir);
  return dir;
}

function skill(root, folder, text) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
}

describe("parseFrontmatter", () => {
  it("reads only the first block, including a folded description and CRLF", () => {
    const front = parseFrontmatter(
      `${String.fromCharCode(0xfeff)}---\r\nname: "folded"\r\ndescription: >-\r\n  Use when the work is folded.\r\n  It stays one description.\r\n---\r\ndescription: not the skill\r\n`,
    );
    assert.deepEqual(front, {
      name: "folded",
      description: "Use when the work is folded. It stays one description.",
    });
  });

  it("returns nothing for an empty file, a missing close, or no description", () => {
    assert.equal(parseFrontmatter(""), undefined);
    assert.equal(parseFrontmatter("---\nname: x\n"), undefined);
    assert.equal(parseFrontmatter("---\nname: x\n---\n"), undefined);
    assert.equal(parseFrontmatter("no frontmatter\n"), undefined);
  });
});

describe("splitPurpose", () => {
  it("keeps a description with no when-clause in both fields", () => {
    assert.deepEqual(splitPurpose("  Cut AI tells from any writing. "), {
      for: "Cut AI tells from any writing.",
      when: "Cut AI tells from any writing.",
    });
  });

  it("splits a when-sentence off, and a when-clause inside one sentence", () => {
    assert.deepEqual(
      splitPurpose("Vet a measurement before you report it. Use when you run a benchmark."),
      { for: "Vet a measurement before you report it.", when: "Use when you run a benchmark." },
    );
    assert.deepEqual(splitPurpose("Cut the noise. Use only when the user asks for TDD."), {
      for: "Cut the noise.",
      when: "Use only when the user asks for TDD.",
    });
    assert.deepEqual(splitPurpose("A short check. Use for a number you are about to ship."), {
      for: "A short check.",
      when: "Use for a number you are about to ship.",
    });
    assert.deepEqual(splitPurpose("Use before the first commit, after you have read the diff."), {
      for: "Use before the first commit, after you have read the diff.",
      when: "Use before the first commit, after you have read the diff.",
    });
  });

  it("does not treat Used as the when-clause, so the whole description stays in both fields", () => {
    assert.deepEqual(splitPurpose("Used when the build is red. Leave it."), {
      for: "Used when the build is red. Leave it.",
      when: "Used when the build is red. Leave it.",
    });
  });
});

describe("skillEntries", () => {
  it("lists every skill, skips a folder with no SKILL.md, and refuses a duplicate name or a bad file", () => {
    const root = scratch();
    skill(root, "b", "---\nname: beta\ndescription: Second. Use when you need beta.\n---\n");
    skill(root, "a", "---\nname: alpha\ndescription: First.\n---\n");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "README.md"), "not a skill");
    const entries = skillEntries(root);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["alpha", "beta"],
    );
    assert.equal(entries[1].rel, "skills/b/SKILL.md");
    assert.equal(entries[1].when, "Use when you need beta.");
    assert.equal(entries[0].for, "First.");

    skill(root, "c", "---\nname: alpha\ndescription: Again.\n---\n");
    assert.throws(() => skillEntries(root), /named alpha/);
    rmSync(join(root, "c"), { recursive: true });
    skill(root, "d", "hello");
    assert.throws(() => skillEntries(root), /d\/SKILL.md/);
  });

  it("keeps a space and a unicode folder name", () => {
    const root = scratch();
    skill(root, "my skill", "---\nname: spaced\ndescription: A skill.\n---\n");
    skill(root, "阿什", "---\nname: uni\ndescription: 技能。\n---\n");
    const names = skillEntries(root).map((entry) => entry.rel);
    assert.deepEqual(names.sort(), ["skills/my skill/SKILL.md", "skills/阿什/SKILL.md"].sort());
  });
});
