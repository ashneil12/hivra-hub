#!/usr/bin/env node
// PreToolUse hook for a bench chat. Exit 2 denies the call. The allow list and the real home come from
// the arguments, so a permission answer cannot open a path this hook refuses.

import { guardCtxFromEnv, hookDecision } from "./bench-guard.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");

try {
  const parsed = JSON.parse(process.argv[4] ?? "");
  if (!Array.isArray(parsed)) throw new Error("allow list");
} catch {
  process.stderr.write("bench: the allow list could not be read\n");
  process.exit(2);
}

const ctx = guardCtxFromEnv({}, process.argv.slice(2));
ctx.cwd = process.cwd();
const decision = hookDecision(raw, ctx);
if (decision.deny) {
  process.stderr.write(`${decision.reason}\n`);
  process.exit(2);
}
process.exit(0);
