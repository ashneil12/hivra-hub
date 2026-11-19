// review/220-r6 repro (red at 3e642192b): round 6 listed the Inbox panel and localHub/decisions.ts because they answer as
// "user", but not the rest of the chain that reaches that "user", nor the second lane that ships code with no pull request.
// A Lead with Merge without asking on merges a change to any of these with no security review, and each one decides
// whether a security-review/<repo>#<number>@<head> answer is the person's:
// - pages/model/pageActions.ts: a Page's agents.answer (and tasks.write op answer) sends {needId, text} to answerNeed;
// - pages/model/bridge.ts, pageBridgeHost.ts: the permission rule and the "Ash just tapped" check in front of it;
// - pages/model/pages.ts keepPage and selfBuild/model/pagesChat.ts keepFromChat: a Mono keeps its page after Ash says
//   anything, and every permission the page asked for (agents.answer included) is approved with it;
// - hub/model/hubStore.ts, liveHubData.ts, localHub/localTransport.ts: the answer call and the transport that wires
//   tauriFirstMate (decisions_answer) under it;
// - src-tauri/src/self_build.rs: protected_area, the only filter on the hub-change lane, which ships with no PR.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { globToRegExp } from "./security-review/review.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const list = JSON.parse(readFileSync(resolve(root, "src/features/leadTick/model/neverMerge.json"), "utf8"));
const gated = (file) => list.securityPaths.some((pattern) => globToRegExp(pattern).test(file));

test("r6: the code between a Page's tap and the person's answer, and the hub-change lane, are security paths", () => {
  const files = [
    "src/features/pages/model/pageActions.ts",
    "src/features/pages/model/bridge.ts",
    "src/features/pages/model/pageBridgeHost.ts",
    "src/features/pages/model/pages.ts",
    "src/features/selfBuild/model/pagesChat.ts",
    "src/features/hub/model/hubStore.ts",
    "src/features/hub/model/liveHubData.ts",
    "src/features/hub/model/localHub/localTransport.ts",
    "src-tauri/src/self_build.rs",
  ];
  assert.deepEqual(files.filter((file) => !gated(file)), [], "not security paths");
});
