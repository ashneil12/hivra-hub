#!/usr/bin/env node
// WIRING CHECK ONLY. A PASS here is never a behaviour result: the agents are a scripted fake (see WIRING_NOTE). Real
// conversations with real models are `npm run hub:realconv` (docs/REALCONV.md).
//
// `npm run hub:verify-live`: the fake-Claude test bench (Phase 1b WP5, docs/PHASE-1B-DEV-SETUP.md, the Phase 1b design notes
// "Fake-Claude test bench with evidence"). It runs this worktree's dev copy of the Hub, with a scripted fake Claude
// (scripts/fake-claude.mjs), under a throwaway HOME, and walks the delegation chain through real restarts:
//
//   1. a Lead (a Mono) delegates a worker with `monocode app sessions.start` (an H2 delegation row);
//   2. the worker runs and leaves a subagent going in the background; the Lead sends it one more brief meanwhile, which
//      queues behind the worker's work (a followed row, "queued" back to the Lead) instead of failing as busy;
//   3. the app is killed mid-turn and started again: the worker resumes by itself with the note naming the subagent;
//   4. the worker's report wakes the Lead;
//   5. the Lead's Claude transcript is deleted while the app is down: it starts fresh from its brief;
//   6. the app is killed under the Lead's turn again and again: it resumes three times, then stops in Needs you.
//   Then double delegation, in one more launch with a second plan: the plan lists a scratch project, so the hub
//   makes that project's Lead, and the kickoff goes to the Coordinator the walk seated (teamPack), which
//   briefs the Lead with `delegate_task {lead}`:
//   7. the Lead's worker asks a question (AskUserQuestion): it reaches the Lead as a [MonoCode question] turn, not
//      the Coordinator and not Ash's Waiting on you; the Lead answers with task_answer and the worker's turn carries on
//      with that answer;
//   8. the Lead delegates another worker for the same brief, which goes silent mid-turn: the window marks its row
//      stalled (quiet) within seconds (the plan's stallMs), and the Coordinator cancels its brief (task_cancel): the
//      worker beneath the Lead is stopped, both rows end cancelled with their reports dropped (the stall with them), and
//      the Lead's own long-running chat is not stopped for it.
//   Then restarts, on a third plan whose fake Claude takes /goal (verify_live.rs `goals`): the Coordinator starts two
//   workers with a finish line (delegate_task `goal`), briefs the Verify lead, queues two more briefs behind the Lead's
//   work and one behind worker A's, and cancels one of the Lead's waiting briefs; the app is killed with all of them
//   busy, and worker B's transcript is deleted meanwhile:
//   9. each /goal survives: A's resumed conversation keeps it (not sent again, its checks go on from the stored count),
//      B's fresh conversation gets it again exactly once; both end met and stay cleared;
//   10. the briefs that waited go in by themselves once their chat's resumed turn is over, each once, in order;
//   11. the brief cancelled while it waited in the busy Lead's queue stays out, and the Lead was never stopped for it;
//   12. one more restart repeats nothing: no brief twice, no /goal again, no goal back.
//   Then coding with a Lead (Ash, 20 Oct: "a good chat and delegate if needed ... and still chat"), on a fourth plan:
//   the Coordinator briefs the Verify lead, which hands the API and the UI to two workers and says it is done, and Ash
//   writes to the Lead through his own path (the plan's messages file, sent by the window as he types):
//   13. the Lead's "done" while both workers run gets one "Still working on" note and the brief stays open;
//   14. Ash's message to the Lead while both workers run is answered within one turn;
//   15. the API worker's report reaches the Lead while the UI still runs, saying "1 of 2 back";
//   16. Ash's message, sent while the UI's report waits in the busy Lead's queue, goes in first: it steers into the
//       running turn and is answered before the report's turn starts;
//   17. Ash steers into the Lead's last turn on the brief, and leadership still gets the Lead's complete report;
//   17b. the Lead asks Ash a question (AskUserQuestion) and he types his answer in its chat, as he would: his words are
//       the question's answer in place, never a message queued behind it (the realtest baseline's Lead sat 20+ min).
//   Then the room (docs/leadership/ROOM.md), in the same launch: Ash writes in the Verify project's Leadership team the
//   way he types there (a room message from the messages file):
//   18. the host answers him first, then the Monos hand off among themselves by naming each other (round, flag,
//       retake, "pass from me") until nobody is named, with no digest; every message is a row in the app database,
//       and each Mono's own chat shows its room turns as quiet lines;
//   19. a Mono busy in its own chat still answers: the room's turn runs in its room session (never steered into that
//       work) and posts in the room, answering the message that woke it;
//   20. a private message between Monos (mono_message) arrives as a hidden turn in the other Mono's own chat, shown as
//       from the sender, and nothing of it reaches the room.
//   Then the coding team (Ash, 20 Oct: "mainly the coding team is the main place i want to talk to"), in the same launch:
//   Ash starts a new chat in the Verify project's coding team, the way he does there:
//   21. that chat (not a Mono) is an orchestrator: its Claude starts with the delegate tool, its first prompt carries
//       who it is, the talk and delegate rules and the project's memory; it delegates a worker, whose chat is
//       `app-<that chat>-<request>` in the project's folder (so the coding team's list nests it under the chat), whose
//       brief is signed by the coding team with its worker rules, and whose report comes back to that chat.
//   Then teams, not sub-chats (Ash, 20 Oct: "monos shouldn't really have sub chats"), in the same launch: Ash makes a
//   Mono of his own on the Verify project (not the built-in team, not a Lead) and asks it for a fix there and for
//   examples for himself. While their workers run, the window is read through the driver (verifyDriver.ts):
//   22. the fix goes to Verify's coding team: a worker of its own in the project is refused, its brief goes to the Lead,
//       whose worker sits under the brief and nests under the Lead in the coding team; the Mono's chat shows one
//       "Briefed Verify coding team" line, the Monos rail lists no sub-chats, and the Lead's report comes back to it;
//   23. its own work goes to its own team: the worker runs in <app data>/mono-teams/<mono id> (its row's project is that
//       folder, no hub project), whose Sessions list pins the Mono's chat with that worker under it (and nothing of
//       Verify's), the rail's line counts it, and its report comes back to the Mono.
//
// Every run leaves evidence/<run>/: verdict.json, the fake's event stream and prompts, each launch's log, and a copy
// of the dev copy's database. `-- --fail-gate` plants a failure (the fake worker leaves no background work and has no
// resume step) and must end FAIL with a non-zero exit, so a green run means something.
//
// Never the daily app or its data: the copy is a dev slot (its identifier is checked against instance.rs's kind
// table), HOME is a temporary folder (the app keeps its data, WebKit storage and Claude config there, and only then
// reads the verify plan: src-tauri/src/verify_live.rs), the hub's projects and Ash's mid-run messages come from the plan (WP-04 retired Ash OS), and
// Claude is the fake. Nothing here reads ~/Library/Application Support/com.ash.monocode-hub, ~/.claude or ~/Applications.
//
//   npm run hub:verify-live                      # build this worktree's verify slot, then walk
//   npm run hub:verify-live -- --fail-gate       # the negative control: must exit non-zero
//   npm run hub:verify-live -- --no-build        # reuse target/debug/monocode from the last run
//   npm run hub:verify-live -- --keep            # leave the temporary HOME for a look afterwards

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEV_IDENTIFIER_PREFIX, kindOf } from "./hub-bundle.mjs";
import { DEV_PRODUCT, ROOT, isMain, planSlot, readJson, registerSlot, writeSlotConfig } from "./hub-dev.mjs";
import { signInFakeClaude } from "./hub-fake-claude-login.mjs";

export const MAX_RESUMES = 3;

/** Every check the walk can record, in order (the negative control records the ones it never reaches as skipped). */
export const WALK = [
  "isolated",
  "lead_delegated",
  "delegation_local",
  "worker_ran",
  "brief_queued",
  "inflight_saved_background",
  "restart_resumed_with_note",
  "report_woke_lead",
  "dead_session_recovered",
  "crash_loop_capped",
  "question_routed",
  "worker_stalled",
  "cascade_stop",
  "goal_survives_restart",
  "queued_brief_after_restart",
  "cancelled_brief_stays_out",
  "nothing_repeats_after_restart",
  "still_running_noted",
  "lead_chats_while_workers_run",
  "reports_per_worker",
  "ash_first_over_report",
  "leadership_report_complete",
  "ash_typed_answer",
  "room_agents_talk",
  "room_busy_mono_answers",
  "room_private_message",
  "live_activity_line",
  "coding_team_delegates",
  "mono_briefs_coding_team",
  "mono_own_team",
];

/** Thrown between phases when the negative control has already caught its failure: no more launches needed. */
class Halt extends Error {}
export const SUBAGENT_ID = "verify-agent-1";
export const KICKOFF = "VERIFY-LEAD-KICKOFF";
export const WORKER = "VERIFY-WORKER";
export const QUEUED = "VERIFY-QUEUED-BRIEF";
export const CONTINUE = "Continue from where you left off";
/**
 * The starter Monos the room speaks as, in rule order: host, reviewer, planner, keeper. WP-05 gives every fresh Mono a
 * new id, so the walk seats these templates (teamPack) and talks to them by the id that came back. The names are the
 * template names (starterOffers, name order's first four: Coordinator, Design review, Planner, Record keeper).
 */
export const ROOM_SEATS = ["Coordinator", "Design review", "Planner", "Record keeper"];
/** Their template ids, same order as ROOM_SEATS, so a seat is picked from teamPack's specId and never from its name. */
export const ROOM_SPEC = ["coordinator", "design-review", "planner", "record-keeper"];
export const TREE_PROJECT = { id: "verify", name: "Verify", shortName: "Verify", iconShape: "rocket" };
export const TREE_LEAD = "verify";
export const TREE_KICKOFF = "VERIFY-TREE-KICKOFF";
export const TREE_BRIEF = "VERIFY-TREE-BRIEF";
export const ASKER = "VERIFY-ASKER";
export const HELPER = "VERIFY-TREE-HELPER";
export const QUESTION = "Which colour should the verify widget be?";
export const PICK = "Green";
/** Restart durability (checks 9 to 12): the third plan's kickoff, two goal workers, the briefs that wait. */
export const DURABLE_KICKOFF = "VERIFY-DURABLE-KICKOFF";
export const GOAL_A_WORKER = "VERIFY-GOAL-A-WORKER";
export const GOAL_B_WORKER = "VERIFY-GOAL-B-WORKER";
export const QUEUED_A = "VERIFY-QUEUED-A";
export const LEAD_BRIEF = (n) => `VERIFY-LEAD-BRIEF-${n}`;
/** Coding with a Lead (checks 13 to 17): the fourth plan's kickoff, the Lead's brief, its two workers, Ash's words. */
export const FLOW_KICKOFF = "VERIFY-FLOW-KICKOFF";
export const FLOW_BRIEF = "VERIFY-FLOW-BRIEF";
export const FLOW_API = "VERIFY-FLOW-API";
export const FLOW_UI = "VERIFY-FLOW-UI";
export const FLOW_ASH = (n) => `VERIFY-FLOW-ASH-${n}`;
/** The Verify lead's Mono id (hubLeads.ts leadSpecFor: `<project id>-lead`): Ash's messages go to its chat. */
export const FLOW_LEAD_MONO = `${TREE_PROJECT.id}-lead`;
/** The room (checks 18 to 20): Ash's messages in the Verify project's Leadership team, the planner's own work, the DM. */
export const ROOM_ID = `${TREE_PROJECT.id}:leadership`;
export const ROOM_ASH = (n) => `VERIFY-ROOM-ASH-${n}`;
export const ROOM_BUSY = "VERIFY-ROOM-BUSY";
export const ROOM_DM = "VERIFY-ROOM-DM";
/** The coding team (check 21): Ash's first message in a new chat there, and its worker's brief. */
export const CT_KICKOFF = "VERIFY-CT-KICKOFF";
export const CT_WORKER = "VERIFY-CT-WORKER";
/**
 * Teams, not sub-chats (checks 22 and 23): a Mono Ash makes on the Verify project, his message to it, its brief to the
 * Verify lead, the Lead's worker for it, and the Mono's own worker (in its own team).
 */
export const MT_MONO = "Verify Marketing";
export const MT_KICKOFF = "VERIFY-MT-KICKOFF";
export const MT_LEAD_BRIEF = "VERIFY-MT-LEAD-BRIEF";
export const MT_LEAD_WORKER = "VERIFY-MT-LEAD-WORKER";
export const MT_OWN = "VERIFY-MT-OWN";
/** A room turn's prompt for one Mono (roomTurns.ts turnPrompt opens with it). */
export const roomTurn = (name) => `(?:^|</monocode_context>\\s*)\\[MonoCode room\\] You are ${name},`;
/** A worker's finish line: what the brief's "Done when" says, and so what MonoCode sends as `/goal`. */
export const goalFor = (worker, runId) => `${worker.replace("-WORKER", "")} run ${runId}: the transcript says ${worker.replace("VERIFY-", "").replace("-WORKER", "")}-DONE`;
/** An app notification as the turn's own message: first in the prompt, or right after the Mono's context block. */
export const said = (prefix) => `(?:^|</monocode_context>\\s*)${prefix}`;

/**
 * A delegated worker's report as the app requires it (A7): a report without the self-review section (workerReview.ts)
 * is bounced and the task never records done. The fake is scripted, so its worker writes that section the way a real
 * one would. Only a `tasks.delegate` worker needs it — a Lead's, a Mono's or a chat's own turn is not review-gated —
 * and never the Lead's own report, which the walk compares word for word.
 */
export const reviewed = (report) =>
  `${report}\n\n## Self-review\nChecked: the work the brief asked for, run end to end\nHow: ran it in the bench project and read the result back\nUnsure: nothing`;

