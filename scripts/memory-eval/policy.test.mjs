// Where policy.mjs finds the repo. It takes the folder from its own module URL, and a URL is not a path: a folder
// with a space in its name is `%20` in the URL, and on Windows the URL path starts with a slash before the drive
// letter. `fileURLToPath` undoes both. These tests run the module from a folder with a space in it.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The bundle the eval would get from esbuild, reduced to the exports loadHivra checks for.
const FAKE_BUNDLE = `
export const recallDecision = () => ({});
export const contentWords = () => [];
export const queryTerms = () => [];
export const memoryId = () => "id";
export const RECALL_MAX_LINES = 1;
export const RECALL_MIN_SCORE = 1;
`;

/** A build that records the folder esbuild would resolve the memory modules from, and builds nothing. */
function recordingBuild() {
  const seen = { resolveDir: undefined };
  const build = async (options) => {
    seen.resolveDir = options.stdin.resolveDir;
    return { outputFiles: [{ text: FAKE_BUNDLE }] };
  };
  return { build, seen };
}

test("in the real checkout the memory modules are read from the repo root", async () => {
  const { loadHivra } = await import("./policy.mjs");
  const { build, seen } = recordingBuild();
  await loadHivra(build);
  assert.equal(seen.resolveDir, path.resolve(here, "..", ".."));
});

test("a checkout whose folder name has a space still resolves its own repo root", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "hivra policy "));
  try {
    const repo = path.join(parent, "repo with space");
    const evalDir = path.join(repo, "scripts", "memory-eval");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(path.join(repo, "package.json"), "{}\n");
    cpSync(path.join(here, "policy.mjs"), path.join(evalDir, "policy.mjs"));

    const copy = pathToFileURL(path.join(evalDir, "policy.mjs")).href;
    assert.match(copy, /%20/, "the copy's URL must encode the space, or this test proves nothing");
    const { loadHivra } = await import(copy);
    const { build, seen } = recordingBuild();
    await loadHivra(build);

    // Node resolves a module's URL through symlinks (macOS keeps temp folders under /private), so compare real paths.
    assert.equal(seen.resolveDir, realpathSync(repo));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
