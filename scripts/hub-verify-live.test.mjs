// The pieces of scripts/hub-verify-live.mjs that decide a verdict, without launching anything: the fake Claude's
// scenario, the planted failure, the verdict and exit codes, and the config layering. The live walk itself is
// `npm run hub:verify-live` (and `-- --fail-gate`), which leaves evidence/<run>/verdict.json.
import assert from "node:assert/strict";
import { test } from "node:test";

import { pickRule } from "./fake-claude.mjs";
import {
  CONTINUE,
  KICKOFF,
  SUBAGENT_ID,
  WORKER,
  exitCode,
  mergePatch,
  runId,
  scenario,
  verdictOf,
} from "./hub-verify-live.mjs";

const RESUME_NOTE = `Note: MonoCode Hub restarted while this turn was running, and this background work was cut before it finished.\n- subagent: Verify subagent (id ${SUBAGENT_ID})\n\n${CONTINUE}.`;

test("the walk's scenario sends each prompt to the right role", () => {
  const { rules } = scenario({ runId: "r1" });
  const pick = (prompt, tags = [], fired = {}) => pickRule(rules, prompt, tags, fired)?.name ?? null;
  assert.equal(pick(`<soul>…</soul>\n${KICKOFF} run r1`), "lead-kickoff");
  assert.equal(pick(`${KICKOFF} run r1`, [], { "lead-kickoff": 1 }), null, "the kickoff delegates once");
  assert.equal(pick(`${WORKER} run r1: do a small task`), "worker");
  assert.equal(pick(RESUME_NOTE, ["worker"]), "worker-resume");
  assert.equal(pick(RESUME_NOTE, ["lead"]), "lead-resume");
  assert.equal(pick("[MonoCode report] The verify worker finished", ["lead"]), "lead-report");
  // A recovered Lead: a fresh conversation (no tags) whose prompt carries the brief, which quotes the kickoff.
  assert.equal(pick(`Your earlier conversation ... <chat_brief>\nUser: ${KICKOFF}\n</chat_brief>\n\n${CONTINUE}.`), "lead-recovered");
  const kickoff = rules.find((rule) => rule.name === "lead-kickoff");
  assert.equal(kickoff.steps.find((step) => step.app).input.prompt.includes(KICKOFF), false, "the worker's brief can't look like a kickoff");
  const worker = rules.find((rule) => rule.name === "worker");
  assert.ok(worker.steps.some((step) => step.background?.id === SUBAGENT_ID));
});

test("the negative control plants a failure the walk must notice", () => {
  const { rules } = scenario({ runId: "r1", failGate: true });
  assert.equal(rules.some((rule) => rule.name === "worker-resume"), false);
  const worker = rules.find((rule) => rule.name === "worker");
  assert.equal(worker.steps.some((step) => step.background), false);
  // On resume the worker gets no resume step: nothing marks worker-resumed, so that check fails.
  assert.equal(pickRule(rules, RESUME_NOTE, ["worker"], {})?.name ?? null, null);
});

test("a verdict passes only when every check that ran passed, and the exit codes follow", () => {
  assert.equal(verdictOf([{ status: "pass" }, { status: "skipped" }]), "PASS");
  assert.equal(verdictOf([{ status: "pass" }, { status: "fail" }]), "FAIL");
  assert.equal(verdictOf([{ status: "skipped" }]), "FAIL", "nothing ran is not a pass");
  assert.equal(verdictOf([]), "FAIL");
  assert.equal(exitCode("PASS", false), 0);
  assert.equal(exitCode("FAIL", false), 1);
  assert.equal(exitCode("FAIL", true), 1, "the negative control caught its planted failure: non-zero, as required");
  assert.equal(exitCode("PASS", true), 3, "a negative control that passed missed the planted failure");
});

test("configs layer like tauri --config (JSON merge patch) and run ids are safe names", () => {
  assert.deepEqual(
    mergePatch(
      { build: { beforeDevCommand: "a", devUrl: "x" }, bundle: { targets: ["app"] } },
      { identifier: "com.ash.monocode-hub.dev.v", build: { devUrl: "y" }, bundle: null },
    ),
    { build: { beforeDevCommand: "a", devUrl: "y" }, identifier: "com.ash.monocode-hub.dev.v" },
  );
  const id = runId(new Date("2026-10-19T22:05:09.123Z"), true);
  assert.match(id, /^20261019-220509-[0-9a-f]{4}-fail-gate$/);
  assert.match(runId(new Date("2026-10-19T22:05:09Z")), /^[A-Za-z0-9._-]{1,64}$/);
});
