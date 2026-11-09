// The repo rules live once, in AGENTS.md, and CLAUDE.md imports them (WP-105). A merge that drops the import, or a
// rule that lands only in CLAUDE.md, would leave Codex and OpenCode workers without it; this fails when that happens.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("CLAUDE.md starts by importing AGENTS.md", () => {
  const lines = read("CLAUDE.md")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(lines[0], "@AGENTS.md");
});

test("AGENTS.md holds every section the repo's rules are known by", () => {
  const agents = read("AGENTS.md");
  assert.ok(agents.startsWith("# MonoCode Hub"), "AGENTS.md lost its title");
  const sections = [
    "## This repo is NOT upstream MonoCode",
    "## The trap that already bit us",
    "## Which copy is which",
    "## Before you build or launch",
    "## Ship",
    "## Conversations",
    "## Upstream merges",
    "## Development basics",
    "### See a Hub change in the running app",
    "## Project file and worktree clean-up",
    "## Signing",
    "## Restart-safe resume and the fake-Claude bench",
    "## Improvement loop and isolated test copy",
    "## Ash OS is retired",
    "## Export and import",
  ];
  for (const section of sections) {
    assert.match(agents, new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), `AGENTS.md lost its "${section}" section`);
  }
});

test("CLAUDE.md adds only Claude Code's part", () => {
  const claude = read("CLAUDE.md");
  const agents = read("AGENTS.md");
  assert.ok(claude.split("\n").length < 40, "CLAUDE.md is meant to be a short Claude-only file");
  const sections = [...claude.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  for (const section of sections) {
    assert.ok(!agents.includes(`## ${section}\n`), `"${section}" belongs in AGENTS.md, not CLAUDE.md`);
  }
});

test("the shipped dev copy keeps its Claude hooks", () => {
  // The Claude-only text that left AGENTS.md must still be in CLAUDE.md, not lost in the move.
  assert.match(read("CLAUDE.md"), /~\/\.monocode-hub-dev\/claude-config/);
});

test("mobile keeps its own AGENTS.md import", () => {
  assert.equal(read("mobile/CLAUDE.md").trim(), "@AGENTS.md");
  assert.ok(read("mobile/AGENTS.md").includes("Expo Router"));
});