/** The fake Claude's rules for the walk. `failGate` plants the failure the negative control must catch. */
export function scenario({ runId, failGate = false }) {
  const worker = {
    name: "worker",
    match: WORKER,
    setTag: "worker",
    steps: [
      { say: "Working on it." },
      ...(failGate ? [] : [{ background: { id: SUBAGENT_ID, kind: "subagent", description: "Verify subagent" } }]),
      { mark: "worker-started" },
      { waitFile: "worker-release" },
      { say: "WORKER-DONE (first try)" },
    ],
  };
  // Double delegation. Every prompt matches only as the turn's own message (first, or right after a Mono's context
  // block): that context quotes the delegate rules, which name [MonoCode question] and [MonoCode report], and a report
  // quotes its worker's brief.
  // Hivra WP-10: a brief comes from the template (firstmate/model/brief.ts), its spec under "## Spec".
  const brief = (marker) => said(`\\[MonoCode brief from [^\\]]*\\][\\s\\S]*?## Spec\\s+${marker}`);
  const tree = [
    {
      name: "tree-cos-kickoff",
      match: said(TREE_KICKOFF),
      setTag: "tree-cos",
      times: 1,
      steps: [
        { say: "Briefing the Verify lead." },
        {
          app: "tasks.delegate",
          input: {
            lead: TREE_LEAD,
            title: "Verify tree",
            brief: `${TREE_BRIEF} run ${runId}: have one worker pick a colour with you, then another do a long job.`,
          },
          save: "cos-brief",
        },
        { mark: "cos-briefed" },
        // The walk opens this once the Lead's second worker is busy: one cancel at the top of the tree.
        { waitFile: "tree-cancel", timeoutMs: 300_000 },
        {
          app: "tasks.cancel",
          input: { taskId: "{{saved.cos-brief.response.result.taskId}}", reason: "Verify: cancelled from the top." },
          save: "cos-cancel",
        },
        { mark: "cos-cancelled" },
        { say: "Cancelled the Verify lead's brief and everything beneath it." },
      ],
    },
    {
      name: "tree-lead-question",
      tag: "tree-lead",
      match: said("\\[MonoCode question\\]"),
      steps: [
        { mark: "tree-lead-got-question" },
        { say: "My worker asked; the brief says green." },
        // The walk looks at Ash's Waiting on you while the question is open, then lets the Lead answer.
        { waitFile: "answer-go", timeoutMs: 120_000 },
        {
          app: "tasks.answer",
          input: {
            taskId: "{{prompt.taskId}}",
            requestId: "{{prompt.requestId}}",
            answers: { "{{prompt.questions.0.id}}": ["{{prompt.questions.0.options.1.id}}"] },
          },
          save: "lead-answer",
        },
        { mark: "tree-lead-answered" },
        { say: "Answered it." },
      ],
    },
    {
      name: "tree-lead-report",
      tag: "tree-lead",
      match: said("\\[MonoCode report\\]"),
      times: 1,
      steps: [
        { mark: "tree-lead-got-report" },
        { say: "The asker is done. One more worker for this brief." },
        {
          app: "tasks.delegate",
          input: { title: "Verify helper", brief: `${HELPER} run ${runId}: a long job; keep at it until you are stopped.` },
          save: "helper-task",
        },
        { mark: "tree-lead-delegated-helper" },
        // Still mid-turn when the brief above it is cancelled: the cancel must not stop this chat.
        { waitFile: "lead-hold", timeoutMs: 300_000 },
        { mark: "tree-lead-carried-on" },
        { say: "LEAD-CARRIED-ON" },
      ],
    },
    { name: "tree-lead-late-report", tag: "tree-lead", match: said("\\[MonoCode report\\]"), steps: [{ mark: "tree-lead-late-report" }, { say: "Noted." }] },
    {
      name: "tree-lead-brief",
      match: brief(TREE_BRIEF),
      setTag: "tree-lead",
      times: 1,
      steps: [
        { say: "Start-ack: handing the colour question to a worker." },
        {
          app: "tasks.delegate",
          input: { title: "Verify asker", brief: `${ASKER} run ${runId}: ask me which colour to use, then report it.` },
          save: "asker-task",
        },
        { mark: "tree-lead-delegated-asker" },
        { say: "Started the asker." },
      ],
    },
    {
      name: "tree-asker",
      match: brief(ASKER),
      setTag: "asker",
      times: 1,
      steps: [
        { say: "I need one decision from my Lead." },
        { mark: "asker-asking" },
        {
          ask: {
            questions: [
              {
                question: QUESTION,
                header: "Colour",
                multiSelect: false,
                options: [
                  { label: "Blue", description: "The usual" },
                  { label: PICK, description: "What the brief asks for" },
                ],
              },
            ],
            mark: "asker-answered",
          },
        },
        { say: reviewed("ASKER-DONE: going with {{answer}}.") },
      ],
    },
    {
      name: "tree-helper",
      match: brief(HELPER),
      setTag: "helper",
      times: 1,
      steps: [{ say: "On it." }, { mark: "helper-started" }, { waitFile: "never" }],
    },
  ];
  // Restart durability. The goal workers' /goal prompts are exactly "/goal <goal>"; A's conversation survives the
  // restart, B's is deleted while the app is down, so B comes back in a fresh conversation from its chat's brief.
  const goalA = goalFor(GOAL_A_WORKER, runId);
  const goalB = goalFor(GOAL_B_WORKER, runId);
  const goalPrompt = (goal) => `^/goal ${goal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const durable = [
    {
      name: "durable-cos-kickoff",
      match: said(DURABLE_KICKOFF),
      setTag: "durable-cos",
      times: 1,
      steps: [
        { say: "Two workers with a finish line, then briefs for the Verify lead." },
        // Its own work (no project): Verify's work goes to its coding team, so these run in Chief of Staff's own team.
        {
          app: "tasks.delegate",
          input: { title: "Goal A", brief: `${GOAL_A_WORKER} run ${runId}: work until the goal is met.`, goal: goalA },
          save: "goal-a",
        },
        {
          app: "tasks.delegate",
          input: { title: "Goal B", brief: `${GOAL_B_WORKER} run ${runId}: work until the goal is met.`, goal: goalB },
          save: "goal-b",
        },
        { app: "tasks.delegate", input: { lead: TREE_LEAD, title: "Lead brief 1", brief: `${LEAD_BRIEF(1)} run ${runId}: hold on to this one.` }, save: "lead-1" },
        { mark: "durable-started" },
        // The walk opens this once both goals are stored and the Lead is busy on brief 1.
        { waitFile: "durable-queue", timeoutMs: 300_000 },
        { app: "tasks.delegate", input: { lead: TREE_LEAD, title: "Lead brief 2", brief: `${LEAD_BRIEF(2)} run ${runId}: cancelled before it starts.` }, save: "lead-2" },
        { app: "tasks.delegate", input: { lead: TREE_LEAD, title: "Lead brief 3", brief: `${LEAD_BRIEF(3)} run ${runId}: after brief 1.` }, save: "lead-3" },
        {
          app: "sessions.send",
          input: {
            sessionId: "{{saved.goal-a.response.result.childSessionId}}",
            // Chief of Staff works on several projects and its own team: it names the worker's folder.
            project: "{{saved.goal-a.response.result.cwd}}",
            prompt: `${QUEUED_A} run ${runId}: one more thing after your goal.`,
            notifyOnComplete: true,
          },
          save: "queued-a",
        },
        { mark: "durable-queued" },
        { waitFile: "durable-cancel", timeoutMs: 300_000 },
        { app: "tasks.cancel", input: { taskId: "{{saved.lead-2.response.result.taskId}}", reason: "Verify: not needed after all." }, save: "cancel-2" },
        { mark: "durable-cancelled" },
        { say: "Queued what I could; cancelled brief 2." },
      ],
    },
    { name: "durable-cos-report", tag: "durable-cos", match: said("\\[MonoCode report\\]"), steps: [{ say: "Noted." }] },
    // Worker A: the brief's turn, then its /goal turn, which is still going when the app dies.
    { name: "durable-goal-a", match: brief(GOAL_A_WORKER), setTag: "goal-a", times: 1, steps: [{ say: "Starting on A." }] },
    {
      name: "durable-goal-a-set",
      tag: "goal-a",
      match: goalPrompt(goalA),
      times: 1,
      steps: [{ say: "Working toward A." }, { goalCheck: "no GOAL-A-DONE in the transcript yet" }, { mark: "goal-a-set" }, { waitFile: "never" }],
    },
    { name: "durable-queued-a", tag: "goal-a", match: said(QUEUED_A), steps: [{ mark: "queued-a-delivered" }, { say: "QUEUED-A-DONE" }] },
    {
      name: "durable-goal-a-resume",
      tag: "goal-a",
      match: CONTINUE,
      steps: [
        { goalCheck: "still no GOAL-A-DONE" },
        { mark: "goal-a-resumed" },
        { waitFile: "goal-a-finish", timeoutMs: 120_000 },
        { say: "GOAL-A-DONE" },
        { goalMet: true },
      ],
    },
    { name: "durable-goal-a-again", match: goalPrompt(goalA), steps: [{ mark: "goal-a-sent-again" }, { say: "Again?" }] },
    // Worker B: the same, but its transcript is gone after the restart.
    { name: "durable-goal-b", match: brief(GOAL_B_WORKER), setTag: "goal-b", times: 1, steps: [{ say: "Starting on B." }] },
    {
      name: "durable-goal-b-set",
      match: goalPrompt(goalB),
      times: 1,
      steps: [{ say: "Working toward B." }, { goalCheck: "no GOAL-B-DONE in the transcript yet" }, { mark: "goal-b-set" }, { waitFile: "never" }],
    },
    {
      name: "durable-goal-b-recovered",
      match: `<chat_brief>[\\s\\S]*${GOAL_B_WORKER}`,
      setTag: "goal-b",
      steps: [{ mark: "goal-b-recovered" }, { say: "Picking B up again." }],
    },
    {
      name: "durable-goal-b-reset",
      match: goalPrompt(goalB),
      steps: [
        { goalCheck: "nearly: no GOAL-B-DONE yet" },
        { mark: "goal-b-reset" },
        { waitFile: "goal-b-finish", timeoutMs: 120_000 },
        { say: "GOAL-B-DONE" },
        { goalMet: true },
      ],
    },
    // The Verify lead: busy on brief 1 when the app dies; briefs 2 and 3 wait behind it, and 2 is cancelled there.
    {
      name: "durable-lead-1",
      match: brief(LEAD_BRIEF(1)),
      setTag: "durable-lead",
      times: 1,
      steps: [{ say: "Holding brief 1." }, { mark: "durable-lead-busy" }, { waitFile: "never" }],
    },
    { name: "durable-lead-2", match: brief(LEAD_BRIEF(2)), steps: [{ mark: "durable-lead-2-delivered" }, { say: "BRIEF-2-DONE" }] },
    { name: "durable-lead-3", match: brief(LEAD_BRIEF(3)), steps: [{ mark: "durable-lead-3-delivered" }, { say: "BRIEF-3-DONE" }] },
    // Its resume comes last: a brief that waited behind it is a prompt of its own.
    { name: "durable-lead-resume", tag: "durable-lead", match: CONTINUE, steps: [{ mark: "durable-lead-resumed" }, { say: "BRIEF-1-DONE" }] },
  ];
  // Coding with a Lead. First in the list: the Verify lead's and Chief of Staff's conversations still carry the earlier
  // phases' tags, whose catch-all report rules would otherwise take these prompts.
  const reportWith = (marker) => `${said("\\[MonoCode report\\]")}[\\s\\S]*${marker}`;
  const flow = [
    {
      name: "flow-cos-kickoff",
      match: said(FLOW_KICKOFF),
      setTag: "flow-cos",
      times: 1,
      steps: [
        { say: "Briefing the Verify lead on the API and the UI." },
        {
          app: "tasks.delegate",
          input: { lead: TREE_LEAD, title: "Ship the API and the UI", brief: `${FLOW_BRIEF} run ${runId}: ship the API and the UI.` },
          save: "flow-brief",
        },
        { mark: "flow-cos-briefed" },
        { say: "Handed it to the Verify lead." },
      ],
    },
    { name: "flow-cos-report", match: reportWith("FLOW-REPORT"), times: 1, steps: [{ mark: "flow-cos-got-report" }, { say: "Good, noted." }] },
    { name: "flow-cos-other-report", tag: "flow-cos", match: said("\\[MonoCode report\\]"), steps: [{ mark: "flow-cos-got-other-report" }, { say: "Noted." }] },
    {
      name: "flow-lead-brief",
      match: brief(FLOW_BRIEF),
      setTag: "flow-lead",
      times: 1,
      steps: [
        { say: "Start-ack: the API and the UI go to two workers." },
        { app: "tasks.delegate", input: { title: "Flow API", brief: `${FLOW_API} run ${runId}: build the API.` }, save: "flow-api-task" },
        { app: "tasks.delegate", input: { title: "Flow UI", brief: `${FLOW_UI} run ${runId}: build the UI.` }, save: "flow-ui-task" },
        { mark: "flow-lead-delegated" },
        // Says it's done while both still run: the app notes "Still working on" both names and the brief stays open.
        { say: "Done: the API and the UI are handed off." },
      ],
    },
    {
      name: "flow-api",
      match: brief(FLOW_API),
      setTag: "flow-api",
      times: 1,
      steps: [{ say: "On the API." }, { mark: "flow-api-started" }, { waitFile: "flow-api-go", timeoutMs: 900_000 }, { say: reviewed(`FLOW-API-DONE run ${runId}`) }],
    },
    {
      name: "flow-ui",
      match: brief(FLOW_UI),
      setTag: "flow-ui",
      times: 1,
      steps: [{ say: "On the UI." }, { mark: "flow-ui-started" }, { waitFile: "flow-ui-go", timeoutMs: 900_000 }, { say: reviewed(`FLOW-UI-DONE run ${runId}`) }],
    },
    {
      name: "flow-ash-1",
      match: said(FLOW_ASH(1)),
      times: 1,
      steps: [{ mark: "flow-ash-1-answered" }, { say: "ASH-1-ANSWER: the API and the UI are both being built; you'll hear as each lands." }],
    },
    // The API's report: the Lead holds this turn open (steerable, so Ash's next message joins it, as with Claude Code).
    {
      name: "flow-lead-api-report",
      tag: "flow-lead",
      match: reportWith("FLOW-API-DONE"),
      times: 1,
      steerable: true,
      steps: [
        { mark: "flow-lead-got-api" },
        { say: "The API is back (1 of 2); the UI is still running." },
        { waitFile: "flow-lead-hold", timeoutMs: 900_000 },
        { say: "Back to waiting on the UI." },
      ],
    },
    {
      name: "flow-ash-2",
      match: said(FLOW_ASH(2)),
      times: 1,
      steps: [{ mark: "flow-ash-2-answered" }, { say: "ASH-2-ANSWER: the UI just finished; its report is next." }],
    },
    // The UI's report: the Lead's last turn on the brief, which Ash steers into before its final words.
    {
      name: "flow-lead-ui-report",
      tag: "flow-lead",
      match: reportWith("FLOW-UI-DONE"),
      times: 1,
      steerable: true,
      steps: [
        { mark: "flow-lead-got-ui" },
        { say: "Both are back. Writing the final report." },
        { waitFile: "flow-final-hold", timeoutMs: 900_000 },
        { say: `FLOW-FINAL run ${runId}: the API and the UI are shipped.` },
      ],
    },
    { name: "flow-ash-3", match: said(FLOW_ASH(3)), times: 1, steps: [{ mark: "flow-ash-3-answered" }, { say: "ASH-3-ANSWER: nothing needs you." }] },
    // 17b. The Lead asks Ash; his typed words must come back as the question's answer, not as a message of their own.
    {
      name: "flow-ash-4",
      match: said(FLOW_ASH(4)),
      times: 1,
      steps: [
        { say: "One question first." },
        { mark: "flow-lead-asks" },
        {
          ask: {
            questions: [
              {
                question: "Which colour should the badge be?",
                header: "Badge",
                multiSelect: false,
                options: [{ label: "Teal (Recommended)" }, { label: "Grey" }],
              },
            ],
            mark: "flow-ask-answered",
          },
        },
        { say: "ASH-4-ANSWER: going with {{answer}}." },
      ],
    },
    { name: "flow-ash-5", match: said(FLOW_ASH(5)), times: 1, steps: [{ mark: "flow-ash-5-as-message" }, { say: "That came in as a message." }] },
    {
      name: "flow-lead-report-request",
      tag: "flow-lead",
      match: said("\\[MonoCode report request\\]"),
      times: 1,
      steps: [
        { mark: "flow-lead-asked-report" },
        { say: `FLOW-REPORT run ${runId}: the API and the UI are shipped; evidence FLOW-API-DONE and FLOW-UI-DONE; nothing open.` },
      ],
    },
  ];
  // The room. First of all: a room turn's prompt quotes the room's transcript, so only its own opening may match, and
  // the last rule keeps any other room turn quiet (a room prompt no rule matched would otherwise be posted).
  // Never match the user's name: roomTurns.ts writes "Ash just wrote" through forUser, which renames the user on an
  // install without his team, so under the bench's throwaway HOME it reads "The user just wrote". The hosting sentence
  // after it is a plain literal and survives either way.
  // answer-2 before answer-1: a later transcript still contains the first message, and times: 1 keeps a spent rule from taking it.
  const [hostName, reviewerName, plannerName, keeperName] = ROOM_SEATS;
  const room = [
    {
      name: "room-host-answer-2",
      match: `${roomTurn(hostName)}[\\s\\S]*host this room, so you answer first[\\s\\S]*${ROOM_ASH(2)}`,
      times: 1,
      steps: [
        { app: "monos.message", input: { to: keeperName, text: `${ROOM_DM} run ${runId}: keep the label rule in mind.` }, save: "room-dm" },
        { mark: "room-host-answered-2" },
        { say: `Heard. ${plannerName}, is the label in?` },
      ],
    },
    {
      name: "room-host-answer-1",
      match: `${roomTurn(hostName)}[\\s\\S]*host this room, so you answer first[\\s\\S]*${ROOM_ASH(1)}`,
      times: 1,
      steps: [{ mark: "room-host-answered" }, { say: `Heard. ${plannerName}, post round 1 for review.` }],
    },
    {
      name: "room-planner-round",
      match: `${roomTurn(plannerName)}[\\s\\S]*${hostName} addressed you`,
      times: 1,
      steps: [{ say: `Round 1 is ready: commit abc1234, 3 tests pass. Still a stand-in: the label. ${reviewerName}, please pass or flag.` }],
    },
    {
      name: "room-reviewer-flag",
      match: `${roomTurn(reviewerName)}[\\s\\S]*${plannerName} addressed you[\\s\\S]*>> ${plannerName}: Round 1`,
      times: 1,
      steps: [{ say: `${plannerName}, one flag: the label still says stand-in, and Ash asked for real words.` }],
    },
    {
      name: "room-planner-retake",
      match: `${roomTurn(plannerName)}[\\s\\S]*${reviewerName} addressed you`,
      times: 1,
      steps: [{ say: `Fair, ${reviewerName}. The label is fixed in commit def5678. ${reviewerName}, please re-check.` }],
    },
    { name: "room-reviewer-pass", match: `${roomTurn(reviewerName)}[\\s\\S]*>> ${plannerName}: Fair, ${reviewerName}`, times: 1, steps: [{ mark: "room-pass" }, { say: "Pass from me." }] },
    // The planner, busy in its own chat: the room's turn runs in the planner's room session, not in that work, and posts.
    {
      name: "room-planner-busy",
      match: said(ROOM_BUSY),
      times: 1,
      steerable: true,
      steps: [{ say: "On the label copy." }, { mark: "room-planner-busy" }, { waitFile: "room-planner-release", timeoutMs: 600_000 }, { say: "Label copy done." }],
    },
    {
      name: "room-planner-wake",
      match: `${roomTurn(plannerName)}[\\s\\S]*${hostName} addressed you[\\s\\S]*${ROOM_ASH(2)}`,
      times: 1,
      // A short think first, so the room's live line (step, timer, the planner's MonoCode after it) is on screen to be seen.
      steps: [{ mark: "room-planner-posted" }, { sleep: 2500 }, { say: "The label is in. Pass from me." }],
    },
    { name: "room-keeper-dm", match: said(`\\[MonoCode message from ${hostName}\\]`), times: 1, steps: [{ mark: "room-keeper-dm" }, { say: "NO_REPLY" }] },
    { name: "room-quiet", match: said("\\[MonoCode room\\]"), steps: [{ say: "NO_REPLY" }] },
  ];
  // The coding team: a plain chat in the Verify project's folder, an orchestrator like the Lead.
  const team = [
    {
      name: "ct-kickoff",
      match: said(CT_KICKOFF),
      setTag: "ct-chat",
      times: 1,
      steps: [
        { say: "Got it: one worker checks the verify widget while we talk." },
        { app: "tasks.delegate", input: { title: "Coding team check", brief: `${CT_WORKER} run ${runId}: check the verify widget.` }, save: "ct-task" },
        { mark: "ct-delegated" },
        { say: "Started it; I'll tell you what it finds." },
      ],
    },
    {
      name: "ct-worker",
      match: brief(CT_WORKER),
      setTag: "ct-worker",
      times: 1,
      steps: [{ mark: "ct-worker-started" }, { say: reviewed(`CT-WORKER-DONE run ${runId}: the widget is fine.`) }],
    },
    {
      name: "ct-report",
      tag: "ct-chat",
      match: `${said("\\[MonoCode report\\]")}[\\s\\S]*CT-WORKER-DONE`,
      times: 1,
      steps: [{ mark: "ct-got-report" }, { say: "The check is back: the widget is fine." }],
    },
  ];
  // Teams, not sub-chats: a Mono of Ash's own. First of all: the Verify lead's conversation carries earlier tags whose
  // catch-all rules would otherwise take its prompts.
  const monoTeams = [
    {
      name: "mt-kickoff",
      match: said(MT_KICKOFF),
      setTag: "mt-mono",
      times: 1,
      steps: [
        { say: "Got it: the copy fix goes to the Verify coding team, the examples are mine." },
        // A worker of its own in a project with a coding team is refused: that work is the coding team's.
        { app: "tasks.delegate", input: { title: "Fix the widget copy", project: TREE_PROJECT.id, brief: `${MT_LEAD_WORKER} run ${runId}: fix it here.` }, save: "mt-refused" },
        { app: "tasks.delegate", input: { lead: TREE_LEAD, title: "Fix the widget copy", brief: `${MT_LEAD_BRIEF} run ${runId}: the verify widget's copy is wrong; fix it.` }, save: "mt-brief" },
        { app: "tasks.delegate", input: { title: "Find copy examples", brief: `${MT_OWN} run ${runId}: find three good examples of widget copy.` }, save: "mt-own" },
        { mark: "mt-delegated" },
        { say: "Briefed the Verify coding team on the fix; my own worker is finding examples in my team." },
      ],
    },
    {
      name: "mt-lead-brief",
      match: brief(MT_LEAD_BRIEF),
      times: 1,
      steps: [
        { say: "Start-ack: one worker on the widget copy." },
        { app: "tasks.delegate", input: { title: "Widget copy", brief: `${MT_LEAD_WORKER} run ${runId}: fix the widget copy.` }, save: "mt-lead-task" },
        { mark: "mt-lead-delegated" },
        { say: "Handed the copy to a worker." },
      ],
    },
    {
      name: "mt-lead-worker",
      match: brief(MT_LEAD_WORKER),
      times: 1,
      steps: [{ mark: "mt-lead-worker-started" }, { waitFile: "mt-lead-worker-go", timeoutMs: 900_000 }, { say: reviewed(`MT-LEAD-WORKER-DONE run ${runId}: copy fixed.`) }],
    },
    {
      name: "mt-lead-report",
      // The Lead's turn on its worker's report; the Mono's report from the Lead quotes it, so never in the Mono's chat.
      match: reportWith("MT-LEAD-WORKER-DONE"),
      notTag: "mt-mono",
      times: 1,
      steps: [{ mark: "mt-lead-got-worker" }, { say: `MT-LEAD-REPORT run ${runId}: the widget copy is fixed; evidence MT-LEAD-WORKER-DONE.` }],
    },
    {
      name: "mt-own",
      match: brief(MT_OWN),
      times: 1,
      steps: [{ mark: "mt-own-started" }, { waitFile: "mt-own-go", timeoutMs: 900_000 }, { say: reviewed(`MT-OWN-DONE run ${runId}: three examples found.`) }],
    },
    { name: "mt-mono-own-report", tag: "mt-mono", match: reportWith("MT-OWN-DONE"), times: 1, steps: [{ mark: "mt-got-own-report" }, { say: "The examples are back." }] },
    { name: "mt-mono-lead-report", tag: "mt-mono", match: reportWith("MT-LEAD-REPORT"), times: 1, steps: [{ mark: "mt-got-lead-report" }, { say: "The copy is fixed, noted." }] },
    { name: "mt-mono-other", tag: "mt-mono", match: said("\\[MonoCode "), steps: [{ say: "Noted." }] },
  ];
  const rules = [
    ...monoTeams,
    ...team,
    ...room,
    ...flow,
    ...durable,
    ...tree,
    // The Lead after its transcript was lost: a fresh conversation whose first prompt carries the chat's brief. Its own
    // tag, so a resume here (phase 6 kills it again and again) is told apart from a resumed kickoff (phase 4 above).
    { name: "lead-recovered", match: "<chat_brief>", setTag: "lead-lost", steps: [{ mark: "lead-recovered" }, { waitFile: "never" }] },
    // A resume of the recovered turn stays in flight: phase 6 has to cut it under way, resume after resume, to see the cap.
    { name: "lead-lost-resume", tag: "lead-lost", match: CONTINUE, steps: [{ mark: "lead-lost-resumed" }, { waitFile: "never" }] },
    ...(failGate
      ? []
      : [
          {
            name: "worker-resume",
            tag: "worker",
            match: CONTINUE,
            steps: [{ mark: "worker-resumed" }, { say: "WORKER-DONE" }],
          },
        ]),
    // The kickoff turn can be cut before its last step and after the worker's brief went out (the kill lands between
    // `lead-queued` and the Lead's final line). The resumed turn finishes the kickoff and ends, so the worker's report
    // queued behind it is flushed into a turn of its own; hanging here would wedge the very report phase 4 waits for.
    { name: "lead-resume", tag: "lead", match: CONTINUE, steps: [{ mark: "lead-resumed" }, { say: "Started it." }] },
    {
      name: "lead-report",
      tag: "lead",
      match: "\\[MonoCode report\\]",
      steps: [{ mark: "lead-got-report" }, { say: "Got the report. Checking it." }, { waitFile: "never" }],
    },
    worker,
    {
      name: "lead-kickoff",
      match: KICKOFF,
      setTag: "lead",
      times: 1,
      steps: [
        { say: "Delegating the verify worker." },
        {
          app: "sessions.start",
          input: { prompt: `${WORKER} run ${runId}: do a small task and report back.`, notifyOnComplete: true },
        },
        { mark: "lead-delegated" },
        // Once the worker is mid-turn (the walk opens this gate), one more brief to it: it must queue, not fail.
        { waitFile: "worker-busy", timeoutMs: 180_000 },
        {
          app: "sessions.send",
          input: { sessionId: "{{lastStarted}}", prompt: `${QUEUED} run ${runId}: one more small thing when you're free.`, notifyOnComplete: true },
        },
        { mark: "lead-queued" },
        { say: "Started it." },
      ],
    },
  ];
  return { version: 1, rules: withBriefParts(rules) };
}

