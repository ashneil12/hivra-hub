// The pieces of scripts/hub-verify-live.mjs that decide a verdict, without launching anything: the fake Claude's
// scenario, the planted failure, the verdict and exit codes, and the config layering. The live walk itself is
// `npm run hub:verify-live` (and `-- --fail-gate`), which leaves evidence/<run>/verdict.json.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dig, fillTemplate, pickRule, promptPayload, withLastStarted } from "./fake-claude.mjs";
import {
  ASKER,
  CONTINUE,
  DURABLE_KICKOFF,
  FLOW_API,
  FLOW_ASH,
  FLOW_BRIEF,
  FLOW_KICKOFF,
  FLOW_LEAD_MONO,
  FLOW_UI,
  GOAL_A_WORKER,
  GOAL_B_WORKER,
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
  cleanupOnExit,
  exitCode,
  goalFor,
  mergePatch,
  runId,
  scenario,
  verdictOf,
} from "./hub-verify-live.mjs";
import { ROOT, shortHash } from "./hub-dev.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "hub-verify-live.mjs");

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
  const at = WALK.indexOf("question_routed");
  assert.deepEqual(WALK.slice(at, at + 2), ["question_routed", "cascade_stop"]);
});

test("restart durability: goal workers, the Lead's waiting briefs and the recovered worker each reach their own rule", () => {
  const { rules } = scenario({ runId: "r1" });
  const pick = (prompt, tags = [], fired = {}) => pickRule(rules, prompt, tags, fired)?.name ?? null;
  const context = "<monocode_context>\nReports start with [MonoCode report]; briefs with [MonoCode brief from …].\n</monocode_context>\n\n";
  assert.equal(pick(`${context}${DURABLE_KICKOFF} run r1: start`), "durable-cos-kickoff");
  const cos = rules.find((rule) => rule.name === "durable-cos-kickoff");
  const delegated = cos.steps.filter((step) => step.app === "tasks.delegate").map((step) => step.input);
  const goalA = goalFor(GOAL_A_WORKER, "r1");
  const goalB = goalFor(GOAL_B_WORKER, "r1");
  assert.deepEqual(delegated.slice(0, 2).map((input) => input.goal), [goalA, goalB]);
  assert.equal(goalA, "VERIFY-GOAL-A run r1: the transcript says GOAL-A-DONE");
  // A worker's prompt is the brief agentAppTasks.briefPrompt writes, then "/goal <goal>" right behind it.
  const workerBrief = (input) => `[MonoCode brief from Chief of Staff]\n\n${input.brief}\n\nDone when: ${input.goal}`;
  assert.equal(pick(workerBrief(delegated[0])), "durable-goal-a");
  assert.equal(pick(`/goal ${goalA}`, ["goal-a"]), "durable-goal-a-set");
  assert.equal(pick(`/goal ${goalA}`, ["goal-a"], { "durable-goal-a-set": 1 }), "durable-goal-a-again", "a second /goal in A's conversation is counted");
  assert.equal(pick(`${CONTINUE}.`, ["goal-a"]), "durable-goal-a-resume");
  const queuedA = cos.steps.find((step) => step.app === "sessions.send").input;
  assert.equal(pick(queuedA.prompt, ["goal-a"]), "durable-queued-a");
  assert.equal(pick(workerBrief(delegated[1])), "durable-goal-b");
  assert.equal(pick(`/goal ${goalB}`, ["goal-b"]), "durable-goal-b-set");
  // B after its transcript was lost: a fresh conversation (no tags) from its chat's brief, then its /goal once more.
  const recovered = `Your earlier conversation ... <chat_brief>\n## Session so far\nUser: [MonoCode brief from Chief of Staff] ${delegated[1].brief}\n</chat_brief>\n\n${CONTINUE}.`;
  assert.equal(pick(recovered), "durable-goal-b-recovered");
  assert.equal(pick(`/goal ${goalB}`, ["goal-b"], { "durable-goal-b-set": 1 }), "durable-goal-b-reset");
  // The first walk's recovered Lead still reaches its own rule.
  assert.equal(pick(`Your earlier conversation ... <chat_brief>\nUser: ${KICKOFF}\n</chat_brief>\n\n${CONTINUE}.`), "lead-recovered");
  // The Verify lead's briefs: 1 holds it busy, 2 and 3 wait behind it; a waiting brief is never taken for its resume.
  const leadBriefs = delegated
    .filter((input) => input.lead === TREE_LEAD)
    .map((input) => `${context}[MonoCode brief from Chief of Staff]\n\n${input.brief}\n\nHow: you are this project's Lead.`);
  assert.equal(leadBriefs.length, 3);
  assert.equal(pick(leadBriefs[0], ["tree-lead"]), "durable-lead-1");
  assert.equal(pick(leadBriefs[1], ["tree-lead", "durable-lead"]), "durable-lead-2");
  assert.equal(pick(leadBriefs[2], ["tree-lead", "durable-lead"]), "durable-lead-3");
  assert.equal(pick(`${context}${CONTINUE}.`, ["tree-lead", "durable-lead"]), "durable-lead-resume");
  // Brief 2 is cancelled by its task id while it waits.
  assert.equal(cos.steps.find((step) => step.app === "tasks.cancel").input.taskId, "{{saved.lead-2.response.result.taskId}}");
  // None of the earlier phases' prompts reach the new rules.
  for (const prompt of [`${KICKOFF} run r1`, `${WORKER} run r1`, `${QUEUED} run r1`, `${TREE_KICKOFF} run r1`])
    assert.equal(pick(prompt)?.startsWith("durable") ?? false, false, prompt);
  const durable = WALK.indexOf("goal_survives_restart");
  assert.deepEqual(WALK.slice(durable, durable + 4), ["goal_survives_restart", "queued_brief_after_restart", "cancelled_brief_stays_out", "nothing_repeats_after_restart"]);
});

