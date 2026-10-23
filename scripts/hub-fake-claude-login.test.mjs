// The bench's fake Claude login (scripts/hub-fake-claude-login.mjs) is what gives the worker pool room under a
// throwaway HOME: without a credentials file the app reads Claude as "not signed in" and every delegate waits. These
// tests pin the fixture to the shape src-tauri/src/rate_limits.rs actually reads, so a change there that stops the walk
// admitting workers fails here instead of turning the bench green with nothing launched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEV_CLAUDE_CONFIG, signInFakeClaude } from "./hub-fake-claude-login.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-login-"));

test("it writes the credentials where a dev copy's Claude account reads them", () => {
  const home = scratch();
  const file = signInFakeClaude(home);
  assert.equal(file, path.join(home, DEV_CLAUDE_CONFIG, ".credentials.json"));
  // instance.rs's DEV_CLAUDE_CONFIG, and rate_limits.rs's `<config dir>/.credentials.json`.
  assert.equal(DEV_CLAUDE_CONFIG, ".monocode-hub-dev/claude-config");
  assert.ok(fs.existsSync(file), file);
  // The token is a credential: the file is not readable by anyone else.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the file carries a token with an expiry in the past, which the probe answers without a network call", () => {
  const home = scratch();
  const now = 1_760_000_000_000;
  const blob = JSON.parse(fs.readFileSync(signInFakeClaude(home, { now }), "utf8"));
  const oauth = blob.claudeAiOauth;
  // rate_limits.rs: extract_access_token reads claudeAiOauth.accessToken and needs it non-empty…
  assert.equal(typeof oauth.accessToken, "string");
  assert.ok(oauth.accessToken.trim().length > 0);
  // …oauth_expires_at_ms reads claudeAiOauth.expiresAt, and token_expired is true when now >= expiresAt. An expired
  // token is answered 401 (usage_error) with no HTTP request, so the fake token never leaves the machine.
  assert.equal(typeof oauth.expiresAt, "number");
  assert.ok(oauth.expiresAt < now, `${oauth.expiresAt} is not before ${now}`);
});

test("a 401 reads as an account with room, not as one that is not signed in", () => {
  // The app's rule (src/features/providers/model/accountWaterfall.ts): only status "unavailable" has no room. That is
  // exactly the branch the fixture must avoid, and "error" is what an expired token produces.
  const home = scratch();
  const blob = JSON.parse(fs.readFileSync(signInFakeClaude(home), "utf8"));
  const status = blob.claudeAiOauth.accessToken ? "error" : "unavailable";
  assert.equal(status, "error");
  assert.notEqual(status, "unavailable");
});

test("the walk signs the bench's HOME in before it launches the app", () => {
  const src = fs.readFileSync(path.join(here, "hub-verify-live.mjs"), "utf8");
  assert.match(src, /from "\.\/hub-fake-claude-login\.mjs"/);
  const sign = src.indexOf("signInFakeClaude(home)");
  assert.ok(sign > 0, "the walk never signs the throwaway HOME in");
  // Before the app starts: otherwise the first usage probe has already published "unavailable" and every delegate waits.
  const launch = src.indexOf("appEnv");
  assert.ok(launch > 0);
  assert.ok(sign < src.indexOf("spawn(", launch), "the app is launched before the HOME is signed in");
});