/**
 * Hivra WP-10: a delegation names its intent and definition of done, or the app refuses it (firstmate/model/brief.ts).
 * The scripted first mates here send them with every brief; one that names its own goal keeps it.
 */
export function withBriefParts(rules) {
  return rules.map((rule) => ({
    ...rule,
    steps: (rule.steps ?? []).map((step) =>
      step.app === "tasks.delegate"
        ? { ...step, input: { intent: "Ash asked for this in the verify-live walk.", goal: "The worker reports back.", ...step.input } }
        : step,
    ),
  }));
}

/**
 * What a verify-live result is about. The bench's Claude is the scripted fake (fake-claude.mjs): every agent line is a
 * rule's canned text, so a PASS says the hub's plumbing (delegation rows, restarts, queues, routing, goals) works, and
 * nothing about how the agents talk or whether they do the work. Behaviour is `npm run hub:realconv` (docs/REALCONV.md).
 */
export const WIRING_NOTE =
  "Wiring check only: scripted fake Claude, canned replies. A PASS means the plumbing works, not that the agents behave; behaviour is npm run hub:realconv (real models).";

/**
 * Tell the verify stage what this run found, when it asked (src-tauri/src/verify_stage.rs sets MONOCODE_VERIFY_VERDICT
 * and reads the outcome from that file). The detail carries the wiring-only scope, so a pass here can't be quoted as
 * "the agents behave".
 */
export function writeStageVerdict(result, target = process.env.MONOCODE_VERIFY_VERDICT) {
  if (!target) return;
  const body =
    result.verdict === "PASS"
      ? {
          outcome: "passed",
          detail: `Wiring check PASS at ${result.build.sha} (${result.build.branch}): every check that ran passed. ${WIRING_NOTE}`,
        }
      : {
          outcome: "failed",
          detail: `Wiring check FAIL at ${result.build.sha} (${result.build.branch}); the failing checks are in evidence/${result.run}/verdict.json.`,
        };
  fs.writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`);
}

/** The fields every verdict.json carries so it can't be read as a behaviour pass. */
export function wiringScope(verdict) {
  return { scope: "wiring", label: `WIRING ${verdict}`, behaviour: "not tested", note: WIRING_NOTE };
}

/** PASS only when every check that ran passed; skipped checks are reported, never counted. */
export function verdictOf(checks) {
  const ran = checks.filter((check) => check.status !== "skipped");
  return ran.length > 0 && ran.every((check) => check.status === "pass") ? "PASS" : "FAIL";
}

/** The exit code: a FAIL is 1; a negative control that came out PASS (the planted failure went unnoticed) is 3. */
export function exitCode(verdict, failGate) {
  if (verdict === "FAIL") return 1;
  return failGate ? 3 : 0;
}

/** RFC 7396 merge, the way `tauri --config a --config b` layers configs into TAURI_CONFIG. */
/** Monos the run itself makes by name (its kickoff's Lead, Ash's own Mono on the Verify project). */
export const RUN_MONO_NAMES = ["Verify Lead", MT_MONO];

/**
 * True when a path is the run's scratch folder or inside it (its temporary HOME, project, worktrees, the Monos'
 * folders there). `scratch` may list the folder under several spellings (macOS's /var is /private/var).
 */
export function insideScratch(file, scratch) {
  if (typeof file !== "string" || !file) return false;
  return [scratch].flat().some((root) => {
    if (typeof root !== "string" || !root) return false;
    const rel = path.relative(root, file);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/**
 * The run's teardown list (r59: verify-live leaves nothing of its own in a sidebar). Only ids this run made:
 * - chats its fake Claude had the app start (sessions.start's id, tasks.delegate's childSessionId in fake/app-calls),
 *   plus the chats it noted itself (`extraSessions`, e.g. the coding-team chat its window kickoff opened);
 * - Monos it made: the Lead for the project it listed (`leadMonoId`), the Monos its kickoffs named (`monoIds`), and any
 *   Mono named in RUN_MONO_NAMES whose only project is this run's scratch project (a fresh mkdtemp path, so its id);
 * - those Monos' chats, and every chat the app made under a listed chat (`app-<owner>-…`).
 * Every chat must be one the database knows whose folder (and worktree, if any) is inside the run's scratch folder;
 * nothing else is listed.
 */
export function teardownList({ appCalls = [], extraSessions = [], monoIds = [], leadMonoId = null, windowMonos = [], windowSessions = [], scratch, project }) {
  const monos = new Set(monoIds.filter(Boolean));
  if (leadMonoId) monos.add(leadMonoId);
  for (const mono of windowMonos) {
    const projects = Array.isArray(mono?.projects) ? mono.projects : [];
    if (RUN_MONO_NAMES.includes(mono?.name) && projects.length === 1 && projects[0] === project) monos.add(mono.id);
  }
  const known = new Map(windowSessions.filter((row) => row?.id).map((row) => [row.id, row]));
  const roster = new Map(windowMonos.filter((mono) => mono?.id).map((mono) => [mono.id, mono]));
  const listedMonos = [...monos].filter((id) => roster.has(id));
  const seeds = new Set(extraSessions.filter(Boolean));
  for (const entry of appCalls) {
    const result = entry?.response?.ok ? entry.response.result : null;
    if (!result || typeof result !== "object") continue;
    if (entry.action === "sessions.start" && typeof result.id === "string") seeds.add(result.id);
    if (entry.action === "tasks.delegate" && typeof result.childSessionId === "string") seeds.add(result.childSessionId);
  }
  for (const id of listedMonos) if (roster.get(id).sessionId) seeds.add(roster.get(id).sessionId);
  // Chats the app made under a listed chat, to any depth.
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of known.keys())
      if (!seeds.has(id) && [...seeds].some((owner) => id.startsWith(`app-${owner}-`))) {
        seeds.add(id);
        grew = true;
      }
  }
  const sessions = [...seeds].filter((id) => {
    const row = known.get(id);
    return !!row && insideScratch(row.cwd, scratch) && (!row.worktree || insideScratch(row.worktree, scratch));
  });
  return { sessions: sessions.sort(), monos: listedMonos.sort() };
}

/** What's left of the teardown list once it ran: chats not archived in the database, Monos still on the rail. */
export function teardownLeftovers(list, { rows = [], windowMonos = [] }) {
  const archived = new Map(rows.map((row) => [row.id, Number(row.archived) === 1]));
  const onRail = new Set(windowMonos.map((mono) => mono?.id));
  return {
    sessions: list.sessions.filter((id) => archived.get(id) !== true),
    monos: list.monos.filter((id) => onRail.has(id)),
  };
}

export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

export function runId(now = new Date(), failGate = false) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}${failGate ? "-fail-gate" : ""}`;
}

