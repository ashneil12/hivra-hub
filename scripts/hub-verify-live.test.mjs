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
  RUN_MONO_NAMES,
  onlySkipped,
  parseArgs,
  parseOnly,
  insideScratch,
  teardownLeftovers,
  teardownList,
  ASKER,
  CT_KICKOFF,
  CT_WORKER,
  CONTINUE,
  DURABLE_KICKOFF,
  FLOW_API,
  FLOW_ASH,
  FLOW_BRIEF,
  FLOW_KICKOFF,
  FLOW_LEAD_MONO,
  FLOW_UI,
  ROOM_ASH,
  ROOM_BUSY,
  ROOM_DM,
  ROOM_ID,
  ROOM_SEATS,
  GOAL_A_WORKER,
  GOAL_B_WORKER,
  HELPER,
  KICKOFF,
  MT_KICKOFF,
  MT_LEAD_BRIEF,
  MT_LEAD_WORKER,
  MT_MONO,
  MT_OWN,
  PICK,
  QUESTION,
  QUEUED,
  SUBAGENT_ID,
  TREE_BRIEF,
  TREE_KICKOFF,
  TREE_LEAD,
  WALK,
  liveLineVerdict,
  liveLinesSeen,
  WORKER,
  cleanupOnExit,
  exitCode,
  goalFor,
  mergePatch,
  runId,
  scenario,
  verdictOf,
  WIRING_NOTE,
  wiringScope,
  writeStageVerdict,
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
  const leadBrief = `${context}[MonoCode brief from Chief of Staff]\n\n${SCAFFOLD}${delegate.input.brief}\n\nHow: you are this project's Lead.`;
  assert.equal(pick(leadBrief), "tree-lead-brief");
  assert.equal(pick(leadBrief, ["tree-lead"], { "tree-lead-brief": 1 }), null, "the context's quoted wakes start nothing");
  const lead = rules.find((rule) => rule.name === "tree-lead-brief");
  const askerBrief = lead.steps.find((step) => step.app === "tasks.delegate").input.brief;
  assert.ok(askerBrief.startsWith(ASKER));
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${SCAFFOLD}${askerBrief}`), "tree-asker");
  // The asker's report quotes its brief: the Lead's chat takes it as a report, never as the asker.
  const report = `[MonoCode report] MonoCode completion notification\n\n{"originalPrompt":"${askerBrief}"}`;
  assert.equal(pick(report, ["tree-lead"]), "tree-lead-report");
  assert.equal(pick(report, ["tree-lead"], { "tree-lead-report": 1 }), "tree-lead-late-report");
  assert.equal(pick(`${context}${report}`, ["tree-lead"]), "tree-lead-report");
  assert.equal(pick(report, ["lead"]), "lead-report", "the first Lead's report rule is unchanged");
  const helper = rules.find((rule) => rule.name === "tree-lead-report").steps.find((step) => step.app === "tasks.delegate");
  assert.ok(helper.input.brief.startsWith(HELPER));
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${SCAFFOLD}${helper.input.brief}`), "tree-helper");
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
  assert.deepEqual(WALK.slice(at, at + 3), ["question_routed", "worker_stalled", "cascade_stop"]);
  // The helper goes silent mid-turn (a gate that never opens): the stall the walk waits for.
  const silent = rules.find((rule) => rule.name === "tree-helper");
  assert.deepEqual(silent.steps.at(-1), { waitFile: "never" });
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
  const workerBrief = (input) => `[MonoCode brief from Chief of Staff]\n\n${SCAFFOLD}${input.brief}\n\nDone when: ${input.goal}`;
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
    .map((input) => `${context}[MonoCode brief from Chief of Staff]\n\n${SCAFFOLD}${input.brief}\n\nHow: you are this project's Lead.`);
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
  assert.equal(pick(`${context}[MonoCode brief from Chief of Staff]\n\n${SCAFFOLD}${leadBrief.brief}`, ["tree-lead", "durable-lead"]), "flow-lead-brief");
  const lead = rules.find((rule) => rule.name === "flow-lead-brief");
  const [api, ui] = lead.steps.filter((step) => step.app === "tasks.delegate").map((step) => step.input);
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${SCAFFOLD}${api.brief}`), "flow-api");
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${SCAFFOLD}${ui.brief}`), "flow-ui");
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
  const flowAt = WALK.indexOf("still_running_noted");
  assert.deepEqual(WALK.slice(flowAt, flowAt + 5), ["still_running_noted", "lead_chats_while_workers_run", "reports_per_worker", "ash_first_over_report", "leadership_report_complete"]);
});

