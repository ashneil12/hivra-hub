// WP-105: installed through vitest.config.ts `setupFiles`, before every web test file.
//
// 1. Network: only loopback may be reached. fetch, node:http, node:https, node:net and node:tls are wrapped
//    here; a call anywhere else throws at the call site, and the test fails again in teardown so a caught
//    error cannot hide it. allowNetworkForThisTest() opts one test out.
// 2. Data folders: the writing calls on node:fs and node:fs/promises refuse the app's real data folders
//    (Application Support/<name containing monocode>, AppData, ~/.hermes, ~/.claude, ~/.codex,
//    ~/.config/monocode*). Reads pass.
// 3. Git: GIT_CEILING_DIRECTORIES includes the temp parent, so git run in a temp folder cannot walk up and
//    find the real checkout.

import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

import { beginTest, endTest, optionsTarget, permit, wrapFetch, wrapFsModule } from "./harnessGuard";

// Git in a temporary folder must stop at the temp parent, never discover this checkout and commit to it.
// A value the caller already set is kept ahead of ours.
{
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = existing ? `${tmpdir()}${path.delimiter}${existing}` : tmpdir();
}

// node:fs is wrapped with vi.mock because a mutation of the module object is not seen by named ESM imports
// of it. The setup file's mock applies to every test file in the run.
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return wrapFsModule(actual);
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return wrapFsModule(actual);
});

/**
 * The network modules are CommonJS built-ins: every import shape (named, namespace, default, bare name)
 * resolves to properties read at call time from the same module object, so replacing the functions on it
 * is enough, and it keeps `http.Server` and the rest untouched.
 */
function guardNetworkModules(): void {
  const require = createRequire(import.meta.url);
  const originalCalls = new Map<string, unknown>();
  const wrapRequest = (via: string) =>
    function guarded(this: unknown, ...args: unknown[]) {
      permit(optionsTarget(args, via));
      return (originalCalls.get(via) as (...a: unknown[]) => unknown).apply(this, args);
    };
  const modules: Array<[string, string[]]> = [
    ["node:http", ["request", "get"]],
    ["node:https", ["request", "get"]],
    ["node:net", ["connect", "createConnection"]],
    ["node:tls", ["connect"]],
  ];
  for (const [id, names] of modules) {
    const mod = require(id) as Record<string, unknown>;
    for (const name of names) {
      const original = mod[name];
      if (typeof original !== "function") continue;
      const via = `${id.replace("node:", "")}.${name}`;
      originalCalls.set(via, original);
      mod[name] = wrapRequest(via);
    }
  }
}

guardNetworkModules();

/** Wrap whatever fetch is present; a test that replaces fetch with vi.stubGlobal still gets the guard back. */
function guardFetch(): void {
  const current = globalThis.fetch;
  if (typeof current !== "function" || (current as { __harnessGuarded?: boolean }).__harnessGuarded) return;
  const guarded = wrapFetch(current.bind(globalThis));
  Object.defineProperty(guarded, "__harnessGuarded", { value: true });
  globalThis.fetch = guarded;
}

guardFetch();

beforeEach(() => {
  beginTest();
  // vi.unstubAllGlobals() after a test puts the runtime's own fetch back; guard it again before the next one.
  guardFetch();
});

afterEach(() => {
  endTest();
});
