import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/** The plugin the app installs. Skill files live here, not in a second copy. */
export const RPI_ROOT = resolve("src-tauri/plugins/hivra-rpi");

const HUMANLAYER = "f9bd73534a9fb7099a274f951b698b1297122fd9";
const MATT = "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d";

const FROM_HUMANLAYER: Record<string, { source: string; sentence: string }> = {
  "research-questions": {
    source: "apps/riptide-rpi-claude-plugin/skills/create-research-questions/SKILL.md",
    sentence: "You are a research orchestrator helping to create research questions",
  },
  research: {
    source: "apps/riptide-rpi-claude-plugin/skills/create-research/SKILL.md",
    sentence: "You are creating a technical map/documentation of the existing system",
  },
  "design-discussion": {
    source: "apps/riptide-rpi-claude-plugin/skills/create-design-discussion/SKILL.md",
    sentence: "You are now in the Design Discussion phase.",
  },
  "implement-outline": {
    source: "apps/riptide-rpi-claude-plugin/skills/implement-outline/SKILL.md",
    sentence: "You are the orchestrator for implementing a structure outline",
  },
  "product-document": {
    source: "apps/riptide-rpi-claude-plugin/skills/create-prd/SKILL.md",
    sentence: "You are creating a Product Requirements Document (PRD)",
  },
  "technical-document": {
    source: "apps/riptide-rpi-claude-plugin/skills/create-tdd/SKILL.md",
    sentence: "You are creating a Technical Design Document (TDD)",
  },
  "iterate-design": {
    source: "apps/riptide-rpi-claude-plugin/skills/iterate-design-discussion/SKILL.md",
    sentence: "You are iterating on an existing design discussion document based on user feedback.",
  },
};

it("copies HumanLayer's skill text, with only the wording Hivra has to change", () => {
  for (const [name, spec] of Object.entries(FROM_HUMANLAYER)) {
    const text = readFileSync(resolve(RPI_ROOT, "skills", name, "SKILL.md"), "utf8");
    expect(text, name).toContain(spec.sentence);
    expect(text, name).toContain(`Source: ${spec.source} @ ${HUMANLAYER}`);
    expect(text, name).not.toContain(".humanlayer/tasks");
    expect(text, name).not.toContain("Linear/GitHub");
    expect(text, name).not.toContain("Linear ticket");
    // An HTTP example is not a slash command. `PUT /api/sessions/:id` stays.
    for (const line of text.split("\n")) {
      if (/^\s*(GET|POST|PUT|PATCH|DELETE)\b/.test(line) || line.includes("Client->>")) continue;
      expect(line, name).not.toMatch(/(^|\s)\/[a-z][a-z0-9:-]+/);
    }
  }
  expect(readFileSync(resolve(RPI_ROOT, "skills", "research", "SKILL.md"), "utf8")).toContain("LinearService");
  for (const left of ["ci-commit", "configure-workspaces", "setup-worktree", "oneshot"]) {
    expect(existsSync(resolve(RPI_ROOT, "skills", left)), left).toBe(false);
  }
});

it("credits HumanLayer and Matt Pocock beside the files, not Ash", () => {
  const license = readFileSync(resolve(RPI_ROOT, "LICENSE"), "utf8");
  const notice = readFileSync(resolve(RPI_ROOT, "NOTICE"), "utf8");
  expect(license).not.toContain("Ashneil");
  expect(license).toContain("Apache License");
  expect(license).toContain("Version 2.0");
  expect(notice).toContain("Copyright 2025-2026 QueryTale, Inc. d/b/a HumanLayer");
  expect(notice).not.toContain("rewritten");
  expect(notice).not.toContain("Ashneil");
  for (const name of ["diagnosing-bugs", "rpi-tdd", "grill-me"]) {
    const theirs = readFileSync(resolve(RPI_ROOT, "skills", name, "LICENSE"), "utf8");
    expect(theirs, name).toContain("MIT License");
    expect(theirs, name).toContain("Copyright (c) 2026 Matt Pocock");
    const skill = readFileSync(resolve(RPI_ROOT, "skills", name, "SKILL.md"), "utf8");
    expect(skill, name).toContain(`@ ${MATT}`);
  }
  const credits = JSON.parse(readFileSync(resolve("docs/hivra/credits.json"), "utf8")) as {
    inspirations: { name: string; gave: string }[];
    components: { name: string; copyright: string; how: string }[];
  };
  const human = credits.components.find((entry) => entry.name === "Hivra research, plan and build skills");
  const matt = credits.components.find((entry) => entry.name === "Hivra diagnosing-bugs, tdd and grill-me");
  expect(human?.copyright).toBe("Copyright 2025-2026 QueryTale, Inc. d/b/a HumanLayer");
  expect(human?.how ?? "").not.toMatch(/rewritten|Hivra's because/);
  expect(matt?.copyright).toBe("Copyright (c) 2026 Matt Pocock");
  expect(matt?.how ?? "").not.toMatch(/text is Hivra's/);
  expect(JSON.stringify(credits)).not.toContain("Copyright 2026 Ashneil Lanelle");
  const inspiration = credits.inspirations.filter((entry) => entry.name === "HumanLayer" || entry.name === "Matt Pocock's skills");
  expect(inspiration).toHaveLength(2);
  for (const entry of inspiration) expect(entry.gave).not.toMatch(/text is Hivra's|LICENSE file was not/);
});

it("leaves no HumanLayer task path or slash command in the copied plugin", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, name.name);
      if (name.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(RPI_ROOT);
  expect(files.length).toBeGreaterThan(20);
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    expect(text, path).not.toContain(".humanlayer/tasks");
    expect(text, path).not.toMatch(/\/rpi:/);
  }
});

it("keeps Matt Pocock's tdd under another name so pstack's tdd stays", () => {
  const names = readdirSync(resolve(RPI_ROOT, "skills"));
  expect(names).toContain("rpi-tdd");
  expect(names).not.toContain("tdd");
  const text = readFileSync(resolve(RPI_ROOT, "skills", "rpi-tdd", "SKILL.md"), "utf8");
  expect(text).toContain("name: rpi-tdd");
  expect(text).toContain("TDD is the red → green loop.");
  expect(existsSync(resolve(RPI_ROOT, "skills", "rpi-tdd", "tests.md"))).toBe(true);
  expect(existsSync(resolve(RPI_ROOT, "skills", "rpi-tdd", "mocking.md"))).toBe(true);
});
