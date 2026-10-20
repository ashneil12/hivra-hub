// The pieces of scripts/hub-verify-live.mjs that decide a verdict, without launching anything: the fake Claude's
// scenario, the planted failure, the verdict and exit codes, and the config layering. The live walk itself is
// `npm run hub:verify-live` (and `-- --fail-gate`), which leaves evidence/<run>/verdict.json.
import assert from "node:assert/strict";
import { test } from "node:test";

import { dig, fillTemplate, pickRule, promptPayload, withLastStarted } from "./fake-claude.mjs";
import {
  ASKER,
  CONTINUE,
  HELPER,
  KICKOFF,
  PICK,
  QUESTION,
  QUEUED,
  SUBAGENT_ID,
  TREE_BRIEF,
  TREE_KICKOFF,
  TREE_LEAD,
  WALK,
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

test("the Lead's second brief goes to the worker it started, once the worker is busy, and matches no worker rule", () => {
  const { rules } = scenario({ runId: "r1" });
  const kickoff = rules.find((rule) => rule.name === "lead-kickoff");
  const at = (pred) => kickoff.steps.findIndex(pred);
  const send = kickoff.steps.find((step) => step.app === "sessions.send");
  assert.ok(at((step) => step.waitFile === "worker-busy") < at((step) => step.app === "sessions.send"));
  assert.ok(at((step) => step.app === "sessions.start") < at((step) => step.waitFile === "worker-busy"));
  assert.deepEqual(withLastStarted(send.input, "app-lead-r9"), {
    sessionId: "app-lead-r9",
    prompt: send.input.prompt,
    notifyOnComplete: true,
  });
  assert.ok(send.input.prompt.startsWith(QUEUED));
  assert.equal(pickRule(rules, send.input.prompt, [], {})?.name ?? null, null);
  assert.equal(withLastStarted({ a: ["{{lastStarted}}"] }, null).a[0], "{{lastStarted}}", "nothing started: left as is");
});

test("double delegation: each prompt reaches its role, and the wakes only as the turn's own message", () => {
  const { rules } = scenario({ runId: "r1" });
  const pick = (prompt, tags = [], fired = {}) => pickRule(rules, prompt, tags, fired)?.name ?? null;
  // A Mono's fresh conversation opens with its context, which quotes the delegate rules' [MonoCode question/report].
  const context = "<monocode_context>\nEach arrives as a [MonoCode question] turn; reports start with [MonoCode report].\n</monocode_context>\n\n";
  assert.equal(pick(`${context}${TREE_KICKOFF} run r1: brief the Verify lead`), "tree-cos-kickoff");
  const cos = rules.find((rule) => rule.name === "tree-cos-kickoff");
  const delegate = cos.steps.find((step) => step.app === "tasks.delegate");
  assert.equal(delegate.input.lead, TREE_LEAD);
  const leadBrief = `${context}[MonoCode brief from Chief of Staff]\n\n${delegate.input.brief}\n\nHow: you are this project's Lead.`;
  assert.equal(pick(leadBrief), "tree-lead-brief");
  assert.equal(pick(leadBrief, ["tree-lead"], { "tree-lead-brief": 1 }), null, "the context's quoted wakes start nothing");
  const lead = rules.find((rule) => rule.name === "tree-lead-brief");
  const askerBrief = lead.steps.find((step) => step.app === "tasks.delegate").input.brief;
  assert.ok(askerBrief.startsWith(ASKER));
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${askerBrief}`), "tree-asker");
  // The asker's report quotes its brief: the Lead's chat takes it as a report, never as the asker.
  const report = `[MonoCode report] MonoCode completion notification\n\n{"originalPrompt":"${askerBrief}"}`;
  assert.equal(pick(report, ["tree-lead"]), "tree-lead-report");
  assert.equal(pick(report, ["tree-lead"], { "tree-lead-report": 1 }), "tree-lead-late-report");
  assert.equal(pick(`${context}${report}`, ["tree-lead"]), "tree-lead-report");
  assert.equal(pick(report, ["lead"]), "lead-report", "the first Lead's report rule is unchanged");
  const helper = rules.find((rule) => rule.name === "tree-lead-report").steps.find((step) => step.app === "tasks.delegate");
  assert.ok(helper.input.brief.startsWith(HELPER));
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${helper.input.brief}`), "tree-helper");
  // The question wake, as delegationQuestions.ts writes it, and the Lead's answer filled from its payload.
  const wake = `[MonoCode question] MonoCode notification: task t-9 is blocked on a question.\n\n${JSON.stringify({
    taskId: "t-9",
    childSessionId: "app-lead-1",
    requestId: 0,
    questions: [{ id: QUESTION, prompt: QUESTION, multiSelect: false, options: [{ id: "Blue", label: "Blue" }, { id: PICK, label: PICK }] }],
  })}`;
  assert.equal(pick(wake, ["tree-lead"]), "tree-lead-question");
  assert.equal(pick(wake, ["tree-cos"]), null, "Chief of Staff has no question rule: it never gets one");
  const answer = rules.find((rule) => rule.name === "tree-lead-question").steps.find((step) => step.app === "tasks.answer");
  const payload = promptPayload(wake);
  assert.deepEqual(fillTemplate(answer.input, (name) => (name.startsWith("prompt.") ? dig(payload, name.slice(7)) : undefined)), {
    taskId: "t-9",
    requestId: 0,
    answers: { [QUESTION]: [PICK] },
  });
  // None of the first walk's prompts reach the new rules.
  for (const prompt of [`${KICKOFF} run r1`, `${WORKER} run r1`, `${QUEUED} run r1`])
    assert.equal(rules.find((rule) => rule.name === pick(prompt))?.name.startsWith("tree") ?? false, false, prompt);
  assert.deepEqual(WALK.slice(-2), ["question_routed", "cascade_stop"]);
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