test("the room: each Mono's room turn, the busy one's work, its wake and the private message reach their own rule", () => {
  const { rules } = scenario({ runId: "r1" });
  const pick = (prompt, tags = [], fired = {}) => pickRule(rules, prompt, tags, fired)?.name ?? null;
  const context = "<monocode_context>\nReports start with [MonoCode report].\n</monocode_context>\n\n";
  const [host, reviewer, planner, keeper] = ROOM_SEATS;
  // What roomTurns.ts turnPrompt writes: the opening, the task, how its words reach the room, the transcript.
  const turn = (name, task, transcript, viaTool = false) =>
    `[MonoCode room] You are ${name}, in the group chat "Leadership team" (room ${ROOM_ID}) for project "verify".\n\nRoom rules: ... ${task}\n\n${
      viaTool ? `Read anything newer with room_read (room "${ROOM_ID}"), then answer in the room with room_post (room "${ROOM_ID}"), once, and carry on with your work.` : "Your reply is posted to the room for you, under your name."
    }\n<room_conversation>\n${transcript}\n</room_conversation>`;
  const ash1 = `Ash: ${ROOM_ASH(1)}: plan round 1`;
  const round = `${planner}: Round 1 is ready: commit abc1234, 3 tests pass. Still a stand-in: the label. ${reviewer}, please pass or flag.`;
  const flag = `${reviewer}: ${planner}, one flag: the label still says stand-in, and Ash asked for real words.`;
  const retake = `${planner}: Fair, ${reviewer}. The label is fixed in commit def5678. ${reviewer}, please re-check.`;
  const fired = {};
  const step = (prompt, tags = []) => {
    const name = pick(prompt, tags, fired);
    if (name) fired[name] = (fired[name] ?? 0) + 1;
    return name;
  };
  // The plan's own Mono carries every earlier phase's tag: the room's rules still come first.
  const kickerTags = ["tree-cos", "durable-cos", "flow-cos"];
  // roomTurns.ts writes "Ash just wrote" through forUser, which renames the user when the install has no Ash team pack
  // (the bench's throwaway HOME says "The user just wrote"). The rule matches the hosting sentence, so either name works.
  const hosting = (who) => `${who} just wrote. You host this room, so you answer first, now.`;
  assert.equal(step(`${context}${turn(host, hosting("The user"), ash1)}`, kickerTags), "room-host-answer-1");
  assert.equal(pick(`${context}${turn(host, hosting("Ash"), ash1)}`, kickerTags), "room-host-answer-1", "Ash's own install reads the same rule");
  const said1 = `${host}: Heard. ${planner}, post round 1 for review.`;
  assert.equal(step(turn(planner, `${host} addressed you in the message marked >> below.`, `${ash1}\n\n>> ${said1}`)), "room-planner-round");
  assert.equal(step(turn(reviewer, `${planner} addressed you in the message marked >> below.`, `${ash1}\n\n${said1}\n\n>> ${round}`)), "room-reviewer-flag");
  assert.equal(step(turn(planner, `${reviewer} addressed you in the message marked >> below.`, `${ash1}\n\n${said1}\n\n${round}\n\n>> ${flag}`)), "room-planner-retake");
  assert.equal(step(turn(reviewer, `${planner} addressed you in the message marked >> below.`, `${ash1}\n\n${said1}\n\n${round}\n\n${flag}\n\n>> ${retake}`)), "room-reviewer-pass");
  // No digest closes the round: nobody is named after "Pass from me.", so nobody else is asked.
  assert.equal(rules.some((rule) => rule.name === "room-digest"), false);
  // A room turn no rule is for (a chime, on this room's mode) stays quiet instead of posting the fake's "no rule matched".
  assert.equal(step(turn(keeper, `${host} answered Ash. You may add ONE short message`, ash1)), "room-quiet");
  // Exchange 2: the busy Mono's own work, the host's answer (with its private message to the keeper), the busy one's wake.
  assert.equal(step(`${context}${ROOM_BUSY} run r1: work on the label copy.`), "room-planner-busy");
  assert.equal(rules.find((rule) => rule.name === "room-planner-busy").steerable, true);
  const ash2 = `Ash: ${ROOM_ASH(2)}: is the label in?`;
  assert.equal(step(turn(host, hosting("The user"), `${ash1}\n\n${ash2}`), kickerTags), "room-host-answer-2");
  const dm = rules.find((rule) => rule.name === "room-host-answer-2").steps.find((s) => s.app === "monos.message").input;
  assert.equal(dm.to, keeper);
  assert.ok(dm.text.startsWith(ROOM_DM));
  assert.equal(
    step(turn(planner, `${host} addressed you in the message marked >> below.`, `${ash2}\n\n>> ${host}: Heard. ${planner}, is the label in?`)),
    "room-planner-wake",
  );
  // r62: the busy Mono's room session takes the turn and its answer is the post, so no room_post step.
  const wakeSteps = rules.find((rule) => rule.name === "room-planner-wake").steps;
  assert.equal(wakeSteps.some((s) => s.app === "rooms.post"), false);
  assert.ok(wakeSteps.some((s) => s.say === "The label is in. Pass from me."));
  assert.equal(step(`${context}[MonoCode message from ${host}]\n<message from="${host}">\n${dm.text}\n</message>`), "room-keeper-dm");
  // None of the earlier phases' prompts reach the room's rules.
  for (const prompt of [`${KICKOFF} run r1`, `${WORKER} run r1`, `${TREE_KICKOFF} run r1`, `${DURABLE_KICKOFF} run r1`, `${FLOW_KICKOFF} run r1`, "[MonoCode report] done"])
    assert.equal(pick(prompt, ["lead", "tree-lead", "durable-lead", "flow-cos"])?.startsWith("room") ?? false, false, prompt);
  const roomAt = WALK.indexOf("room_agents_talk");
  assert.deepEqual(WALK.slice(roomAt, roomAt + 3), ["room_agents_talk", "room_busy_mono_answers", "room_private_message"]);
});