test("coding with a Lead: Ash's messages, the workers' reports and the report request each reach their own rule", () => {
  const { rules } = scenario({ runId: "r1" });
  const pick = (prompt, tags = [], fired = {}) => pickRule(rules, prompt, tags, fired)?.name ?? null;
  const context = "<monocode_context>\nReports start with [MonoCode report]; briefs with [MonoCode brief from …].\n</monocode_context>\n\n";
  // Chief of Staff's conversation still carries the earlier phases' tags: the flow's rules come first.
  const cosTags = ["tree-cos", "durable-cos", "flow-cos"];
  assert.equal(pick(`${context}${FLOW_KICKOFF} run r1: brief`, ["tree-cos", "durable-cos"]), "flow-cos-kickoff");
  const cos = rules.find((rule) => rule.name === "flow-cos-kickoff");
  const leadBrief = cos.steps.find((step) => step.app === "tasks.delegate").input;
  assert.equal(leadBrief.lead, TREE_LEAD);
  const report = (result) => `${context}[MonoCode report] MonoCode completion notification: a session you are monitoring has now stopped.\n\n${JSON.stringify({ result })}`;
  assert.equal(pick(report("FLOW-REPORT run r1: shipped"), cosTags), "flow-cos-report");
  assert.equal(pick(report("Both are back. Writing the final report."), cosTags), "flow-cos-other-report", "a cut-off report is caught, not taken for the full one");
  // The Verify lead: its brief, then its workers' reports, Ash's messages (steered or not) and the report request.
  const leadTags = ["tree-lead", "durable-lead", "flow-lead"];
  assert.equal(pick(`${context}[MonoCode brief from Chief of Staff]\n\n${leadBrief.brief}`, ["tree-lead", "durable-lead"]), "flow-lead-brief");
  const lead = rules.find((rule) => rule.name === "flow-lead-brief");
  const [api, ui] = lead.steps.filter((step) => step.app === "tasks.delegate").map((step) => step.input);
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${api.brief}`), "flow-api");
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${ui.brief}`), "flow-ui");
  assert.ok(api.brief.startsWith(FLOW_API) && ui.brief.startsWith(FLOW_UI) && leadBrief.brief.startsWith(FLOW_BRIEF));
  assert.equal(pick(report("FLOW-API-DONE run r1"), leadTags), "flow-lead-api-report");
  assert.equal(pick(report("FLOW-UI-DONE run r1"), leadTags), "flow-lead-ui-report");
  assert.equal(pick(`${context}[MonoCode report request] MonoCode notification: you have finished the brief`, leadTags), "flow-lead-report-request");
  // Ash's messages: a new turn (with the context) or steered into a running one (bare).
  assert.equal(pick(`${context}${FLOW_ASH(1)} run r1: how is it going?`, leadTags), "flow-ash-1");
  assert.equal(pick(`${FLOW_ASH(2)} run r1: is the UI done?`, leadTags), "flow-ash-2");
  assert.equal(pick(`${FLOW_ASH(3)} run r1: anything for me?`, leadTags), "flow-ash-3");
  // The turns Ash steers into take his message inside the turn, the way Claude Code does at a tool boundary.
  for (const name of ["flow-lead-api-report", "flow-lead-ui-report"]) assert.equal(rules.find((rule) => rule.name === name).steerable, true);
  assert.equal(FLOW_LEAD_MONO, "verify-lead");
  // None of the earlier phases' prompts reach the flow's rules.
  for (const prompt of [`${KICKOFF} run r1`, `${WORKER} run r1`, `${TREE_KICKOFF} run r1`, `${DURABLE_KICKOFF} run r1`, report("WORKER-DONE")])
    assert.equal(pick(prompt, ["lead", "tree-lead", "durable-lead"])?.startsWith("flow") ?? false, false, prompt);
  assert.deepEqual(WALK.slice(-5), ["still_running_noted", "lead_chats_while_workers_run", "reports_per_worker", "ash_first_over_report", "leadership_report_complete"]);
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