/** The lines of an NDJSON file, parsed; [] when it isn't there yet. */
export function readNdjson(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// ---- the run --------------------------------------------------------------------------------------------------------

/**
 * Run `stop` once however the run ends: the caller awaits `finish()` when it returns or throws, and SIGINT/SIGTERM run
 * it too, then exit 130/143. `dispose()` takes the signal handlers off again.
 */
export function cleanupOnExit(stop, { onSignal = () => undefined, exit = (code) => process.exit(code) } = {}) {
  let done = null;
  const finish = () => (done ??= Promise.resolve().then(stop));
  const handlers = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ].map(([signal, code]) => {
    const handler = () => {
      onSignal(signal);
      finish()
        .catch(() => undefined)
        .finally(() => exit(code));
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  return {
    finish,
    dispose: () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function commandOf(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * `--only a,b` narrows the verdict to those checks (the walk still runs; the rest are recorded as skipped). No flag is
 * every check; a mistyped id fails loudly, so a typo can never come out as a green run of nothing.
 */
export function parseOnly(value) {
  if (value === undefined || value === null) return null;
  const ids = String(value).split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`--only needs at least one check id: ${WALK.join(", ")}`);
  const unknown = ids.filter((id) => !WALK.includes(id));
  if (unknown.length) throw new Error(`--only: no such check ${unknown.map((id) => `"${id}"`).join(", ")}. Checks: ${WALK.join(", ")}`);
  return [...new Set(ids)];
}

/** A check nobody asked for is recorded as skipped; the run-wide "run" check keeps its own verdict. */
export function onlySkipped(check, only) {
  if (!only || check.id === "run" || only.includes(check.id)) return null;
  return { ...check, status: "skipped", detail: `not asked for (--only ${only.join(",")})` };
}

export function parseArgs(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    failGate: argv.includes("--fail-gate"),
    build: !argv.includes("--no-build"),
    keep: argv.includes("--keep"),
    only: argv.includes("--only") ? parseOnly(argv[argv.indexOf("--only") + 1]) : null,
    slot: value("--slot", `${path.basename(ROOT)}-verify`),
    scale: Number(value("--timeout-scale", "1")) || 1,
  };
}

async function openDb(file) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

/** One read-only query against the dev copy's database, or [] while it can't be read. */
async function query(file, sql, ...params) {
  if (!fs.existsSync(file)) return [];
  let db;
  try {
    db = await openDb(file);
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // closed
    }
  }
}

/** WebKit's local storage files under a HOME (the window's: the kickoff claim, Ash's Waiting on you). */
function localStorageFiles(dir, depth = 0, found = []) {
  if (depth > 10) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) localStorageFiles(full, depth + 1, found);
    else if (entry.isFile() && (entry.name === "localstorage.sqlite3" || entry.name.endsWith(".localstorage"))) found.push(full);
  }
  return found;
}

/** Every key of the window's local storage, read from a copy (WAL and all) so the running app's files are untouched. */
async function localStorageOf(home, scratch) {
  const { DatabaseSync } = await import("node:sqlite");
  const items = {};
  const files = localStorageFiles(path.join(home, "Library"));
  for (const [index, file] of files.entries()) {
    const copy = path.join(scratch, "localstorage-copy", String(index));
    fs.rmSync(copy, { recursive: true, force: true });
    fs.mkdirSync(copy, { recursive: true });
    let db;
    try {
      for (const suffix of ["", "-wal", "-shm"])
        if (fs.existsSync(`${file}${suffix}`)) fs.copyFileSync(`${file}${suffix}`, path.join(copy, `db${suffix}`));
      db = new DatabaseSync(path.join(copy, "db"));
      for (const row of db.prepare("SELECT key, value FROM ItemTable").all())
        items[row.key] = typeof row.value === "string" ? row.value : new TextDecoder("utf-16le").decode(row.value);
    } catch {
      // not a local storage database, or mid-write: the next look reads it again
    } finally {
      try {
        db?.close();
      } catch {
        // closed
      }
    }
  }
  return { files: files.length, items };
}

/** The live lines the dev window recorded for the bench (monocode:verify-live-lines), oldest first. */
export function liveLinesSeen(items) {
  try {
    const lines = JSON.parse(items["monocode:verify-live-lines"] ?? "[]");
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
}

/** Passes when some live line showed a step with a running timer and the runner sat right after it. */
export function liveLineVerdict(lines) {
  const timed = lines.filter((line) => typeof line.text === "string" && /\b\d+(s|m \d+s|m)\b/.test(line.text));
  const pinned = timed.find((line) => line.runner && line.runnerAfterText);
  const evidence = { seen: lines.length, timed: timed.length, sample: (pinned ?? timed[0] ?? lines[0]) ?? null };
  return pinned
    ? { ok: true, evidence, detail: `the window drew "${pinned.text}" with the MonoCode runner right after the timer (${lines.length} lines seen)` }
    : { ok: false, evidence };
}

/**
 * A chat's entry on Ash's Waiting on you (hub/model/waitingChats.ts keeps it in local storage), or null while it has
 * none. `final`: describe what was read even without one (found: the store this window writes, by its kickoff claim).
 */
export async function waitingEntry(home, chat, scratch, final = false) {
  const { files, items } = await localStorageOf(home, scratch);
  let entry = null;
  try {
    entry = JSON.parse(items["monocode:hub-waiting-chats"] ?? "{}")[chat] ?? null;
  } catch {
    entry = null;
  }
  const found = "monocode:verify-live-kickoff" in items;
  if (entry) return { found, files, entry: { routedToLead: entry.routedToLead ?? false, source: entry.source, question: entry.question } };
  return final ? { found, files, entry: null } : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const id = runId(new Date(), options.failGate);
  const evidence = path.join(ROOT, "evidence", id);
  fs.mkdirSync(evidence, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "monocode-verify-"));
  const home = path.join(scratch, "home");
  const project = path.join(scratch, "project");
  const bin = path.join(scratch, "bin");
  const fake = path.join(evidence, "fake");
  // The window's driver (verifyDriver.ts), from the first launch: the walk seats the starter team through it before the
  // kickoff that names one of them. Later plans keep the same folder.
  const driverDir = path.join(scratch, "driver");
  const log = (line) => {
    const text = `[verify-live ${new Date().toISOString().slice(11, 19)}] ${line}`;
    console.log(text);
    fs.appendFileSync(path.join(evidence, "run.log"), `${text}\n`);
  };
  const scale = (ms) => Math.round(ms * options.scale);
  const started = new Date().toISOString();
  const checks = [];
  const record = (check) => {
    const kept = onlySkipped(check, options.only) ?? check;
    checks.push(kept);
    log(`${kept.status.toUpperCase().padEnd(7)} ${kept.id}: ${kept.detail}`);
  };
  const pass = (idName, title, detail, extra = {}) => record({ id: idName, title, status: "pass", detail, ...extra });
  const fail = (idName, title, detail, extra = {}) => record({ id: idName, title, status: "fail", detail, ...extra });
  const skip = (idName, title, detail) => record({ id: idName, title, status: "skipped", detail });
  // The negative control only has to show the gate fails: once a check has failed, stop launching.
  const phase = () => {
    if (options.failGate && checks.some((check) => check.status === "fail")) throw new Halt();
  };
  const children = [];
  let messagesFile = null;
  const messages = [];
  /** Ash's messages for the window (verify_live_messages reads the file; it sends each once). */
  const sendMessages = (...list) => {
    messages.push(...list);
    fs.writeFileSync(messagesFile, `${JSON.stringify(messages, null, 2)}\n`);
  };
  /** Hub projects the copy's local store starts with (verify_live.rs `projects`), added once per launch. */
  const benchProjects = [];
  const writePlan = (next) =>
    fs.writeFileSync(planFile, `${JSON.stringify({ ...next, messages: messagesFile, ...(benchProjects.length ? { projects: benchProjects } : {}) }, null, 2)}\n`);
  let app = null;
  let launches = 0;
  let slot;
  let dataDir = null;
  let db;
  let rulesFile;
  let planFile;
  let plan;
  // r59: what this run made, by id, and the teardown that takes it back out of the window before the copy stops.
  const ledger = { sessions: new Set(), monos: new Set(), project: null };
  let teardown = null;
  let cleanupResult = { ran: false, why: "the run never reached a launch with the window's driver; the temporary HOME goes with everything in it" };

  // The window's kickoff steps (verifyKickoff.ts traceVerifyKickoff: the driver's done/kickoff-*.json), kept per launch
  // in evidence/kickoff/launch-<n>/: a kickoff that never reaches the fake says where it stopped.
  const keepKickoffTraces = () => {
    const done = path.join(driverDir, "done");
    let names = [];
    try {
      names = fs.readdirSync(done).filter((name) => /^kickoff-[A-Za-z0-9._-]+\.json$/.test(name));
    } catch {
      return [];
    }
    if (!names.length) return [];
    const into = path.join(evidence, "kickoff", `launch-${launches}`);
    fs.mkdirSync(into, { recursive: true });
    for (const name of names.sort()) {
      try {
        fs.renameSync(path.join(done, name), path.join(into, name));
      } catch {
        // a step written while this ran is kept with the next launch
      }
    }
    return names.map((name) => name.replace(/^kickoff-\d+-|\.json$/g, ""));
  };
  const cleanup = async () => {
    if (app && alive(app.pid)) {
      try {
        process.kill(app.pid, "SIGTERM");
      } catch {
        // gone
      }
      await until(() => !alive(app.pid), 10_000);
      if (alive(app.pid)) process.kill(app.pid, "SIGKILL");
    }
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // gone
      }
    }
  };
  // However the run ends (it returns, it throws, even while setting up, or it is killed with SIGINT/SIGTERM): the copy,
  // the build and vite stop, the database is kept as evidence and the temporary HOME goes (unless --keep).
  const ending = cleanupOnExit(
    async () => {
      // Pass or fail: archive and remove what this run made (only its own ids, through the window's own Archive and
      // Remove, never Reset chat) while the copy is still up, then stop it.
      if (teardown && app && alive(app.pid)) {
        try {
          let timer;
          cleanupResult = await Promise.race([
            teardown(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("teardown took longer than 2 minutes")), 120_000);
            }),
          ]).finally(() => clearTimeout(timer));
        } catch (error) {
          cleanupResult = { ran: true, ok: false, error: error.message };
        }
        log(`cleanup: ${cleanupResult.ok ? "OK" : "LEFT SOMETHING"} ${JSON.stringify(cleanupResult.leftovers ?? cleanupResult.error ?? {})}`);
      }
      await cleanup();
      keepKickoffTraces();
      // The database, after the app is gone (WAL and all).
      if (dataDir) {
        try {
          fs.mkdirSync(path.join(evidence, "db"), { recursive: true });
          for (const name of ["monocode.db", "monocode.db-wal", "monocode.db-shm"]) {
            const from = path.join(dataDir, name);
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(evidence, "db", name));
          }
        } catch (error) {
          log(`couldn't copy the database: ${error.message}`);
        }
      }
      if (!options.keep) fs.rmSync(scratch, { recursive: true, force: true });
    },
    { onSignal: (signal) => log(`${signal}: stopping what this run started${options.keep ? "" : " and removing its temporary HOME"}`) },
  );

  try {
    for (const dir of [home, project, bin, fake, path.join(driverDir, "inbox")]) fs.mkdirSync(dir, { recursive: true });
    // The app asks Claude's usage before it admits a worker, and a machine with no Claude login has no room: the walk
    // would sit with every delegate waiting. The fake Claude needs no login, so the bench writes the shape of a
    // signed-in account with a stale token (no network call: the probe answers 401 itself).
    log(`signed the throwaway HOME's Claude in (expired fake token): ${path.relative(scratch, signInFakeClaude(home))}`);

    // -- the slot, the fake and the plan -------------------------------------------------------------------------------
    // Planned against the real slot registry (read only) so it never takes another worktree's slot, but registered only
    // under the temporary HOME: in the real slots.json a later plain hub:dev in this worktree could pick it.
    slot = await planSlot({ requested: options.slot });
    if (kindOf(slot.identifier) !== "dev" || !slot.identifier.startsWith(DEV_IDENTIFIER_PREFIX))
      throw new Error(`refusing: ${slot.identifier} is not a dev copy's identifier`);
    dataDir = path.join(home, "Library/Application Support", slot.identifier);
    db = path.join(dataDir, "monocode.db");
    log(`run ${id}: slot ${slot.slot} (${slot.identifier}), HOME ${home}, evidence ${path.relative(ROOT, evidence)}`);
    log(WIRING_NOTE);

    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
    fs.writeFileSync(path.join(project, "README.md"), "Scratch project for hub:verify-live.\n");
    execFileSync("git", ["add", "README.md"], { cwd: project });
    execFileSync(
      "git",
      ["-c", "user.name=verify", "-c", "user.email=verify@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
      { cwd: project },
    );

    const claude = path.join(bin, "claude");
    fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "scripts/fake-claude.mjs")}" "$@"\n`, { mode: 0o755 });
    rulesFile = path.join(evidence, "scenario.json");
    fs.writeFileSync(rulesFile, `${JSON.stringify(scenario({ runId: id, failGate: options.failGate }), null, 2)}\n`);
    planFile = path.join(scratch, "verify-plan.json");
    plan = {
      version: 1,
      runId: id,
      claudeBinary: claude,
      autoResume: true,
      driver: driverDir,
      kickoff: { project, monoName: "Verify Lead", prompt: `${KICKOFF} run ${id}: delegate the verify worker, then wait for its report.` },
    };
    messagesFile = path.join(scratch, "verify-messages.json");
    writePlan(plan);
    fs.writeFileSync(path.join(evidence, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    await ending.finish();
    ending.dispose();
    throw error;
  }

  try {
    // -- build ---------------------------------------------------------------------------------------------------------
    registerSlot(slot, home);
    writeSlotConfig(slot);
    const config = mergePatch(readJson(path.join(ROOT, "src-tauri/tauri.hub.conf.json")), readJson(slot.configFile));
    const binary = path.join(ROOT, "target/debug/monocode");
    if (options.build) {
      log("building the verify slot's dev copy (cargo build, shared cache) ...");
      const buildLog = fs.openSync(path.join(evidence, "build.log"), "w");
      const code = await new Promise((resolve) => {
        const child = spawn("cargo", ["build", "-p", "monocode"], {
          cwd: ROOT,
          stdio: ["ignore", buildLog, buildLog],
          env: {
            ...process.env,
            TAURI_CONFIG: JSON.stringify(config),
            CARGO_BUILD_BUILD_DIR: slot.buildDir,
          },
        });
        children.push(child);
        child.on("exit", (exit) => resolve(exit ?? 1));
      });
      if (code !== 0) throw new Error(`cargo build failed (${path.relative(ROOT, path.join(evidence, "build.log"))})`);
    }
    if (!fs.existsSync(binary)) throw new Error(`${binary} is missing; run without --no-build`);
    const version = JSON.parse(execFileSync(binary, ["version", "--json"], { encoding: "utf8", env: { ...process.env, HOME: home } }));
    if (version.identifier !== slot.identifier || version.kind !== "dev")
      throw new Error(`the built copy is ${version.identifier} (${version.kind}), not ${slot.identifier}`);
    log(`built ${version.identifier} at ${version.stamp?.branch} @ ${String(version.stamp?.sha).slice(0, 7)}${version.stamp?.dirty ? "-dirty" : ""}`);

    // -- vite ------------------------------------------------------------------------------------------------------------
    const viteLog = fs.openSync(path.join(evidence, "vite.log"), "w");
    const vite = spawn(path.join(ROOT, "node_modules/.bin/vite"), [], {
      cwd: ROOT,
      stdio: ["ignore", viteLog, viteLog],
      env: { ...process.env, MONOCODE_VITE_PORT: String(slot.port), VITE_MONOCODE_HUB: "1" },
    });
    children.push(vite);
    const served = await until(async () => {
      try {
        return (await fetch(`http://localhost:${slot.port}/`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
    if (!served) throw new Error(`vite never answered on port ${slot.port} (see vite.log)`);

    // -- the app -------------------------------------------------------------------------------------------------------
    const appEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("TAURI_") && !key.startsWith("MONOCODE_") && !key.startsWith("FAKE_CLAUDE_") && key !== "CFFIXED_USER_HOME",
      ),
    );
    Object.assign(appEnv, {
      HOME: home,
      MONOCODE_NO_ALERT: "1",
      // An accessory app that never takes focus (src-tauri/src/lib.rs): the walk's launches stay out of Ash's way.
      MONOCODE_HUB_BACKGROUND: "1",
      MONOCODE_VERIFY_LIVE: planFile,
      MONOCODE_DEV_APP_NAME: `${DEV_PRODUCT} ${slot.slot}`,
      FAKE_CLAUDE_STATE: fake,
      FAKE_CLAUDE_SCENARIO: rulesFile,
    });
    const readRunning = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, "running.json"), "utf8"));
      } catch {
        return null;
      }
    };
    const launch = async () => {
      launches += 1;
      const out = fs.openSync(path.join(evidence, `app-${launches}.log`), "w");
      const child = spawn(binary, [], { cwd: ROOT, env: appEnv, stdio: ["ignore", out, out] });
      children.push(child);
      const record = await until(() => {
        const running = readRunning();
        return running && running.pid && alive(running.pid) && (running.pid === child.pid || !app || running.pid !== app.pid)
          ? running
          : null;
      }, scale(120_000));
      if (!record) throw new Error(`launch ${launches} never wrote running.json (see app-${launches}.log)`);
      app = { pid: record.pid, child, record };
      log(`launch ${launches}: pid ${record.pid}`);
      return record;
    };
    /** One action for the window's driver (verifyDriver.ts perform), and its answer. */
    let driverSeq = 0;
    const act = async (op, payload = {}, timeoutMs = 60_000) => {
      const actionId = `${String(++driverSeq).padStart(5, "0")}-${op}`;
      const tmp = path.join(driverDir, "inbox", `.${actionId}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ id: actionId, op, ...payload }));
      fs.renameSync(tmp, path.join(driverDir, "inbox", `${actionId}.json`));
      const done = path.join(driverDir, "done", `${actionId}.json`);
      const answer = await until(() => {
        try {
          return JSON.parse(fs.readFileSync(done, "utf8"));
        } catch {
          return null;
        }
      }, scale(timeoutMs));
      if (!answer) throw new Error(`driver: no answer to ${actionId} in ${timeoutMs / 1000}s`);
      fs.writeFileSync(path.join(evidence, `driver-${actionId}.json`), `${JSON.stringify(answer, null, 2)}\n`);
      return answer;
    };
    const kill = async (why) => {
      const pids = [...new Set([app.pid, app.child.pid])].filter((pid) => alive(pid));
      for (const pid of pids) {
        const command = commandOf(pid);
        // Only our own dev copy: its binary in this worktree's target/debug (or the dev wrapper beside it).
        if (!command.includes(path.join(ROOT, "target/debug"))) throw new Error(`refusing to kill pid ${pid}: ${command}`);
        process.kill(pid, "SIGKILL");
      }
      await until(() => pids.every((pid) => !alive(pid)), 15_000);
      const steps = keepKickoffTraces();
      log(`killed launch ${launches} (${why})${steps.length ? `; its kickoff: ${steps.join(", ")}` : ""}`);
      // Its Claude children see stdin close and exit.
      await sleep(500);
    };
    const prompts = () => readNdjson(path.join(fake, "prompts.ndjson"));
    const mark = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(fake, "marks", `${name}.json`), "utf8"));
      } catch {
        return null;
      }
    };
    const waitMark = (name, ms) => until(() => mark(name), scale(ms));
    const inFlight = () => query(db, "SELECT session_id, background_json, resumes FROM in_flight_sessions");
    const delegations = () =>
      query(db, "SELECT id, owner_session, child_session, state, delivery, generation FROM delegations ORDER BY created_at");
    const providerOf = async (sessionId) =>
      (await query(db, "SELECT provider_session_id AS p FROM sessions WHERE id = ?", sessionId))[0]?.p ?? null;
    const monoBlocks = (sessionId) =>
      query(db, "SELECT block_json FROM mono_blocks WHERE session_id = ? ORDER BY seq DESC LIMIT 20", sessionId).then((rows) =>
        rows.map((row) => JSON.parse(row.block_json)),
      );

    // 0. Isolation.
    const first = await launch();
    const isolated =
      first.kind === "dev" &&
      path.resolve(dataDir).startsWith(path.resolve(home)) &&
      fs.existsSync(path.join(dataDir, "running.json")) &&
      !String(first.bundlePath ?? "").includes("/Applications/");
    (isolated ? pass : fail)(
      "isolated",
      "A throwaway dev slot under a temporary HOME",
      `${slot.identifier} (${first.kind}), data in the temporary HOME, bundle ${first.bundlePath ?? "?"}`,
    );

    // 1. The Lead delegates.
    const delegated = await waitMark("lead-delegated", 240_000);
    const call = readNdjson(path.join(fake, "app-calls.ndjson")).find((entry) => entry.action === "sessions.start");
    const workerId = call?.response?.result?.id;
    const rows = await until(async () => {
      const found = await delegations();
      return found.length ? found : null;
    }, scale(20_000));
    const row = rows?.find((entry) => entry.child_session === workerId);
    if (delegated && call?.response?.ok && row)
      pass("lead_delegated", "A Lead delegates (a stored H2 row)", `sessions.start -> ${workerId}; delegation ${row.id} (${row.state})`, {
        evidence: { delegation: row },
      });
    else
      fail("lead_delegated", "A Lead delegates (a stored H2 row)", `mark ${!!delegated}, call ${JSON.stringify(call?.response ?? null)}, rows ${JSON.stringify(rows)}`);
    const leadId = row?.owner_session;
    // Delegations are the app's own rows since 21 Oct (src-tauri/src/delegations.rs, "No mirror"), and since WP-04 the
    // app has no Ash OS to send a copy to at all.
    (row ? pass : fail)("delegation_local", "The delegation row stays in the app (no mirror to Ash OS)", row ? `${row.id} is the app's row` : "no row to check");

    phase();
    // 2. The worker runs, with a subagent in the background, and its in-flight row says so.
    const workerStarted = await waitMark("worker-started", 90_000);
    (workerStarted ? pass : fail)("worker_ran", "The worker runs", workerStarted ? `conversation ${workerStarted.conversation}` : "no worker turn");
    // The Lead's second brief to the busy worker queues behind its work (T3 "Briefs to a busy chat queue or steer").
    fs.mkdirSync(path.join(fake, "gates"), { recursive: true });
    fs.writeFileSync(path.join(fake, "gates", "worker-busy"), "");
    const queuedMark = await waitMark("lead-queued", 60_000);
    const sendCall = readNdjson(path.join(fake, "app-calls.ndjson")).find((entry) => entry.action === "sessions.send");
    const followed = await until(async () => {
      const found = await query(db, "SELECT id, child_session, state, follow FROM delegations WHERE follow = 'queue'");
      return found.length ? found[0] : null;
    }, scale(15_000));
    const waiting = await until(async () => {
      const raw = (await query(db, "SELECT queued_messages_json AS q FROM sessions WHERE id = ?", workerId))[0]?.q;
      const parsed = raw ? JSON.parse(raw) : [];
      return parsed.find((message) => message.waitForIdle && String(message.appRequestId ?? "").includes(leadId ?? "?")) ?? null;
    }, scale(15_000));
    if (queuedMark && sendCall?.response?.ok && sendCall.response.result?.delivery === "queued" && followed?.child_session === workerId && waiting)
      pass(
        "brief_queued",
        "A brief to a busy session queues behind its work and the sender hears \"queued\"",
        `sessions.send -> delivery ${sendCall.response.result.delivery}; followed row ${followed.id} (${followed.follow}, ${followed.state}); waiting in the worker's queue as ${waiting.appRequestId}`,
      );
    else
      fail(
        "brief_queued",
        "A brief to a busy session queues behind its work and the sender hears \"queued\"",
        `mark ${!!queuedMark}, response ${JSON.stringify(sendCall?.response ?? null)}, row ${JSON.stringify(followed)}, queued ${JSON.stringify(waiting)}`,
      );
    const saved = await until(async () => {
      const rowsNow = await inFlight();
      const own = rowsNow.find((entry) => entry.session_id === workerId);
      // The chat's Claude conversation must be saved too, or nothing could resume it.
      return own?.background_json?.includes(SUBAGENT_ID) && (await providerOf(workerId)) === workerStarted?.conversation
        ? own
        : null;
    }, scale(20_000));
    (saved ? pass : fail)(
      "inflight_saved_background",
      "The running worker's in-flight row holds its background work",
      saved ? `in_flight_sessions: ${saved.background_json}` : `rows: ${JSON.stringify(await inFlight())}`,
    );

    phase();
    // 3. The app dies mid-turn and comes back: the worker resumes by itself, told what was cut.
    await kill("mid-turn, worker waiting on its subagent");
    await launch();
    const resumed = await waitMark("worker-resumed", 90_000);
    const note = resumed?.prompt ?? "";
    if (resumed && resumed.resumed && note.includes("background work was cut") && note.includes(`(id ${SUBAGENT_ID})`) && note.includes(CONTINUE))
      pass("restart_resumed_with_note", "After the restart the worker resumes once, with the what-was-cut note", note.slice(0, 400));
    else
      fail(
        "restart_resumed_with_note",
        "After the restart the worker resumes once, with the what-was-cut note",
        resumed ? `prompt: ${note.slice(0, 400)}` : `no resumed worker turn; prompts: ${JSON.stringify(prompts().map((p) => p.rule))}`,
      );

    phase();
    // 4. The worker's report wakes the Lead.
    const report = await waitMark("lead-got-report", 90_000);
    const delivered = await until(async () => {
      const found = (await delegations()).find((entry) => entry.child_session === workerId);
      return found && found.delivery === "delivered" ? found : null;
    }, scale(15_000));
    if (report && report.prompt.includes("[MonoCode report]") && delivered)
      pass("report_woke_lead", "The worker's report wakes the Lead", `delegation ${delivered.id}: ${delivered.state}, ${delivered.delivery}`);
    else
      fail(
        "report_woke_lead",
        "The worker's report wakes the Lead",
        `mark ${!!report}; delegation ${JSON.stringify((await delegations()).find((entry) => entry.child_session === workerId) ?? null)}`,
      );

    phase();
    // 5. The Lead's Claude transcript is lost while the app is down: it starts fresh from its brief.
    const leadBusy = await until(
      async () =>
        (await inFlight()).find((entry) => entry.session_id === leadId) &&
        (await providerOf(leadId)) === report?.conversation,
      scale(20_000),
    );
    if (!report || !leadBusy) {
      fail("dead_session_recovered", "A Lead whose Claude transcript is gone starts fresh from its brief", "not reached: the Lead never went busy on the report");
      fail("crash_loop_capped", `A turn that keeps dying stops after ${MAX_RESUMES} resumes (Needs you)`, "not reached");
    } else {
      await kill("Lead mid-turn");
      const lostConversation = report.conversation;
      fs.rmSync(path.join(fake, "conversations", `${lostConversation}.json`), { force: true });
      await launch();
      const recovered = await waitMark("lead-recovered", 90_000);
      const dead = readNdjson(path.join(fake, "events.ndjson")).some((event) => event.dir === "dead" && event.conversation === lostConversation);
      const recoveredBlocks = leadId ? await until(async () => {
        const blocks = await monoBlocks(leadId);
        return blocks.some((block) => block.notice === "recovered") ? blocks : null;
      }, scale(15_000)) : null;
      if (recovered && dead && recovered.conversation !== lostConversation && recovered.prompt.includes("<chat_brief>") && recoveredBlocks)
        pass(
          "dead_session_recovered",
          "A Lead whose Claude transcript is gone starts fresh from its brief",
          `"No conversation found" for ${lostConversation}; fresh conversation ${recovered.conversation}; the chat shows the recovered note`,
        );
      else
        fail(
          "dead_session_recovered",
          "A Lead whose Claude transcript is gone starts fresh from its brief",
          `dead ${dead}, mark ${JSON.stringify(recovered && { conversation: recovered.conversation, brief: recovered.prompt.includes("<chat_brief>") })}, recovered note ${!!recoveredBlocks}`,
        );

      // 6. Killed under the Lead's resumed turn again and again: three resumes, then Needs you.
      const leadResumes = () =>
        prompts().filter((entry) => entry.rule === "lead-recovered" || entry.rule === "lead-lost-resume");
      let capped = Boolean(recovered);
      for (let resume = 2; capped && resume <= MAX_RESUMES; resume += 1) {
        const counted = await until(async () => {
          const rowNow = (await inFlight()).find((entry) => entry.session_id === leadId);
          const latest = leadResumes().at(-1)?.conversation;
          return rowNow && rowNow.resumes === resume - 1 && (await providerOf(leadId)) === latest ? rowNow : null;
        }, scale(20_000));
        if (!counted) {
          capped = false;
          break;
        }
        await kill(`Lead's resume ${resume - 1}`);
        await launch();
        capped = Boolean(await until(() => leadResumes().length >= resume, scale(90_000)));
      }
      const third = capped && (await until(async () => {
        const rowNow = (await inFlight()).find((entry) => entry.session_id === leadId);
        return rowNow && rowNow.resumes === MAX_RESUMES ? rowNow : null;
      }, scale(20_000)));
      let stopped = null;
      if (third) {
        await kill(`Lead's resume ${MAX_RESUMES}`);
        await launch();
        stopped = await until(async () => {
          const blocks = await monoBlocks(leadId);
          return blocks[0]?.notice === "resume-stopped" ? blocks[0] : null;
        }, scale(60_000));
        // Give it time to (wrongly) resume a fourth time.
        await sleep(scale(8_000));
      }
      const resumeCount = leadResumes().length;
      const leftInFlight = (await inFlight()).some((entry) => entry.session_id === leadId);
      if (stopped && resumeCount === MAX_RESUMES && !leftInFlight)
        pass(
          "crash_loop_capped",
          `A turn that keeps dying stops after ${MAX_RESUMES} resumes (Needs you)`,
          `${resumeCount} resumes, then: ${String(stopped.text).split("\n")[0]}`,
        );
      else
        fail(
          "crash_loop_capped",
          `A turn that keeps dying stops after ${MAX_RESUMES} resumes (Needs you)`,
          `resumes ${resumeCount}, stopped note ${!!stopped}, still in flight ${leftInFlight}`,
        );
    }

    phase();
    // WP-05: a starter template is never the Mono's id. Seat the bench team while this launch's driver is still up.
    // The room takes the hub project id; each Mono is tied to the scratch folder, or a kickoff aimed at that folder
    // never finds it (verifyKickoffMono). --fail-gate throws at phase() above, so it never waits on this.
    const seated = await act("teamPack", { pack: "ash", project: TREE_PROJECT.id, folder: project }, 120_000);
    const bySpec = new Map((seated?.monos ?? []).filter((mono) => mono?.specId).map((mono) => [mono.specId, mono]));
    const idOf = (spec) => bySpec.get(spec)?.id ?? null;
    const hostId = idOf("coordinator") ?? "missing-coordinator";
    const reviewerId = idOf("design-review") ?? "missing-reviewer";
    const plannerId = idOf("planner") ?? "missing-planner";
    const keeperId = idOf("record-keeper") ?? "missing-keeper";
    for (const mono of bySpec.values()) ledger.monos.add(mono.id);
    log(`seated ${[...bySpec.entries()].map(([spec, mono]) => `${spec}=${mono.id}`).join(", ") || "nobody"}`);
    if (!seated?.ok) log(`teamPack failed: ${JSON.stringify(seated)}`);
    // 7 and 8. Double delegation, in a fresh launch with a second plan. The plan now lists a project on the
    // scratch folder, so the hub makes its Lead ("Verify lead"); the kickoff waits for the Coordinator seated above
    // to work on that folder and sends it the brief.
    benchProjects.push({ id: TREE_PROJECT.id, name: TREE_PROJECT.name, folder: project });
    ledger.project = TREE_PROJECT.id;
    await kill("for the double-delegation plan");
    const treePlan = {
      ...plan,
      runId: `${id}-tree`,
      // A worker silent this long is stalled (workerStall.ts): seconds here, minutes in the app.
      stallMs: 10_000,
      kickoff: {
        project,
        monoName: ROOM_SEATS[0],
        monoId: hostId,
        prompt: `${TREE_KICKOFF} run ${id}: brief the Verify lead, then cancel that brief when told.`,
      },
    };
    writePlan(treePlan);
    fs.writeFileSync(path.join(evidence, "plan-tree.json"), `${JSON.stringify(treePlan, null, 2)}\n`);
    await launch();

    const savedCall = (name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(fake, "saved", `${name}.json`), "utf8"));
      } catch {
        return null;
      }
    };
    const open = (name) => {
      fs.mkdirSync(path.join(fake, "gates"), { recursive: true });
      fs.writeFileSync(path.join(fake, "gates", name), "");
    };
    const rowById = async (taskId) =>
      taskId
        ? ((
            await query(
              db,
              "SELECT id, owner_session, child_session, parent_id, root_id, follow, state, delivery, result, pending_question, stall_kind, log FROM delegations WHERE id = ?",
              taskId,
            )
          )[0] ?? null)
        : null;
    const brief = (row) => row && { ...row, log: undefined, events: JSON.parse(row.log || "[]").map((entry) => `${entry.event} by ${entry.by}`) };
    const events = () => readNdjson(path.join(fake, "events.ndjson"));
    const interruptedIn = (conversation) =>
      !!conversation && events().some((event) => event.conversation === conversation && event.dir === "in" && /"subtype":"interrupt"/.test(event.line ?? ""));
    const turnsOf = (conversation, prefix) =>
      prompts().filter((entry) => entry.conversation === conversation && new RegExp(said(prefix)).test(entry.prompt));

    // 7. The Lead's worker asks; the question goes to the Lead.
    const cosBriefed = await waitMark("cos-briefed", 120_000);
    const cosBrief = savedCall("cos-brief");
    const cosTaskId = cosBrief?.response?.result?.taskId;
    const leadChat = cosBrief?.response?.result?.childSessionId;
    const asking = await waitMark("asker-asking", 90_000);
    const askerTask = savedCall("asker-task");
    const askerTaskId = askerTask?.response?.result?.taskId;
    const askerChat = askerTask?.response?.result?.childSessionId;
    const asked = await until(async () => {
      const row = await rowById(askerTaskId);
      return row?.state === "question" ? row : null;
    }, scale(20_000));
    const woken = await waitMark("tree-lead-got-question", 30_000);
    // While it is open: Ash's Waiting on you (the window's local storage) must not list the worker as his.
    const listing = asked ? await until(() => waitingEntry(home, askerChat, scratch), scale(10_000), 500) : null;
    const store = listing ?? (await waitingEntry(home, askerChat, scratch, true));
    open("answer-go");
    const answered = await waitMark("asker-answered", 30_000);
    const leadAnswer = savedCall("lead-answer");
    const askerDone = await until(async () => {
      const row = await rowById(askerTaskId);
      return row?.state === "completed" ? row : null;
    }, scale(30_000));
    const cosConversation = cosBriefed?.conversation;
    const askerConversation = asking?.conversation;
    const leadConversation = woken?.conversation;
    const notAsh = store?.found && (!store.entry || store.entry.routedToLead === true);
    const question = {
      wake: woken && woken.prompt.slice(woken.prompt.lastIndexOf("[MonoCode question]"), woken.prompt.lastIndexOf("[MonoCode question]") + 160),
      cosQuestions: turnsOf(cosConversation, "\\[MonoCode question\\]").length,
      askerPrompts: prompts().filter((entry) => entry.conversation === askerConversation).length,
    };
    if (
      cosBrief?.response?.ok &&
      cosBrief.response.result?.lead &&
      asked?.owner_session === leadChat &&
      asked.pending_question?.includes(QUESTION) &&
      woken &&
      leadConversation !== cosConversation &&
      woken.prompt.includes(askerTaskId) &&
      woken.prompt.includes(QUESTION) &&
      question.cosQuestions === 0 &&
      notAsh &&
      leadAnswer?.response?.ok &&
      leadAnswer.response.result?.answered === true &&
      answered?.answered &&
      answered.conversation === askerConversation &&
      answered.answers?.[QUESTION] === PICK &&
      question.askerPrompts === 1 &&
      askerDone?.result?.includes(`going with ${PICK}`)
    )
      pass(
        "question_routed",
        "A delegated worker's question goes to its Lead, not Ash, and its turn carries on with the Lead's answer",
        `${ROOM_SEATS[0]} briefed ${cosBrief.response.result.lead} (task ${cosTaskId}); its worker asked "${QUESTION}" -> row ${askerTaskId} in question, the Lead woke with [MonoCode question] (${ROOM_SEATS[0]} got none), Ash's Waiting on you ${store.entry ? "lists it as routed to the Lead" : "does not list it"}; task_answer ${PICK} -> the worker's same turn went on: "${askerDone.result.slice(0, 120)}"`,
        { evidence: { asked: brief(asked), answered: brief(askerDone), waitingOnYou: store, question } },
      );
    else
      fail(
        "question_routed",
        "A delegated worker's question goes to its Lead, not Ash, and its turn carries on with the Lead's answer",
        JSON.stringify({
          brief: cosBrief?.response ?? null,
          asking: !!asking,
          asked: brief(asked),
          woken: !!woken,
          sameAsCos: leadConversation === cosConversation,
          question,
          waitingOnYou: store,
          answer: leadAnswer?.response ?? null,
          answered: answered && { conversation: answered.conversation === askerConversation, answers: answered.answers },
          done: brief(askerDone ?? (await rowById(askerTaskId))),
        }),
      );

    phase();
    // 8. One cancel at the top: Chief of Staff cancels its brief while the Lead's second worker is busy.
    const helperStarted = await waitMark("helper-started", 60_000);
    const helperTask = savedCall("helper-task");
    const helperTaskId = helperTask?.response?.result?.taskId;
    const helperChat = helperTask?.response?.result?.childSessionId;
    const beneath = await until(async () => {
      const row = await rowById(helperTaskId);
      const busy = (await inFlight()).some((entry) => entry.session_id === helperChat);
      return row?.state === "running" && row.parent_id === cosTaskId && busy ? row : null;
    }, scale(20_000));
    // The helper went silent mid-turn (it waits on a gate that never opens): its row is marked stalled, quiet, since its
    // last activity, while it still runs; the window found it by itself.
    const stalledRow = await until(async () => {
      const rows = await query(db, "SELECT state, stall_kind, stall_reason, stalled_at, log FROM delegations WHERE id = ?", helperTaskId ?? "");
      return rows[0]?.stall_kind === "quiet" ? rows[0] : null;
    }, scale(90_000));
    if (stalledRow?.state === "running" && stalledRow.stalled_at > 0 && String(stalledRow.log).includes('"event":"stalled"'))
      pass(
        "worker_stalled",
        "A worker that goes silent mid-turn is marked stalled on its row",
        `task ${helperTaskId}: still running, stall_kind quiet since ${new Date(stalledRow.stalled_at).toISOString()}, logged "stalled"`,
        { evidence: { state: stalledRow.state, stall: stalledRow.stall_kind, since: stalledRow.stalled_at } },
      );
    else
      fail(
        "worker_stalled",
        "A worker that goes silent mid-turn is marked stalled on its row",
        JSON.stringify({ helperTaskId, row: brief(await rowById(helperTaskId)), stalled: stalledRow ?? null }),
      );
    phase();
    const before = { top: brief(await rowById(cosTaskId)), helper: brief(beneath) };
    open("tree-cancel");
    const cancelled = await waitMark("cos-cancelled", 60_000);
    const cancelCall = savedCall("cos-cancel");
    const ended = await until(async () => {
      const top = await rowById(cosTaskId);
      const helper = await rowById(helperTaskId);
      return [top, helper].every((row) => row?.state === "cancelled" && row.delivery === "disposed") ? { top, helper } : null;
    }, scale(15_000));
    const helperConversation = helperStarted?.conversation;
    const helperStopped = await until(
      async () => interruptedIn(helperConversation) && !(await inFlight()).some((entry) => entry.session_id === helperChat),
      scale(15_000),
    );
    const leadStopped = interruptedIn(leadConversation);
    open("lead-hold");
    const carriedOn = await waitMark("tree-lead-carried-on", 30_000);
    // Time for a report that should never come (the cancelled brief's, or its worker's).
    await sleep(scale(6_000));
    const askerRow = await rowById(askerTaskId);
    const late = {
      toCos: turnsOf(cosConversation, "\\[MonoCode report\\]").length,
      helperToLead: turnsOf(leadConversation, "\\[MonoCode report\\]").filter((entry) => helperChat && entry.prompt.includes(helperChat)).length,
      helperPrompts: prompts().filter((entry) => entry.conversation === helperConversation).length,
    };
    const result = cancelCall?.response?.result;
    if (
      beneath &&
      before.top?.follow === "lead" &&
      cancelled &&
      cancelCall?.response?.ok &&
      result?.status === "cancelled" &&
      result.cancelledBeneath >= 1 &&
      Array.isArray(result.stopFailed) &&
      !result.stopFailed.length &&
      ended &&
      !ended.helper.stall_kind &&
      helperStopped &&
      !leadStopped &&
      carriedOn &&
      askerRow?.state === "completed" &&
      !late.toCos &&
      !late.helperToLead &&
      late.helperPrompts === 1
    )
      pass(
        "cascade_stop",
        "One cancel at the top of a double delegation stops everything beneath it",
        `${ROOM_SEATS[0]} -> Verify lead (task ${cosTaskId}, follow lead) -> worker (task ${helperTaskId}, parent ${beneath.parent_id}); task_cancel -> ${result.status}, cancelledBeneath ${result.cancelledBeneath}, stopFailed []; both rows cancelled and disposed, the worker's turn interrupted, the Lead's own turn not stopped (it carried on), no report to ${ROOM_SEATS[0]} or the Lead; the finished asker's row stays completed`,
        { evidence: { before, after: { top: brief(ended.top), helper: brief(ended.helper), asker: brief(askerRow) }, cancel: cancelCall.response } },
      );
    else
      fail(
        "cascade_stop",
        "One cancel at the top of a double delegation stops everything beneath it",
        JSON.stringify({
          beneath: !!beneath,
          before,
          cancelled: !!cancelled,
          cancel: cancelCall?.response ?? null,
          after: ended
            ? { top: brief(ended.top), helper: brief(ended.helper) }
            : { top: brief(await rowById(cosTaskId)), helper: brief(await rowById(helperTaskId)) },
          helperStopped: !!helperStopped,
          leadStopped,
          carriedOn: !!carriedOn,
          asker: askerRow?.state,
          late,
        }),
      );

    phase();
    // 9 to 12. Restarts. A third plan whose fake Claude takes /goal; the kickoff goes to the Coordinator again.
    await kill("for the durability plan");
    const durablePlan = {
      ...plan,
      runId: `${id}-durable`,
      goals: true,
      kickoff: {
        project,
        monoName: ROOM_SEATS[0],
        monoId: hostId,
        prompt: `${DURABLE_KICKOFF} run ${id}: start the goal workers and brief the Verify lead.`,
      },
    };
    writePlan(durablePlan);
    fs.writeFileSync(path.join(evidence, "plan-durable.json"), `${JSON.stringify(durablePlan, null, 2)}\n`);
    await launch();

    /** A chat's stored /goal (sessions.goal_json) and conversation; goal null when none is stored. */
    const storedGoal = async (sessionId) => {
      const row = sessionId
        ? (await query(db, "SELECT goal_json AS g, provider_session_id AS p FROM sessions WHERE id = ?", sessionId))[0]
        : undefined;
      if (!row) return null;
      let goal = null;
      try {
        goal = row.g ? JSON.parse(row.g) : null;
      } catch {
        goal = null;
      }
      return { goal, provider: row.p ?? null };
    };
    const queueOf = async (sessionId) => {
      const raw = sessionId ? (await query(db, "SELECT queued_messages_json AS q, queue_status AS s FROM sessions WHERE id = ?", sessionId))[0] : null;
      try {
        return { messages: raw?.q ? JSON.parse(raw.q) : [], status: raw?.s ?? null };
      } catch {
        return { messages: [], status: raw?.s ?? null };
      }
    };
    const rulesIn = (conversation) => prompts().filter((entry) => entry.conversation === conversation).map((entry) => entry.rule);
    const fired = (rule) => prompts().filter((entry) => entry.rule === rule).length;
    const goalPrompts = (goal) => prompts().filter((entry) => entry.prompt === `/goal ${goal}`);
    const requestOf = async (taskId) =>
      taskId ? ((await query(db, "SELECT request_id AS r FROM delegations WHERE id = ?", taskId))[0]?.r ?? null) : null;
    const goalA = goalFor(GOAL_A_WORKER, id);
    const goalB = goalFor(GOAL_B_WORKER, id);

    const durableStarted = await waitMark("durable-started", 120_000);
    const taskA = savedCall("goal-a")?.response?.result;
    const taskB = savedCall("goal-b")?.response?.result;
    const lead1 = savedCall("lead-1")?.response?.result;
    const chatA = taskA?.childSessionId;
    const chatB = taskB?.childSessionId;
    const durableLead = lead1?.childSessionId;
    const setA = await waitMark("goal-a-set", 60_000);
    const setB = await waitMark("goal-b-set", 60_000);
    const leadBusy1 = await waitMark("durable-lead-busy", 60_000);
    // The finish line is stored with the chat while it works: set, and its first check counted.
    const storedOpen = (sessionId, conversation, checks) =>
      until(async () => {
        const stored = await storedGoal(sessionId);
        return stored?.goal?.status === "active" && stored.goal.checks === checks && stored.goal.providerSessionId === conversation ? stored : null;
      }, scale(20_000));
    const beforeA = setA ? await storedOpen(chatA, setA.conversation, 1) : null;
    const beforeB = setB ? await storedOpen(chatB, setB.conversation, 1) : null;
    open("durable-queue");
    const durableQueued = await waitMark("durable-queued", 60_000);
    const lead2 = savedCall("lead-2")?.response?.result;
    const lead3 = savedCall("lead-3")?.response?.result;
    const sendA = savedCall("queued-a")?.response?.result;
    open("durable-cancel");
    const cancelledMark = await waitMark("durable-cancelled", 60_000);
    const cancel2 = savedCall("cancel-2")?.response;
    const lead2Row = () => rowById(lead2?.taskId);
    const waitingBefore = await until(async () => {
      const lead = await queueOf(durableLead);
      const worker = await queueOf(chatA);
      const has = (queue, requestId) => !!requestId && queue.messages.some((message) => message.appRequestId === requestId);
      const rows = { two: await lead2Row(), three: await rowById(lead3?.taskId) };
      return rows.two?.state === "cancelled" &&
        !has(lead, await requestOf(lead2?.taskId)) &&
        rows.three &&
        has(lead, await requestOf(lead3?.taskId)) &&
        worker.messages.some((message) => message.waitForIdle && String(message.text).startsWith(QUEUED_A))
        ? { lead: lead.messages.map((m) => m.appRequestId), worker: worker.messages.map((m) => m.appRequestId), rows }
        : null;
    }, scale(15_000));
    const leadConversation1 = leadBusy1?.conversation;
    const leadStoppedForCancel = interruptedIn(leadConversation1);
    // Chief of Staff's own turn ends first, so only the three busy chats are cut.
    const cosChat = (await rowById(lead1?.taskId))?.owner_session;
    await until(async () => (cosChat && !(await inFlight()).some((entry) => entry.session_id === cosChat) ? true : null), scale(10_000));
    const busyAtKill = (await inFlight()).map((entry) => entry.session_id);
    await kill("goal workers and the Lead busy, briefs waiting");
    if (setB?.conversation) fs.rmSync(path.join(fake, "conversations", `${setB.conversation}.json`), { force: true });
    await launch();

    // A: the same conversation, still holding its goal; nothing is sent again and the checks go on from the stored one.
    const resumedA = await waitMark("goal-a-resumed", 90_000);
    const duringA = resumedA ? await storedOpen(chatA, setA?.conversation, 2) : null;
    open("goal-a-finish");
    // B: a fresh conversation from its brief, and its /goal once more in it, with the checks it had.
    const recoveredB = await waitMark("goal-b-recovered", 90_000);
    const resetB = await waitMark("goal-b-reset", 60_000);
    const duringB = resetB ? await storedOpen(chatB, resetB.conversation, 2) : null;
    open("goal-b-finish");
    const clearedA = await until(async () => ((await storedGoal(chatA))?.goal === null ? true : null), scale(20_000));
    const clearedB = await until(async () => ((await storedGoal(chatB))?.goal === null ? true : null), scale(20_000));
    const goalEvidence = {
      before: { a: beforeA?.goal ?? null, b: beforeB?.goal ?? null },
      afterRestart: { a: duringA?.goal ?? null, b: duringB?.goal ?? null },
      cleared: { a: !!clearedA, b: !!clearedB },
      goalPrompts: { a: goalPrompts(goalA).map((p) => p.conversation), b: goalPrompts(goalB).map((p) => p.conversation) },
      conversations: { a: setA?.conversation, b: [setB?.conversation, recoveredB?.conversation] },
      busyAtKill,
    };
    if (
      beforeA &&
      beforeB &&
      resumedA?.resumed &&
      resumedA.conversation === setA.conversation &&
      duringA &&
      goalPrompts(goalA).length === 1 &&
      recoveredB &&
      recoveredB.conversation !== setB.conversation &&
      resetB?.conversation === recoveredB.conversation &&
      duringB &&
      goalPrompts(goalB).length === 2 &&
      goalPrompts(goalB)[1].conversation === recoveredB.conversation &&
      clearedA &&
      clearedB
    )
      pass(
        "goal_survives_restart",
        "A chat's /goal survives a restart: kept by a resumed conversation, set again once in a fresh one, then cleared when met",
        `stored before the kill: A ${beforeA.goal.checks} check, B ${beforeB.goal.checks}; A resumed ${resumedA.conversation} with its goal (no /goal sent again, checks ${duringA.goal.checks}); B's transcript was gone, fresh conversation ${recoveredB.conversation} got /goal once (checks carried: ${duringB.goal.checks}); both met and cleared`,
        { evidence: goalEvidence },
      );
    else fail("goal_survives_restart", "A chat's /goal survives a restart: kept by a resumed conversation, set again once in a fresh one, then cleared when met", JSON.stringify(goalEvidence));

    // 10. The briefs that waited go in once each chat's resumed turn is over.
    const deliveredA = await waitMark("queued-a-delivered", 60_000);
    const leadResumed = await waitMark("durable-lead-resumed", 60_000);
    const delivered3 = await waitMark("durable-lead-3-delivered", 60_000);
    const settled = await until(async () => {
      const followA = (await query(db, "SELECT id, state, delivery, follow FROM delegations WHERE child_session = ? AND follow = 'queue'", chatA ?? "?"))[0];
      const three = await rowById(lead3?.taskId);
      return followA?.state === "completed" && three?.state === "completed" ? { followA, three: brief(three) } : null;
    }, scale(30_000));
    const orderA = rulesIn(setA?.conversation);
    const orderLead = rulesIn(leadConversation1);
    const queueEvidence = {
      sends: { a: sendA?.delivery ?? null, lead2: lead2?.delivery ?? null, lead3: lead3?.delivery ?? null },
      waitingBefore,
      orderA,
      orderLead,
      settled,
      queuesAfter: { a: await queueOf(chatA), lead: await queueOf(durableLead) },
    };
    if (
      durableQueued &&
      sendA?.delivery === "queued" &&
      lead3?.delivery === "queued" &&
      waitingBefore &&
      deliveredA &&
      leadResumed &&
      delivered3 &&
      orderA.indexOf("durable-goal-a-resume") >= 0 &&
      orderA.indexOf("durable-goal-a-resume") < orderA.indexOf("durable-queued-a") &&
      orderLead.indexOf("durable-lead-resume") >= 0 &&
      orderLead.indexOf("durable-lead-resume") < orderLead.indexOf("durable-lead-3") &&
      fired("durable-queued-a") === 1 &&
      fired("durable-lead-3") === 1 &&
      settled
    )
      pass(
        "queued_brief_after_restart",
        "Briefs queued before a restart go in by themselves once their chat's resumed turn is over, once each",
        `worker A's brief and the Lead's brief 3 waited through the restart (queued), went in after the resumed turns (${orderA.join(" > ")}; ${orderLead.join(" > ")}), once each, and their rows settled (${settled.followA.state}, ${settled.three.state})`,
        { evidence: queueEvidence },
      );
    else fail("queued_brief_after_restart", "Briefs queued before a restart go in by themselves once their chat's resumed turn is over, once each", JSON.stringify(queueEvidence));

    // 11. The brief cancelled while it waited in the busy Lead's queue stays out.
    const twoAfter = await lead2Row();
    const cancelEvidence = {
      send: lead2?.delivery ?? null,
      cancel: cancel2 ?? null,
      row: brief(twoAfter),
      leadStoppedForCancel,
      deliveredAfterRestart: fired("durable-lead-2"),
    };
    if (
      lead2?.delivery === "queued" &&
      cancelledMark &&
      cancel2?.ok &&
      cancel2.result?.status === "cancelled" &&
      waitingBefore &&
      twoAfter?.state === "cancelled" &&
      twoAfter.delivery === "disposed" &&
      !leadStoppedForCancel &&
      leadResumed &&
      fired("durable-lead-2") === 0
    )
      pass(
        "cancelled_brief_stays_out",
        "A brief cancelled while it waits in a busy Lead's queue leaves the queue, the Lead isn't stopped, and a restart doesn't bring it back",
        `task_cancel on Lead brief 2 (queued) -> ${cancel2.result.status}; row cancelled and disposed, out of the Lead's queue before the restart, the Lead's own turn not interrupted, and after the restart brief 3 went in but brief 2 never did`,
        { evidence: cancelEvidence },
      );
    else fail("cancelled_brief_stays_out", "A brief cancelled while it waits in a busy Lead's queue leaves the queue, the Lead isn't stopped, and a restart doesn't bring it back", JSON.stringify(cancelEvidence));

    // 12. One more restart, with everything idle: nothing goes in twice and no goal comes back.
    // Idle includes the host: its reports from this phase (goal A, goal B and the Lead's briefs) have gone in and
    // its queue is empty. Under load the kill came while two still waited in its queue, and they went in after the
    // lead-flow plan's launch, where check 17 read one as the report it was waiting for.
    const cosSettled = await until(async () => {
      if (!cosChat) return null;
      const owed = (await query(db, "SELECT id, state, delivery FROM delegations WHERE owner_session = ?", cosChat)).filter(
        (row) => row.state !== "running" && row.state !== "question" && (row.delivery === "pending" || row.delivery === "queued"),
      );
      const queue = await queueOf(cosChat);
      const busyNow = (await inFlight()).some((entry) => entry.session_id === cosChat);
      return !owed.length && !queue.messages.length && !busyNow ? true : null;
    }, scale(90_000));
    if (!cosSettled) log("the host still had reports owed or queued at the idle restart (waited 90 s)");
    await sleep(scale(2_000));
    await kill("everything idle");
    await launch();
    await sleep(scale(8_000));
    const finalCounts = {
      queuedA: fired("durable-queued-a"),
      lead2: fired("durable-lead-2"),
      lead3: fired("durable-lead-3"),
      goalA: goalPrompts(goalA).length,
      goalB: goalPrompts(goalB).length,
      goalAgain: fired("durable-goal-a-again"),
      storedA: (await storedGoal(chatA))?.goal ?? null,
      storedB: (await storedGoal(chatB))?.goal ?? null,
      inFlight: (await inFlight()).map((entry) => entry.session_id),
    };
    if (
      finalCounts.queuedA === 1 &&
      finalCounts.lead2 === 0 &&
      finalCounts.lead3 === 1 &&
      finalCounts.goalA === 1 &&
      finalCounts.goalB === 2 &&
      finalCounts.goalAgain === 0 &&
      finalCounts.storedA === null &&
      finalCounts.storedB === null &&
      clearedA &&
      clearedB
    )
      pass(
        "nothing_repeats_after_restart",
        "Another restart repeats nothing: no brief twice, no /goal again, no finished goal back",
        `after launch ${launches}: worker A's brief 1x, Lead brief 3 1x, brief 2 0x; /goal A 1x, /goal B 2x (once per conversation); no stored goal`,
        { evidence: finalCounts },
      );
    else fail("nothing_repeats_after_restart", "Another restart repeats nothing: no brief twice, no /goal again, no finished goal back", JSON.stringify(finalCounts));

    phase();
    // 13 to 17. Coding with a Lead, on a fourth plan: the Coordinator briefs the Verify lead, which starts two workers,
    // and Ash writes to the Lead the way he types (the messages file lists them; the window sends each once).
    await kill("for the lead-flow plan");
    // This launch also reads the window (checks 22 and 23) through the driver the real-Claude bench uses
    // (verifyDriver.ts): its actions go into <driver>/inbox and its answers come back in <driver>/done.
    const flowPlan = {
      ...plan,
      driver: driverDir,
      runId: `${id}-flow`,
      kickoff: {
        project,
        monoName: ROOM_SEATS[0],
        monoId: hostId,
        prompt: `${FLOW_KICKOFF} run ${id}: brief the Verify lead on the API and the UI.`,
      },
    };
    writePlan(flowPlan);
    fs.writeFileSync(path.join(evidence, "plan-flow.json"), `${JSON.stringify(flowPlan, null, 2)}\n`);
    await launch();
    /** Ash types into the Verify lead's chat: the window sends it within a second. Returns when it was listed. */
    const ashSays = (n, text) => {
      sendMessages({ id: `flow-ash-${n}`, monoId: FLOW_LEAD_MONO, prompt: `${FLOW_ASH(n)} run ${id}: ${text}` },
      );
      return Date.now();
    };
    const busy = async (sessionId) => (await inFlight()).some((entry) => entry.session_id === sessionId);
    const blocksOf = (sessionId) =>
      query(db, "SELECT block_json FROM mono_blocks WHERE session_id = ? ORDER BY seq", sessionId).then((rows) =>
        rows.map((row) => JSON.parse(row.block_json)),
      );
    const promptsOf = (rule) => prompts().filter((entry) => entry.rule === rule);
    const after = (mark, sentAt) => (mark ? Date.parse(mark.at) - sentAt : null);

    // The run's teardown, for the ending (pass or fail): only ids this run made (teardownList), through the driver.
    teardown = async () => {
      const appCalls = [];
      try {
        for (const line of fs.readFileSync(path.join(fake, "app-calls.ndjson"), "utf8").split("\n"))
          if (line.trim()) appCalls.push(JSON.parse(line));
      } catch {
        // no calls logged
      }
      const rows = async () =>
        (await query(db, "SELECT id, cwd, worktree_cwd AS worktree, archived FROM sessions")).map((row) => ({ ...row }));
      const windowMonos = async () => (await act("snapshot", {}, 30_000))?.monos ?? [];
      const list = teardownList({
        appCalls,
        extraSessions: [...ledger.sessions],
        monoIds: [...ledger.monos],
        leadMonoId: ledger.project ? FLOW_LEAD_MONO : null,
        windowMonos: await windowMonos(),
        windowSessions: await rows(),
        scratch: [scratch, fs.realpathSync(scratch)],
        project,
      });
      const done = await act("cleanup", list, 90_000);
      // The project this run listed stays in the throwaway copy's local store; the temporary HOME goes with it.
      const projectDropped = null;
      let leftovers = { sessions: list.sessions, monos: list.monos };
      await until(async () => {
        leftovers = teardownLeftovers(list, { rows: await rows(), windowMonos: await windowMonos() });
        return leftovers.sessions.length + leftovers.monos.length === 0 ? true : null;
      }, scale(20_000));
      const ok = done?.ok === true && leftovers.sessions.length + leftovers.monos.length === 0;
      fs.writeFileSync(path.join(evidence, "cleanup.json"), `${JSON.stringify({ list, done, projectDropped, leftovers }, null, 2)}\n`);
      return {
        ran: true,
        ok,
        sessions: list.sessions.length,
        monos: list.monos,
        archived: done?.archived?.length ?? 0,
        removedMonos: done?.removedMonos ?? [],
        missing: done?.missing ?? [],
        failed: done?.failed ?? [],
        projectDropped,
        leftovers,
      };
    };

    // 13. The Lead hands both jobs out and says it's done: one "Still working on" note, and the brief stays open.
    const flowBriefed = await waitMark("flow-cos-briefed", 180_000);
    const flowBrief = savedCall("flow-brief")?.response?.result;
    const flowTaskId = flowBrief?.taskId;
    const flowLeadChat = flowBrief?.childSessionId;
    const flowDelegated = await waitMark("flow-lead-delegated", 90_000);
    const apiTask = savedCall("flow-api-task")?.response?.result;
    const uiTask = savedCall("flow-ui-task")?.response?.result;
    const apiStarted = await waitMark("flow-api-started", 90_000);
    const uiStarted = await waitMark("flow-ui-started", 90_000);
    const noteFound = flowLeadChat
      ? await until(async () => {
          if (await busy(flowLeadChat)) return null;
          const notes = (await blocksOf(flowLeadChat)).filter((block) => block.notice === "still-running");
          return notes.length ? notes : null;
        }, scale(30_000))
      : null;
    // Time for a second (wrong) note.
    await sleep(scale(3_000));
    const notes = flowLeadChat ? (await blocksOf(flowLeadChat)).filter((block) => block.notice === "still-running") : [];
    const briefWhileOut = await rowById(flowTaskId);
    const noteEvidence = { notes, brief: brief(briefWhileOut), api: apiTask?.taskId, ui: uiTask?.taskId };
    if (
      flowBriefed &&
      flowBrief?.lead &&
      flowDelegated &&
      apiStarted &&
      uiStarted &&
      noteFound &&
      notes.length === 1 &&
      notes[0].text.startsWith("Still working on Flow API, Flow UI.") &&
      notes[0].stillRunning?.briefId === flowTaskId &&
      [apiTask?.taskId, uiTask?.taskId].every((taskId) => notes[0].stillRunning?.taskIds?.includes(taskId)) &&
      briefWhileOut?.state === "running"
    )
      pass(
        "still_running_noted",
        "A Lead that says it's done while its workers run gets one \"Still running\" note, and its brief stays open",
        `${ROOM_SEATS[0]} briefed ${flowBrief.lead} (task ${flowTaskId}); the Lead started Flow API and Flow UI and said "Done"; its chat shows "${notes[0].text}" once, and the brief is still ${briefWhileOut.state}`,
        { evidence: noteEvidence },
      );
    else
      fail(
        "still_running_noted",
        "A Lead that says it's done while its workers run gets one \"Still running\" note, and its brief stays open",
        JSON.stringify({ briefed: !!flowBriefed, brief: flowBrief ?? null, delegated: !!flowDelegated, started: [!!apiStarted, !!uiStarted], ...noteEvidence }),
      );

    phase();
    // 14. Ash writes to the idle Lead while both workers run: it answers him within one turn.
    const sent1 = ashSays(1, "how is it going?");
    const ash1 = await waitMark("flow-ash-1-answered", 30_000);
    const ash1Done = flowLeadChat ? await until(async () => (await busy(flowLeadChat) ? null : true), scale(20_000)) : null;
    const answered1 = (blocks) => blocks.some((block) => block.role === "assistant" && String(block.text).startsWith("ASH-1-ANSWER"));
    const ash1Blocks = flowLeadChat
      ? ((await until(async () => {
          const blocks = await blocksOf(flowLeadChat);
          return answered1(blocks) ? blocks : null;
        }, scale(15_000))) ?? [])
      : [];
    const ash1Rows = { api: (await rowById(apiTask?.taskId))?.state, ui: (await rowById(uiTask?.taskId))?.state };
    const ash1Evidence = {
      latencyMs: after(ash1, sent1),
      sameConversationAsLead: ash1?.conversation === flowDelegated?.conversation,
      steered: promptsOf("flow-ash-1")[0]?.steered ?? false,
      answerShown: answered1(ash1Blocks),
      workers: ash1Rows,
      prompts: promptsOf("flow-ash-1").length,
    };
    if (
      ash1 &&
      ash1Done &&
      ash1Evidence.sameConversationAsLead &&
      ash1Evidence.answerShown &&
      ash1Evidence.prompts === 1 &&
      ash1Evidence.latencyMs < scale(15_000) &&
      ash1Rows.api === "running" &&
      ash1Rows.ui === "running"
    )
      pass(
        "lead_chats_while_workers_run",
        "Ash's message to a Lead with two workers running is answered within one turn",
        `answered ${ash1Evidence.latencyMs} ms after it was sent, in one turn of the Lead's own conversation, while Flow API and Flow UI were both still running`,
        { evidence: ash1Evidence },
      );
    else fail("lead_chats_while_workers_run", "Ash's message to a Lead with two workers running is answered within one turn", JSON.stringify(ash1Evidence));

    phase();
    // 15. The API finishes first: its report reaches the Lead (within the report window) while the UI still runs.
    const apiReleased = Date.now();
    open("flow-api-go");
    const apiReport = await waitMark("flow-lead-got-api", 90_000);
    const uiAtApiReport = (await rowById(uiTask?.taskId))?.state;
    const apiPrompt = apiReport?.prompt ?? "";
    const perWorkerEvidence = {
      afterMs: after(apiReport, apiReleased),
      uiAtApiReport,
      progress: apiPrompt.match(/\d+ of \d+ back[^.]*\./)?.[0] ?? null,
      carriesUi: apiPrompt.includes("FLOW-UI-DONE"),
    };
    if (apiReport && uiAtApiReport === "running" && apiPrompt.includes("1 of 2 back, still running: Flow UI") && !perWorkerEvidence.carriesUi)
      pass(
        "reports_per_worker",
        "One worker's report reaches its Lead while the other still runs, saying how many are back",
        `the API's report reached the Lead ${perWorkerEvidence.afterMs} ms after it finished, while Flow UI was still ${uiAtApiReport}: "${perWorkerEvidence.progress}"`,
        { evidence: perWorkerEvidence },
      );
    else fail("reports_per_worker", "One worker's report reaches its Lead while the other still runs, saying how many are back", JSON.stringify(perWorkerEvidence));

    phase();
    // 16. The UI finishes while the Lead is mid-turn on the API's report: the UI's report waits in its queue. Ash writes:
    // his message goes in first, steering into the running turn, and is answered before the UI's report goes in.
    open("flow-ui-go");
    const uiReceipt = async () => {
      const request = (await query(db, "SELECT request_id AS r FROM delegations WHERE id = ?", uiTask?.taskId ?? "?"))[0]?.r;
      return request ? `mono-completion-${request}-g1` : null;
    };
    const uiQueued = flowLeadChat
      ? await until(async () => {
          const receipt = await uiReceipt();
          const queue = await queueOf(flowLeadChat);
          return receipt && queue.messages.some((message) => message.id === receipt) ? { receipt, queue: queue.messages.map((m) => m.id) } : null;
        }, scale(60_000))
      : null;
    const sent2 = ashSays(2, "is the UI done?");
    const ash2 = await waitMark("flow-ash-2-answered", 30_000);
    const uiTurnAtAsh2 = mark("flow-lead-got-ui");
    const ash2Prompt = promptsOf("flow-ash-2")[0];
    const ash2Evidence = {
      uiQueued,
      latencyMs: after(ash2, sent2),
      steered: ash2Prompt?.steered ?? false,
      sameTurnAsApiReport: !!ash2 && ash2.conversation === apiReport?.conversation,
      uiReportTurnBeforeAsh: !!uiTurnAtAsh2,
      leadOrder: rulesIn(apiReport?.conversation).filter((rule) => rule?.startsWith("flow-")),
    };
    open("flow-lead-hold");
    const uiTurn = await waitMark("flow-lead-got-ui", 60_000);
    ash2Evidence.leadOrder = rulesIn(apiReport?.conversation).filter((rule) => rule?.startsWith("flow-"));
    const order = ash2Evidence.leadOrder;
    if (
      uiQueued &&
      ash2 &&
      ash2Evidence.steered &&
      ash2Evidence.sameTurnAsApiReport &&
      !ash2Evidence.uiReportTurnBeforeAsh &&
      ash2Evidence.latencyMs < scale(15_000) &&
      uiTurn &&
      order.indexOf("flow-ash-2") >= 0 &&
      order.indexOf("flow-ash-2") < order.indexOf("flow-lead-ui-report")
    )
      pass(
        "ash_first_over_report",
        "Ash's message never waits behind a worker's report: it steers into the Lead's running turn ahead of it",
        `the UI's report waited in the busy Lead's queue (${uiQueued.receipt}); Ash's message went ahead of it, joined the running turn and was answered in ${ash2Evidence.latencyMs} ms; the UI's report went in after (${order.join(" > ")})`,
        { evidence: ash2Evidence },
      );
    else fail("ash_first_over_report", "Ash's message never waits behind a worker's report: it steers into the Lead's running turn ahead of it", JSON.stringify(ash2Evidence));

    phase();
    // 17. Ash steers into the Lead's last turn on the brief, before its final words: leadership still gets the Lead's
    // complete report (the Lead is asked for it on its own), never the words cut off at Ash's message.
    const sent3 = ashSays(3, "anything for me?");
    const ash3 = await waitMark("flow-ash-3-answered", 30_000);
    open("flow-final-hold");
    const askedReport = await waitMark("flow-lead-asked-report", 90_000);
    const cosGot = await waitMark("flow-cos-got-report", 90_000);
    const reported = await until(async () => {
      const row = await rowById(flowTaskId);
      return row && row.state !== "running" ? row : null;
    }, scale(30_000));
    const completeReport = `FLOW-REPORT run ${id}: the API and the UI are shipped; evidence FLOW-API-DONE and FLOW-UI-DONE; nothing open.`;
    const reportEvidence = {
      ash3: { latencyMs: after(ash3, sent3), steered: promptsOf("flow-ash-3")[0]?.steered ?? false, sameTurnAsUiReport: ash3?.conversation === uiTurn?.conversation },
      askedReport: !!askedReport,
      row: brief(reported),
      cosPromptHasReport: !!cosGot?.prompt?.includes(completeReport),
      otherReports: promptsOf("flow-cos-other-report").length,
    };
    if (
      ash3 &&
      reportEvidence.ash3.steered &&
      askedReport &&
      cosGot &&
      reported?.state === "completed" &&
      reported.result === completeReport &&
      reportEvidence.cosPromptHasReport &&
      reportEvidence.otherReports === 0
    )
      pass(
        "leadership_report_complete",
        "A message Ash steers into the Lead's last turn never truncates its report to leadership",
        `Ash steered into the Lead's last turn on the brief (answered in ${reportEvidence.ash3.latencyMs} ms); the Lead was asked for its report on its own and ${ROOM_SEATS[0]} got all of it: "${reported.result}"`,
        { evidence: reportEvidence },
      );
    else fail("leadership_report_complete", "A message Ash steers into the Lead's last turn never truncates its report to leadership", JSON.stringify(reportEvidence));

    phase();
    // 17b. The Lead asks Ash with AskUserQuestion; he types his answer into its chat, the way he would. His words are the
    // question's free-text answer in place (Claude Code's own picker does the same), never a message queued behind it.
    ashSays(4, "ask me what colour the badge should be");
    const lead4 = await waitMark("flow-lead-asks", 30_000);
    // The question reaches the window first (the fake asks right after the mark).
    await sleep(scale(1_500));
    const typed = `${FLOW_ASH(5)} run ${id}: orange, like the logo`;
    const sent5 = ashSays(5, "orange, like the logo");
    const answered4 = await waitMark("flow-ask-answered", 30_000);
    const leadSaid4 = flowLeadChat
      ? await until(async () => ((await blocksOf(flowLeadChat)).some((block) => block.role === "assistant" && String(block.text).startsWith("ASH-4-ANSWER")) ? true : null), scale(15_000))
      : null;
    const typedEvidence = {
      asked: !!lead4,
      latencyMs: after(answered4, sent5),
      answered: answered4?.answered ?? null,
      answers: answered4?.answers ?? null,
      queuedAsMessage: !!mark("flow-ash-5-as-message"),
      leadCarriedOn: !!leadSaid4,
    };
    if (
      typedEvidence.asked &&
      typedEvidence.answered === true &&
      Object.values(typedEvidence.answers ?? {}).includes(typed) &&
      !typedEvidence.queuedAsMessage &&
      typedEvidence.leadCarriedOn &&
      typedEvidence.latencyMs < scale(15_000)
    )
      pass(
        "ash_typed_answer",
        "Ash's typed words answer the Lead's open question in place, never wait behind it",
        `the Lead asked "Which colour should the badge be?"; Ash typed "${typed}" in its chat and it reached the question as its answer ${typedEvidence.latencyMs} ms later; the Lead carried on in the same turn and nothing went in as a separate message`,
        { evidence: typedEvidence },
      );
    else fail("ash_typed_answer", "Ash's typed words answer the Lead's open question in place, never wait behind it", JSON.stringify(typedEvidence));

    phase();
    // 18 to 20. The room, in the same launch: Ash writes in the Verify project's Leadership team.
    const roomRows = () =>
      query(db, "SELECT seq, id, author, kind, text, reply_to, meta_json FROM room_messages WHERE room_id = ? ORDER BY seq", ROOM_ID).then((rows) =>
        rows.map((row) => ({ ...row, meta: JSON.parse(row.meta_json || "{}") })),
      );
    const ashInRoom = (n, text) => {
      sendMessages({ id: `room-ash-${n}`, room: TREE_PROJECT.id, prompt: `${ROOM_ASH(n)}: ${text}` },
      );
      return Date.now();
    };
    const notesIn = async (kind) =>
      (await query(db, "SELECT session_id, block_json FROM mono_blocks WHERE block_json LIKE '%\"monoNote\"%'"))
        .map((row) => ({ session: row.session_id, block: JSON.parse(row.block_json) }))
        .filter((row) => row.block.role === "user" && row.block.internal && row.block.monoNote?.kind === kind);
    const roomSent = ashInRoom(1, "plan round 1");
    const hostAnswered = await waitMark("room-host-answered", 60_000);
    const passed = await waitMark("room-pass", 120_000);
    const loop = await until(async () => {
      const rows = await roomRows();
      const at = rows.findIndex((row) => row.author === "ash" && row.text.startsWith(ROOM_ASH(1)));
      const tail = at >= 0 ? rows.slice(at) : [];
      return tail.some((row) => row.text.startsWith("Pass from me")) ? tail : null;
    }, scale(30_000));
    const roomNotes = await notesIn("room");
    const loopEvidence = {
      latencyMs: after(hostAnswered, roomSent),
      authors: (loop ?? []).map((row) => row.author),
      picks: (loop ?? []).map((row) => row.meta.pick?.by ?? null),
      texts: (loop ?? []).map((row) => row.text),
      quietLines: [...new Set(roomNotes.map((row) => row.session))],
    };
    if (
      hostAnswered &&
      passed &&
      loop &&
      JSON.stringify(loopEvidence.authors) === JSON.stringify(["ash", hostId, plannerId, reviewerId, plannerId, reviewerId]) &&
      JSON.stringify(loopEvidence.picks) === JSON.stringify([null, "lead", "addressed", "addressed", "addressed", "addressed"]) &&
      loop[1].reply_to === loop[0].id &&
      loopEvidence.latencyMs < scale(15_000) &&
      loopEvidence.quietLines.length >= 3
    )
      pass(
        "room_agents_talk",
        "Ash writes in a room: the host answers first, then the Monos hand off among themselves by naming each other, with no digest",
        `${ROOM_SEATS[0]} answered ${loopEvidence.latencyMs} ms after Ash's message; then ${loopEvidence.authors.slice(2).join(", ")} without Ash (round, flag, retake, "${loopEvidence.texts.at(-1)}"); all ${loop.length} rows are in room_messages, and ${loopEvidence.quietLines.length} Mono chats show their room turns as quiet lines`,
        { evidence: loopEvidence },
      );
    else fail("room_agents_talk", "Ash writes in a room: the host answers first, then the Monos hand off among themselves by naming each other, with no digest", JSON.stringify({ hostAnswered: !!hostAnswered, passed: !!passed, ...loopEvidence }));

    phase();
    // 19. The planner works in its own chat; Ash asks the room; the planner's room session answers in the room (its 1:1 untouched).
    sendMessages({ id: "room-busy", monoId: plannerId, prompt: `${ROOM_BUSY} run ${id}: work on the label copy.` });
    const plannerBusy = await waitMark("room-planner-busy", 60_000);
    const askSent = ashInRoom(2, "is the label in?");
    const hostAnswered2 = await waitMark("room-host-answered-2", 60_000);
    const plannerPosted = await waitMark("room-planner-posted", 90_000);
    const answeredRows = await until(async () => {
      const rows = await roomRows();
      const at = rows.findIndex((row) => row.author === "ash" && row.text.startsWith(ROOM_ASH(2)));
      const tail = at >= 0 ? rows.slice(at) : [];
      return tail.some((row) => row.author === plannerId) ? tail : null;
    }, scale(30_000));
    const plannerWake = prompts().find((entry) => entry.rule === "room-planner-wake");
    const plannerRow = answeredRows?.find((row) => row.author === plannerId);
    const hostRow = answeredRows?.find((row) => row.author === hostId);
    // The planner's 1:1 work must not have taken the room's prompt.
    const busyConv = plannerBusy?.conversation;
    const roomPromptInWork = !!busyConv && prompts().some((entry) => entry.conversation === busyConv && /\[MonoCode room\]/.test(entry.prompt ?? ""));
    open("room-planner-release");
    const busyEvidence = {
      plannerBusy: !!plannerBusy,
      hostAnsweredMs: after(hostAnswered2, askSent),
      steered: plannerWake?.steered ?? false,
      ownRoomSession: !!plannerWake && plannerWake.conversation !== busyConv,
      roomPromptInWork,
      plannerRow: plannerRow ? { text: plannerRow.text, pick: plannerRow.meta.pick?.by, replyTo: plannerRow.reply_to } : null,
      hostRow: hostRow ? hostRow.id : null,
    };
    if (
      plannerBusy &&
      hostAnswered2 &&
      plannerPosted &&
      !busyEvidence.steered &&
      busyEvidence.ownRoomSession &&
      !roomPromptInWork &&
      plannerRow?.text === "The label is in. Pass from me." &&
      plannerRow.meta.pick?.by === "addressed" &&
      plannerRow.reply_to === hostRow?.id
    )
      pass(
        "room_busy_mono_answers",
        "A Mono busy in its own chat still answers the room: the room's turn runs in its room session, never in that work, and posts",
        `${ROOM_SEATS[2]} was mid-turn on its own work; ${ROOM_SEATS[0]} named it ${busyEvidence.hostAnsweredMs} ms after Ash asked; its room session took the turn (its 1:1 work got no room prompt) and it posted "${plannerRow.text}", as the answer to ${ROOM_SEATS[0]}'s message`,
        { evidence: busyEvidence },
      );
    else fail("room_busy_mono_answers", "A Mono busy in its own chat still answers the room: the room's turn runs in its room session, never in that work, and posts", JSON.stringify(busyEvidence));

    phase();
    // 20. The host's private message to the record keeper (sent from its room turn).
    const dmCall = savedCall("room-dm");
    const keeperGot = await waitMark("room-keeper-dm", 60_000);
    const dmNotes = keeperGot ? ((await until(async () => {
      const notes = await notesIn("message");
      return notes.length ? notes : null;
    }, scale(15_000))) ?? []) : [];
    const roomNow = await roomRows();
    const dmEvidence = {
      call: dmCall?.response ?? null,
      delivered: !!keeperGot,
      notes: dmNotes.map((row) => ({ session: row.session, note: row.block.monoNote })),
      inRoom: roomNow.some((row) => row.author === keeperId || row.text.includes(ROOM_DM)),
    };
    if (
      dmCall?.response?.ok === true &&
      keeperGot &&
      dmNotes.some((row) => row.block.monoNote?.from === ROOM_SEATS[0] && row.block.monoNote?.ref === hostId && row.block.text.includes(ROOM_DM)) &&
      !dmEvidence.inRoom
    )
      pass(
        "room_private_message",
        "A private message between Monos arrives as a hidden turn in the other Mono's own chat, shown as from the sender, and stays out of the room",
        `mono_message from ${ROOM_SEATS[0]} (sent during its room turn) reached ${ROOM_SEATS[3]}'s own chat as a quiet "From ${ROOM_SEATS[0]}" turn; nothing of it is in the room`,
        { evidence: dmEvidence },
      );
    else fail("room_private_message", "A private message between Monos arrives as a hidden turn in the other Mono's own chat, shown as from the sender, and stays out of the room", JSON.stringify(dmEvidence));

    phase();
    // The live line (r62): while the planner thought in the room, its status line showed the step with a timer and the planner's
    // MonoCode right after it. Read from what the window drew (sessions/model/verifyLiveLines.ts), never the model.
    const seenLines = liveLinesSeen((await localStorageOf(home, scratch)).items);
    const liveVerdict = liveLineVerdict(seenLines);
    if (liveVerdict.ok)
      pass("live_activity_line", "The live line shows the step and its timer, with the MonoCode runner pinned right after the timer", liveVerdict.detail, { evidence: liveVerdict.evidence });
    else fail("live_activity_line", "The live line shows the step and its timer, with the MonoCode runner pinned right after the timer", JSON.stringify(liveVerdict.evidence));

    phase();
    // 21. The coding team: Ash starts a new chat in the Verify project's coding team (the messages file lists his message; the
    // window opens the coding team and starts the chat in the project's folder, as his New session there does).
    sendMessages({ id: "ct-ash-1", codingTeam: TREE_PROJECT.id, prompt: `${CT_KICKOFF} run ${id}: have one worker check the verify widget.` },
    );
    const ctDelegated = await waitMark("ct-delegated", 60_000);
    const ctTask = savedCall("ct-task")?.response;
    const ctChild = ctTask?.result?.childSessionId ?? null;
    const ctWorker = await waitMark("ct-worker-started", 60_000);
    const ctReport = await waitMark("ct-got-report", 60_000);
    const ctRow = ctChild
      ? (await query(db, "SELECT id, owner_session, owner_mono, child_session, project, state, delivery FROM delegations WHERE child_session = ?", ctChild))[0] ?? null
      : null;
    const ctChat = ctRow?.owner_session ?? null;
    if (ctChat) ledger.sessions.add(ctChat);
    const ctSessions = await query(db, "SELECT id, cwd, sidebar_hidden AS hidden FROM sessions WHERE id IN (?, ?)", ctChat ?? "?", ctChild ?? "?");
    const ctChatRow = ctSessions.find((row) => row.id === ctChat) ?? null;
    const ctChildRow = ctSessions.find((row) => row.id === ctChild) ?? null;
    const ctMonoBlocks = ctChat ? (await query(db, "SELECT COUNT(*) AS n FROM mono_blocks WHERE session_id = ?", ctChat))[0]?.n ?? 0 : 0;
    const ctStart = ctDelegated
      ? events().find((event) => event.dir === "start" && event.conversation === ctDelegated.conversation)
      : undefined;
    const ctArgs = ctStart?.argv ?? [];
    const ctMcp = (() => {
      const at = ctArgs.indexOf("--mcp-config");
      try {
        return at >= 0 ? JSON.parse(ctArgs[at + 1]).mcpServers ?? {} : {};
      } catch {
        return {};
      }
    })();
    // The hub hands Claude one comma-joined --allowedTools value (mcp__monocode__*,Read(<hub-docs>/**)), not a bare
    // element, so the delegate tool is looked for inside each argument as well as across them.
    const ctAllowed = ctArgs
      .filter((arg) => typeof arg === "string")
      .flatMap((arg) => arg.split(","))
      .map((tool) => tool.trim());
    const ctFirstPrompt = prompts().find((entry) => entry.rule === "ct-kickoff")?.prompt ?? "";
    // Vanilla Claude Code plus the hub's note (Ash, 21 Oct): the note rides on --append-system-prompt, never in the message.
    const ctAppend = (() => {
      const at = ctArgs.indexOf("--append-system-prompt");
      return at >= 0 ? ctArgs[at + 1] ?? "" : "";
    })();
    const ctBrief = prompts().find((entry) => entry.rule === "ct-worker")?.prompt ?? "";
    const ctEvidence = {
      call: ctTask?.ok ?? null,
      row: ctRow,
      chat: ctChatRow,
      child: ctChildRow,
      chatIsMono: ctMonoBlocks > 0 || !!ctRow?.owner_mono,
      delegateTool: !!ctMcp.monocode && ctAllowed.includes("mcp__monocode__*"),
      // Alfred's hub-note.md word for word (f43e07bc, Ash 21 Oct) names no tools; what it says about handing work on is
      // "hand work to another Mono", and the chat's own line says it is in the project's coding team.
      note: ["running inside MonoCode Hub", "coding team", "hand work to another Mono", "<project_memory>"].filter((part) =>
        ctAppend.includes(part),
      ),
      noteBytes: Buffer.byteLength(ctAppend),
      systemPromptReplaced: ctArgs.includes("--system-prompt"),
      messageClean: !!ctFirstPrompt && !ctFirstPrompt.includes("<monocode_context>"),
      brief: {
        signed: ctBrief.includes("[MonoCode brief from Verify coding team]"),
        rules: ctBrief.includes("<worker_rules>"),
        memory: ctBrief.includes("<project_memory>"),
      },
      reportInSameChat: !!ctReport && ctReport.conversation === ctDelegated?.conversation,
    };
    if (
      ctDelegated &&
      ctTask?.ok === true &&
      ctRow &&
      ctChat &&
      !ctEvidence.chatIsMono &&
      !ctChat.startsWith("app-") &&
      ctChild?.startsWith(`app-${ctChat}-`) &&
      ctChatRow?.cwd === project &&
      ctChildRow?.cwd === project &&
      !ctChildRow.hidden &&
      ctRow.project === TREE_PROJECT.id &&
      ctEvidence.delegateTool &&
      ctEvidence.note.length === 4 &&
      !ctEvidence.systemPromptReplaced &&
      ctEvidence.messageClean &&
      ctEvidence.brief.signed &&
      ctEvidence.brief.rules &&
      ctEvidence.brief.memory &&
      ctWorker &&
      ctEvidence.reportInSameChat
    )
      pass(
        "coding_team_delegates",
        "A chat Ash starts in a project's coding team (not a Mono) is an orchestrator: it delegates, its worker nests under it, and the report comes back to it",
        `Ash's new chat in Verify's coding team (${ctChat}, in the project's folder, no Mono) started with the delegate tool and Claude Code's own system prompt plus a ${ctEvidence.noteBytes}-byte appended note (${ctEvidence.note.join(", ")}), its message untouched; it delegated ${ctChild} (row ${ctRow.id}, project ${ctRow.project}), a chat in the same folder nested under it by its id, signed by "Verify coding team" with its worker rules and the project's memory; the worker's report came back to the same chat`,
        { evidence: ctEvidence },
      );
    else fail("coding_team_delegates", "A chat Ash starts in a project's coding team (not a Mono) is an orchestrator: it delegates, its worker nests under it, and the report comes back to it", JSON.stringify({ delegated: !!ctDelegated, worker: !!ctWorker, report: !!ctReport, ...ctEvidence }));

    phase();
    // 22 and 23. Teams, not sub-chats (Ash, 20 Oct: "monos shouldn't really have sub chats, if its stuff to fix it
    // should either do it itself or pick it up with the coding team ... something like coding team should be created for
    // that mono"). Ash makes a Mono of his own on the Verify project and asks it for a fix there and examples for him.
    sendMessages({
        id: "mt-ash-1",
        newMono: { name: MT_MONO, project },
        prompt: `${MT_KICKOFF} run ${id}: the verify widget's copy is wrong, get it fixed, and find me three good examples.`,
      },
    );
    const mtDelegated = await waitMark("mt-delegated", 90_000);
    const mtLeadWorker = await waitMark("mt-lead-worker-started", 90_000);
    const mtOwnWorker = await waitMark("mt-own-started", 90_000);
    const mtRefused = savedCall("mt-refused")?.response ?? null;
    const mtBriefCall = savedCall("mt-brief")?.response ?? null;
    const mtOwnCall = savedCall("mt-own")?.response ?? null;
    const mtLeadCall = savedCall("mt-lead-task")?.response ?? null;
    const mtRow = async (taskId) =>
      taskId
        ? ((await query(db, "SELECT id, owner_session, owner_mono, child_session, parent_id, follow, project, state FROM delegations WHERE id = ?", taskId))[0] ?? null)
        : null;
    const mtBrief = await mtRow(mtBriefCall?.result?.taskId);
    const mtOwn = await mtRow(mtOwnCall?.result?.taskId);
    const mtLead = await mtRow(mtLeadCall?.result?.taskId);
    const mtMonoId = mtBrief?.owner_mono ?? null;
    if (mtMonoId) ledger.monos.add(mtMonoId);
    const mtChat = mtBrief?.owner_session ?? null;
    const mtLeadChat = mtLead?.owner_session ?? null;
    const teamFolder = mtMonoId ? path.join(dataDir, "mono-teams", mtMonoId) : null;
    const mtSessions = await query(
      db,
      "SELECT id, cwd, sidebar_hidden AS hidden FROM sessions WHERE id IN (?, ?)",
      mtOwn?.child_session ?? "?",
      mtLead?.child_session ?? "?",
    );
    const sessionCwd = (sessionId) => mtSessions.find((row) => row.id === sessionId)?.cwd ?? null;
    // The window while both workers run, through the driver: the Mono's chat (and the rail beside it), Verify's coding
    // team on its Lead, the Mono's own team; each list's folded sub-chats opened as Ash's click does.
    const shown = (dom, attr, value) =>
      (dom?.elements ?? []).filter((element) => element.visible && attr in element.attrs && (value === undefined || element.attrs[attr] === value));
    let chatDom = null;
    let codingDom = null;
    let teamDom = null;
    let driverError = null;
    try {
      await act("ping", {}, 60_000);
      await act("open", { mono: mtMonoId });
      await sleep(scale(1_500));
      chatDom = (await act("snapshot"))?.dom ?? null;
      codingDom = (await act("open", { codingTeam: TREE_PROJECT.id, unfold: [mtLeadChat], settleMs: scale(2_500) }))?.dom ?? null;
      teamDom = (await act("open", { team: mtMonoId, unfold: [mtChat], settleMs: scale(2_500) }))?.dom ?? null;
    } catch (error) {
      driverError = error.message;
    }
    const briefLine = shown(chatDom, "data-briefed-team", mtBrief?.id ?? "?")[0] ?? null;
    const monoLine = shown(chatDom, "data-mono-work", mtMonoId ?? "?")[0] ?? null;
    const railSubChats = [...shown(chatDom, "data-mono-children"), ...shown(chatDom, "data-mono-child")].length;
    const codingOwner = shown(codingDom, "data-coding-team-lead")[0] ?? null;
    const teamOwner = shown(teamDom, "data-coding-team-lead")[0] ?? null;
    // Release the Mono's own worker first, then the Lead's, so each report is a turn of its own.
    open("mt-own-go");
    const mtOwnReport = await waitMark("mt-got-own-report", 120_000);
    open("mt-lead-worker-go");
    const mtLeadReport = await waitMark("mt-got-lead-report", 120_000);
    const builtIn = ["chief-of-staff", "projects-manager", "frank", "alfred", "checker"];
    const mtEvidence = {
      mono: mtMonoId,
      chat: mtChat,
      refused: mtRefused ? { ok: mtRefused.ok, error: mtRefused.error ?? null } : null,
      brief: mtBrief,
      leadWorker: mtLead && { ...mtLead, cwd: sessionCwd(mtLead.child_session), call: { cwd: mtLeadCall?.result?.cwd ?? null, isolation: mtLeadCall?.result?.isolation ?? null } },
      own: mtOwn && { ...mtOwn, cwd: sessionCwd(mtOwn.child_session), hidden: mtSessions.find((row) => row.id === mtOwn.child_session)?.hidden ?? null, team: mtOwnCall?.result?.team ?? null },
      teamFolder: teamFolder && { path: teamFolder, exists: fs.existsSync(teamFolder) },
      window: {
        driverError,
        briefLine: briefLine && { text: briefLine.text, kind: briefLine.attrs["data-briefed-kind"] ?? null, project: briefLine.attrs["data-briefed-project"] ?? null },
        monoLine: monoLine && monoLine.text,
        railSubChats,
        coding: {
          owner: codingOwner && { chat: codingOwner.attrs["data-coding-team-lead"], kind: codingOwner.attrs["data-team-kind"] ?? null },
          leadWorkerNested: shown(codingDom, "data-sub-chats", leadChat ?? "?").length > 0 && shown(codingDom, "data-sub-chat", mtLead?.child_session ?? "?").length > 0,
        },
        team: {
          owner: teamOwner && { chat: teamOwner.attrs["data-coding-team-lead"], kind: teamOwner.attrs["data-team-kind"] ?? null, text: teamOwner.text },
          ownWorkerNested: shown(teamDom, "data-sub-chats", mtChat ?? "?").length > 0 && shown(teamDom, "data-sub-chat", mtOwn?.child_session ?? "?").length > 0,
          leadWorkerThere: shown(teamDom, "data-sub-chat", mtLead?.child_session ?? "?").length > 0,
        },
      },
      reports: { own: !!mtOwnReport, lead: !!mtLeadReport },
    };
    const ashsOwn = !!mtMonoId && !builtIn.includes(mtMonoId) && !mtMonoId.endsWith("-lead");
    if (
      mtDelegated &&
      ashsOwn &&
      mtRefused?.ok === false &&
      /has a coding team/.test(mtRefused.error ?? "") &&
      mtBrief?.follow === "lead" &&
      !!leadChat &&
      mtBrief.child_session === leadChat &&
      mtLeadWorker &&
      mtLead?.parent_id === mtBrief.id &&
      (mtLeadCall?.result?.cwd === project || mtLeadCall?.result?.isolation === "worktree") &&
      !!briefLine &&
      briefLine.text.startsWith("Briefed Verify coding team: Fix the widget copy") &&
      /1 working/.test(briefLine.text) &&
      briefLine.attrs["data-briefed-project"] === TREE_PROJECT.id &&
      railSubChats === 0 &&
      mtEvidence.window.coding.owner?.chat === leadChat &&
      mtEvidence.window.coding.owner?.kind === "coding" &&
      mtEvidence.window.coding.leadWorkerNested &&
      mtLeadReport
    )
      pass(
        "mono_briefs_coding_team",
        "A Mono of Ash's own hands a project's work to its coding team: the work and its sub-chat nest under the Lead there, its chat shows one line, its report comes back",
        `${MT_MONO} (${mtMonoId}, Ash's own) was refused a worker in Verify ("${mtRefused.error}") and briefed the Verify lead (row ${mtBrief.id}, follow lead); the Lead's worker ${mtLead.child_session} sits under that brief and nests under the Lead in Verify's coding team; the Mono's chat showed "${briefLine.text}", the Monos rail listed no sub-chats, and the Lead's report came back to the Mono`,
        { evidence: mtEvidence },
      );
    else fail("mono_briefs_coding_team", "A Mono of Ash's own hands a project's work to its coding team: the work and its sub-chat nest under the Lead there, its chat shows one line, its report comes back", JSON.stringify({ delegated: !!mtDelegated, leadWorker: !!mtLeadWorker, ...mtEvidence }));
    if (
      mtDelegated &&
      mtOwnWorker &&
      ashsOwn &&
      !!mtOwn &&
      mtOwn.owner_session === mtChat &&
      mtOwn.child_session?.startsWith(`app-${mtChat}-`) &&
      // No hub project: a folder outside the hub's projects stays a path on the row (App.tsx launch).
      mtOwn.project === teamFolder &&
      mtEvidence.own?.cwd === teamFolder &&
      mtEvidence.teamFolder?.exists &&
      mtEvidence.own?.team === `${MT_MONO}'s team` &&
      mtEvidence.window.team.owner?.chat === mtChat &&
      mtEvidence.window.team.owner?.kind === "mono" &&
      mtEvidence.window.team.ownWorkerNested &&
      !mtEvidence.window.team.leadWorkerThere &&
      !!monoLine &&
      /2 working/.test(monoLine.text) &&
      mtOwnReport
    )
      pass(
        "mono_own_team",
        "A Mono's own work goes to its own team: a folder in the app's data, its chat pinned on the team's list with the worker under it",
        `${MT_MONO}'s own worker ${mtOwn.child_session} ran in ${path.relative(home, teamFolder)} (made on its first delegation); the team's Sessions list pinned ${mtChat} with that worker under it and nothing of Verify's; the rail's line read "${monoLine.text}"; the worker's report came back to the Mono`,
        { evidence: mtEvidence },
      );
    else fail("mono_own_team", "A Mono's own work goes to its own team: a folder in the app's data, its chat pinned on the team's list with the worker under it", JSON.stringify({ delegated: !!mtDelegated, ownWorker: !!mtOwnWorker, ...mtEvidence }));
  } catch (error) {
    if (error instanceof Halt) {
      for (const name of WALK.filter((name) => !checks.some((check) => check.id === name)))
        skip(name, name, "not run: the negative control stops at its first failure");
    } else fail("run", "The walk ran to the end", error.message);
  } finally {
    await ending.finish();
    ending.dispose();
  }

  const verdict = verdictOf(checks);
  const result = {
    run: id,
    verdict,
    ...wiringScope(verdict),
    failGate: options.failGate,
    ...(options.failGate
      ? {
          plantedFailure: "the fake worker starts no background work and has no resume step",
          negativeControl: verdict === "FAIL" ? "caught" : "missed",
        }
      : {}),
    startedAt: started,
    finishedAt: new Date().toISOString(),
    build: { branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), sha: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" },
    slot: options.slot,
    ...(options.only ? { only: options.only } : {}),
    launches,
    checks,
    cleanup: cleanupResult,
    evidence: {
      fakeEvents: "fake/events.ndjson",
      prompts: "fake/prompts.ndjson",
      appCalls: "fake/app-calls.ndjson",
      database: "db/monocode.db",
      logs: Array.from({ length: launches }, (_, index) => `app-${index + 1}.log`),
    },
  };
  fs.writeFileSync(path.join(evidence, "verdict.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeStageVerdict(result);
  log(`WIRING ${verdict}${options.failGate ? ` (negative control ${result.negativeControl})` : ""}: ${path.relative(ROOT, path.join(evidence, "verdict.json"))}`);
  log(WIRING_NOTE);
  // r59: a run that couldn't take its own Monos and chats back out fails, whatever the walk said.
  if (!options.failGate && cleanupResult.ran && !cleanupResult.ok) {
    console.error(`\n*** hub:verify-live: the run left some of its own items behind: ${JSON.stringify(cleanupResult.leftovers ?? cleanupResult.error)} (evidence/${id}/cleanup.json) ***\n`);
    return 1;
  }
  return exitCode(verdict, options.failGate);
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      // The verify stage must hear that nothing was exercised, not a bare failure.
      const target = process.env.MONOCODE_VERIFY_VERDICT;
      if (target) {
        try {
          fs.writeFileSync(
            target,
            `${JSON.stringify({ outcome: "couldNotExercise", detail: `The bench could not run: ${error.message}`.slice(0, 800) }, null, 2)}\n`,
          );
        } catch {
          // The stage reports the missing verdict itself.
        }
      }
      console.error(`hub:verify-live: ${error.stack ?? error.message}`);
      process.exit(1);
    },
  );
}