test("the coding team: Ash's new chat, its worker and the report reach their own rules, and nothing else does", () => {
  const { rules } = scenario({ runId: "r1" });
  const fired = {};
  const pick = (prompt, tags = []) => pickRule(rules, prompt, tags, fired)?.name ?? null;
  const context = "<monocode_context>\n<coding_team>...</coding_team>\n<delegate_tools>Reports start with [MonoCode report]; a [MonoCode brief from you] ...</delegate_tools>\n</monocode_context>\n\n";
  // On Claude Code a coding-team chat's message is Ash's own (its note is appended to the system prompt); another engine reads who it is ahead of it.
  assert.equal(pick(`${CT_KICKOFF} run r1: have one worker check the verify widget.`), "ct-kickoff");
  delete fired["ct-kickoff"];
  assert.equal(pick(`${context}${CT_KICKOFF} run r1: have one worker check the verify widget.`), "ct-kickoff");
  const kickoff = rules.find((rule) => rule.name === "ct-kickoff");
  const call = kickoff.steps.find((s) => s.app === "tasks.delegate");
  assert.ok(call.input.brief.startsWith(CT_WORKER));
  assert.equal(call.save, "ct-task");
  // Its worker's brief, signed by the coding team, with its worker rules before the finish line.
  assert.equal(pick(`[MonoCode brief from Verify coding team]\n\n${SCAFFOLD}${CT_WORKER} run r1: check the verify widget.\n\n<worker_rules>\n</worker_rules>`), "ct-worker");
  // Its report comes back to the chat; another chat's report never takes the coding team's rule.
  assert.equal(pick("[MonoCode report] MonoCode completion notification: CT-WORKER-DONE run r1", ["ct-chat"]), "ct-report");
  assert.equal(pick("[MonoCode report] done", ["flow-cos"])?.startsWith("ct") ?? false, false);
  // None of the earlier phases' prompts reach the coding team's rules.
  for (const prompt of [`${KICKOFF} run r1`, `${WORKER} run r1`, `${TREE_KICKOFF} run r1`, `${FLOW_KICKOFF} run r1`, `${ROOM_BUSY} run r1`])
    assert.equal(pick(prompt, ["lead", "tree-lead", "flow-cos"])?.startsWith("ct") ?? false, false, prompt);
  assert.equal(WALK.at(-3), "coding_team_delegates");
});