// ---- cleanup (SH-6) and the slot registry (SH-7) ---------------------------------------------------------------------------

/** A fresh folder that stands in for Ash's real HOME, a TMPDIR to watch, and a way to put the worktree back as it was. */
function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-live-test-")));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  const evidence = path.join(ROOT, "evidence");
  const before = new Set(fs.existsSync(evidence) ? fs.readdirSync(evidence) : []);
  t.after(() => {
    for (const name of fs.existsSync(evidence) ? fs.readdirSync(evidence) : [])
      if (!before.has(name)) fs.rmSync(path.join(evidence, name), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { home, tmp };
}

function verifyLive(box, args) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: box.home, TMPDIR: box.tmp },
    encoding: "utf8",
    timeout: 120_000,
  });
}

test("SH-6: a run that fails while setting up still removes its temporary HOME", (t) => {
  const box = sandbox(t);
  // Both the slot's name and its hashed fallback belong to other worktrees that exist: planSlot refuses.
  const base = `verify-clash-${process.pid}`;
  fs.mkdirSync(path.join(box.home, ".monocode-hub-dev"), { recursive: true });
  fs.writeFileSync(
    path.join(box.home, ".monocode-hub-dev/slots.json"),
    JSON.stringify({ version: 1, slots: { [base]: { worktree: "/" }, [`${base}-${shortHash(fs.realpathSync(ROOT))}`]: { worktree: "/" } } }),
  );
  const result = verifyLive(box, ["--no-build", "--slot", base]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /belong to other worktrees/);
  assert.deepEqual(fs.readdirSync(box.tmp), [], "the temporary HOME is gone");
});

test("SH-7: the verify slot is never registered in the real home's slots.json", (t) => {
  const box = sandbox(t);
  const slot = `verify-reg-${process.pid}`;
  t.after(() => fs.rmSync(path.join(ROOT, "target/hub-dev", `${slot}.conf.json`), { force: true }));
  // Stops at the copy check (no build here), after the slot is planned and set up.
  const result = verifyLive(box, ["--no-build", "--slot", slot]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const registry = path.join(box.home, ".monocode-hub-dev/slots.json");
  const slots = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, "utf8")).slots : {};
  assert.equal(slots[slot], undefined, "a later plain hub:dev in this worktree can't pick it");
  assert.deepEqual(fs.readdirSync(box.tmp), [], "the temporary HOME is gone");
});

test("SH-6: SIGINT or SIGTERM stops what the run started and removes its temporary folder", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-live-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const program = path.join(root, "run.mjs");
  fs.writeFileSync(
    program,
    `import { spawn } from "node:child_process";
import fs from "node:fs";
import { cleanupOnExit } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const scratch = process.argv[2];
fs.mkdirSync(scratch, { recursive: true });
const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
cleanupOnExit(async () => {
  child.kill("SIGTERM");
  fs.rmSync(scratch, { recursive: true, force: true });
});
console.log(child.pid);
setInterval(() => {}, 1000);
`,
  );
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const scratch = path.join(root, `scratch-${signal}`);
    const run = spawn(process.execPath, [program, scratch], { stdio: ["ignore", "pipe", "inherit"] });
    const sleeper = await new Promise((resolve) => run.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    assert.ok(alive(sleeper) && fs.existsSync(scratch));
    const exited = new Promise((resolve) => run.on("exit", (exit) => resolve(exit)));
    run.kill(signal);
    assert.equal(await exited, code, signal);
    assert.equal(fs.existsSync(scratch), false, `${signal}: the temporary folder is gone`);
    const deadline = Date.now() + 5_000;
    while (alive(sleeper) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(sleeper), false, `${signal}: what it started is stopped`);
  }
});
