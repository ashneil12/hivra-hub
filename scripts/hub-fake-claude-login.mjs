#!/usr/bin/env node
// A signed-in Claude account for a bench's throwaway HOME, so the worker pool has room.
//
// The benches run a fake Claude (scripts/fake-claude.mjs), so nothing needs a real login to start a turn. But the app
// asks Claude's usage before it admits a worker (src/features/providers/model/accountWaterfall.ts: a provider whose only
// account reads "not signed in" has no room, and every delegate waits). Under a bench's temporary HOME the dev copy's
// Claude config (`$HOME/.monocode-hub-dev/claude-config`, src-tauri/src/instance.rs) holds no credentials, so the Rust
// probe answers "unavailable" and no worker ever starts.
//
// So the bench writes what a signed-in machine with a stale token looks like: a credentials file with an access token
// whose expiry is in the past. The probe treats it as an expired token and answers 401 without any network call
// (src-tauri/src/rate_limits.rs), which the app reads as "the usage is unknown, not absent" — the account has room.
// A fake token never leaves the machine: nothing sends it anywhere.
import fs from "node:fs";
import path from "node:path";

/** Where a dev copy keeps Claude's config for its default account (src-tauri/src/instance.rs, DEV_CLAUDE_CONFIG). */
export const DEV_CLAUDE_CONFIG = ".monocode-hub-dev/claude-config";

/**
 * Write a signed-in-but-expired credentials file into `home`'s dev Claude config and return its path. `now` is the
 * clock to be behind (defaults to the wall clock).
 */
export function signInFakeClaude(home, { now = Date.now() } = {}) {
  const dir = path.join(home, DEV_CLAUDE_CONFIG);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".credentials.json");
  const credentials = {
    claudeAiOauth: {
      accessToken: "sk-ant-oat-fake-bench-token",
      refreshToken: "",
      expiresAt: now - 60_000,
      scopes: [],
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return file;
}