// Teams, not sub-chats (Ash, 20 Oct): a Mono of Ash's own briefs Verify's coding team and keeps its own work in its own
// team (checks 22 and 23).
test("teams: the new Mono's message, its brief, the Lead's worker, its own worker and both reports reach their own rules", () => {
  const { rules } = scenario({ runId: "r1" });
  const fired = {};
  const pick = (prompt, tags = []) => pickRule(rules, prompt, tags, fired)?.name ?? null;
  const context = "<monocode_context>\n<team_rules>...</team_rules>\n<lead_brief_rules>[MonoCode report] ... [MonoCode brief from you]</lead_brief_rules>\n</monocode_context>\n\n";
  assert.equal(pick(`${context}${MT_KICKOFF} run r1: get it fixed, and find me three good examples.`), "mt-kickoff");
  const kickoff = rules.find((rule) => rule.name === "mt-kickoff");
  const calls = kickoff.steps.filter((step) => step.app === "tasks.delegate");
  // A worker of its own in Verify (refused: the coding team's work), the brief to the Lead, then its own worker (no project).
  assert.deepEqual(calls.map((call) => call.save), ["mt-refused", "mt-brief", "mt-own"]);
  assert.equal(calls[0].input.project, "verify");
  assert.equal(calls[1].input.lead, TREE_LEAD);
  assert.ok(calls[1].input.brief.startsWith(MT_LEAD_BRIEF));
  assert.equal(calls[2].input.project, undefined);
  assert.ok(calls[2].input.brief.startsWith(MT_OWN));
  // The Lead's chat carries every earlier phase's tag: the brief still reaches its own rule.
  const leadTags = ["tree-lead", "durable-lead", "flow-lead"];
  assert.equal(pick(`${context}[MonoCode brief from ${MT_MONO}]\n\n${SCAFFOLD}${calls[1].input.brief}\n\nHow: you are this project's Lead.`, leadTags), "mt-lead-brief");
  const lead = rules.find((rule) => rule.name === "mt-lead-brief");
  assert.ok(lead.steps.find((step) => step.app === "tasks.delegate").input.brief.startsWith(MT_LEAD_WORKER));
  assert.equal(pick(`[MonoCode brief from Verify lead]\n\n${SCAFFOLD}${MT_LEAD_WORKER} run r1: fix the widget copy.\n\n<worker_rules>\n</worker_rules>`), "mt-lead-worker");
  assert.equal(pick(`[MonoCode brief from ${MT_MONO}]\n\n${SCAFFOLD}${calls[2].input.brief}\n\n<worker_rules>\n</worker_rules>`), "mt-own");
  // Its own worker's report reaches the Mono; the Lead's worker's report reaches the Lead (whatever its tags), and the
  // Lead's report (which quotes its worker's) reaches the Mono.
  assert.equal(pick("[MonoCode report] MonoCode completion notification: MT-OWN-DONE run r1", ["mt-mono"]), "mt-mono-own-report");
  assert.equal(pick("[MonoCode report] MonoCode completion notification: MT-LEAD-WORKER-DONE run r1", leadTags), "mt-lead-report");
  assert.equal(pick("[MonoCode report] MT-LEAD-REPORT run r1: fixed; evidence MT-LEAD-WORKER-DONE.", ["mt-mono"]), "mt-mono-lead-report");
  assert.equal(pick("[MonoCode check] anything missed?", ["mt-mono"]), "mt-mono-other");
  // None of the earlier phases' prompts reach these rules.
  for (const prompt of [`${KICKOFF} run r1`, `${WORKER} run r1`, `${TREE_KICKOFF} run r1`, `${FLOW_KICKOFF} run r1`, `${CT_KICKOFF} run r1`])
    assert.equal(pick(prompt, ["lead", "tree-lead", "flow-cos", "ct-chat"])?.startsWith("mt") ?? false, false, prompt);
  assert.deepEqual(WALK.slice(-2), ["mono_briefs_coding_team", "mono_own_team"]);
});

