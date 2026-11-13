import { test } from "node:test";
import assert from "node:assert/strict";
import routes from "../src-tauri/src/pi_routes_extension.js";

function hook() {
  let handler;
  routes({
    on(name, fn) {
      if (name === "tool_call") handler = fn;
    },
    registerProvider() {},
  });
  assert.ok(
    handler,
    "pre-execution guard is registered even without custom routes",
  );
  return handler;
}
test("password-store calls are blocked before execution, ordinary commands remain available", () => {
  const check = hook();
  for (const command of [
    "security find-generic-password -s example",
    "/usr/bin/security -q find-generic-password -s example -w",
    "/usr/bin/security find-internet-password -g",
    "security find-generic-'password' -s example",
    "echo example; security dump-keychain",
  ]) {
    assert.equal(check({ toolName: "bash", input: { command } })?.block, true);
  }
  assert.equal(
    check({ toolName: "bash", input: { command: "npm test" } }),
    undefined,
  );
  assert.equal(
    check({
      toolName: "bash",
      input: { command: "security find-identity -v -p codesigning" },
    }),
    undefined,
  );
  assert.equal(
    check({ toolName: "read", input: { path: "example.ts" } }),
    undefined,
  );
});