test("restart durability: Chief of Staff's goal workers are its own work, so they name no project (its own team)", () => {
  const { rules } = scenario({ runId: "r1" });
  const cos = rules.find((rule) => rule.name === "durable-cos-kickoff");
  const workers = cos.steps.filter((step) => step.app === "tasks.delegate" && !step.input.lead);
  assert.equal(workers.length, 2);
  for (const step of workers) assert.equal(step.input.project, undefined);
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

// Hivra WP-10: every brief comes from the template (src/features/firstmate/model/brief.ts); the spec follows "## Spec".
const SCAFFOLD = "## Isolation check\nYou work in a checkout of your own.\n\n## Intent\nAsh asked for this.\n\n## Spec\n";

test("a verify-live result says it is a wiring check, never a behaviour pass", () => {
  const passed = wiringScope(verdictOf([{ status: "pass" }]));
  assert.equal(passed.scope, "wiring");
  assert.equal(passed.label, "WIRING PASS");
  assert.equal(passed.behaviour, "not tested");
  assert.match(passed.note, /Wiring check only/);
  assert.match(WIRING_NOTE, /hub:realconv/);
  // The run's own source writes it into verdict.json and the log, beside the verdict.
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.match(source, /verdict,\n\s+\.\.\.wiringScope\(verdict\)/);
  assert.match(source, /log\(`WIRING \$\{verdict\}/);
});

test("the verify stage hears this run's verdict, scope included", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-stage-verdict-"));
  const target = path.join(dir, "verdict.json");
  const build = { sha: "abc123", branch: "cos/r54" };
  writeStageVerdict({ verdict: "PASS", run: "run-1", build }, target);
  const passed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(passed.outcome, "passed");
  assert.match(passed.detail, /abc123/);
  assert.match(passed.detail, /Wiring check only/, "a pass keeps its wiring-only scope when the stage quotes it");
  writeStageVerdict({ verdict: "FAIL", run: "run-2", build }, target);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).outcome, "failed");
  // No stage asked: no file, and no error.
  writeStageVerdict({ verdict: "PASS", run: "run-3", build }, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("r59: the teardown lists only what this run made, by id, inside its scratch folder", () => {
  const scratch = "/tmp/monocode-verify-abc";
  const project = `${scratch}/project`;
  assert.deepEqual(RUN_MONO_NAMES, ["Verify Lead", "Verify Marketing"]);
  assert.equal(insideScratch(`${scratch}/home/x`, scratch), true);
  assert.equal(insideScratch("/Users/ash/Projects/monocode-hub", scratch), false);
  assert.equal(insideScratch(`${scratch}-other/project`, scratch), false);
  assert.equal(insideScratch(`/private${scratch}/project-worktrees/mc-1`, [scratch, `/private${scratch}`]), true);
  const windowMonos = [
    { id: "chief-of-staff", name: "Chief of Staff", projects: ["/Users/example/Projects/hivra", project], sessionId: "cos-chat" },
    { id: "lead-uuid", name: "Verify Lead", projects: [project], sessionId: "lead-chat" },
    { id: "verify-lead", name: "Verify lead", projects: [project], sessionId: "flow-lead-chat" },
    { id: "mt-uuid", name: "Verify Marketing", projects: [project], sessionId: "mt-chat" },
    // Same name, another place: not this run's.
    { id: "other-marketing", name: "Verify Marketing", projects: ["/Users/ash/Projects/elsewhere"], sessionId: "x-chat" },
  ];
  const windowSessions = [
    { id: "cos-chat", cwd: project },
    { id: "lead-chat", cwd: project },
    { id: "flow-lead-chat", cwd: project },
    { id: "mt-chat", cwd: `${scratch}/home/monos/mt` },
    { id: "x-chat", cwd: "/Users/ash/Projects/elsewhere" },
    { id: "app-lead-chat-w1", cwd: project },
    { id: "app-app-lead-chat-w1-w2", cwd: project, worktree: `/private${scratch}/project-worktrees/mc-1` },
    // A worktree outside the scratch folder: never touched.
    { id: "app-lead-chat-out", cwd: project, worktree: "/Users/ash/Worktrees/real" },
    { id: "delegated", cwd: project },
    { id: "ct-chat", cwd: project },
    { id: "app-ct-chat-w", cwd: project },
    { id: "ash-real", cwd: "/Users/ash/Projects/monocode-hub" },
    { id: "app-ash-real-w", cwd: "/Users/ash/Projects/monocode-hub" },
    { id: "untouched", cwd: project },
  ];
  const appCalls = [
    { action: "sessions.start", response: { ok: true, result: { id: "app-lead-chat-w1" } } },
    { action: "tasks.delegate", response: { ok: true, result: { childSessionId: "delegated" } } },
    { action: "tasks.delegate", response: { ok: false, error: "nope" } },
    // A message to an existing Mono's chat makes nothing: its session id isn't listed.
    { action: "monos.message", response: { ok: true, result: { sessionId: "cos-chat" } } },
    // Something that claims a chat outside the scratch folder is still not touched.
    { action: "sessions.start", response: { ok: true, result: { id: "ash-real" } } },
  ];
  const list = teardownList({
    appCalls,
    extraSessions: ["ct-chat"],
    monoIds: ["mt-uuid"],
    leadMonoId: "verify-lead",
    windowMonos,
    windowSessions,
    scratch: [scratch, `/private${scratch}`],
    project,
  });
  assert.deepEqual(list.monos, ["lead-uuid", "mt-uuid", "verify-lead"]);
  assert.deepEqual(list.sessions, [
    "app-app-lead-chat-w1-w2",
    "app-ct-chat-w",
    "app-lead-chat-w1",
    "ct-chat",
    "delegated",
    "flow-lead-chat",
    "lead-chat",
    "mt-chat",
  ]);
  for (const kept of ["cos-chat", "x-chat", "ash-real", "app-ash-real-w", "untouched", "app-lead-chat-out"]) assert.ok(!list.sessions.includes(kept), kept);
  assert.ok(!list.monos.includes("chief-of-staff") && !list.monos.includes("other-marketing"));
});

test("r59: a Mono the window no longer has and an empty run list nothing", () => {
  const list = teardownList({ monoIds: ["gone"], leadMonoId: "verify-lead", windowMonos: [], windowSessions: [], scratch: "/tmp/s", project: "/tmp/s/project" });
  assert.deepEqual(list, { sessions: [], monos: [] });
});

test("r59: leftovers are the listed chats not archived and the listed Monos still on the rail", () => {
  const list = { sessions: ["a", "b", "c"], monos: ["m1", "m2"] };
  assert.deepEqual(
    teardownLeftovers(list, { rows: [{ id: "a", archived: 1 }, { id: "b", archived: 0 }, { id: "z", archived: 0 }], windowMonos: [{ id: "m2" }, { id: "chief-of-staff" }] }),
    { sessions: ["b", "c"], monos: ["m2"] },
  );
  assert.deepEqual(teardownLeftovers(list, { rows: list.sessions.map((id) => ({ id, archived: 1 })), windowMonos: [] }), { sessions: [], monos: [] });
});

test("--only picks the checks a person asked for, and refuses anything it cannot run", () => {
  assert.deepEqual(parseOnly(undefined), null, "no flag: every check");
  assert.deepEqual(parseOnly("question_routed"), ["question_routed"]);
  assert.deepEqual(parseOnly(" cascade_stop , question_routed ,,cascade_stop "), ["cascade_stop", "question_routed"], "spaces, blanks and a repeat are tolerated");
  for (const id of ["question_routed", "cascade_stop"]) assert.equal(WALK.includes(id), true);
  assert.throws(() => parseOnly(""), /--only/);
  assert.throws(() => parseOnly(" , ,"), /--only/, "a flag with nothing after it says so");
  assert.throws(() => parseOnly("question_routd"), /question_routd/, "a mistyped id fails loudly instead of running nothing");
  assert.throws(() => parseOnly("question_routed,room_agents_talk,nope"), /nope/);
});

test("--only reaches parseArgs, and leaving it out keeps today's run", () => {
  assert.equal(parseArgs([]).only, null);
  assert.deepEqual(parseArgs(["--only", "question_routed"]).only, ["question_routed"]);
  assert.deepEqual(parseArgs(["--no-build", "--only", "cascade_stop,question_routed"]).only, ["cascade_stop", "question_routed"]);
  assert.throws(() => parseArgs(["--only", "question_routd"]), /question_routd/);
  assert.equal(parseArgs(["--only"]).only, null, "a flag with no value is no filter at all");
  assert.equal(parseArgs([]).scale, 1);
});

test("--only records the checks nobody asked for as skipped, so the verdict only counts what ran", () => {
  const one = ["question_routed"];
  assert.deepEqual(onlySkipped({ id: "question_routed", status: "fail", detail: "x" }, one), null, "an asked-for check keeps its own record");
  assert.equal(onlySkipped({ id: "cascade_stop", status: "pass", detail: "x" }, one)?.status, "skipped");
  assert.equal(onlySkipped({ id: "cascade_stop", status: "pass", detail: "x" }, null), null, "no --only: nothing is skipped");
  assert.equal(onlySkipped({ id: "run", status: "fail", detail: "boom" }, one), null, "a broken run keeps its own verdict, whatever was asked for");
});

test("live_activity_line: passes only on a timed step with the runner right after the timer", () => {
  assert.deepEqual(liveLinesSeen({}), []);
  assert.deepEqual(liveLinesSeen({ "monocode:verify-live-lines": "not json" }), []);
  const pinned = { key: "a", text: "frank · Thinking · 2s", runner: true, runnerAfterText: true, stalled: false };
  assert.equal(liveLineVerdict(liveLinesSeen({ "monocode:verify-live-lines": JSON.stringify([pinned]) })).ok, true);
  assert.equal(liveLineVerdict([{ ...pinned, runner: false, runnerAfterText: false }]).ok, false);
  assert.equal(liveLineVerdict([{ ...pinned, runnerAfterText: false }]).ok, false);
  assert.equal(liveLineVerdict([{ ...pinned, text: "frank is writing…" }]).ok, false);
  assert.equal(liveLineVerdict([{ ...pinned, text: "Reading app.tsx · 1m 20s" }]).ok, true);
  const roomAt = WALK.indexOf("room_private_message");
  assert.equal(WALK[roomAt + 1], "live_activity_line");
});
