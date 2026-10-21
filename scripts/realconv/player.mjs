// The scene player for `npm run hub:realconv` (docs/REALCONV.md). It drives the real hub through the realtest bench's
// window driver (scripts/hub-realtest.mjs: the room's composer, a Mono's or a chat's composer, Today), the same calls
// Ash's typing uses. Ash's opening is sent verbatim; every later line comes from the tester model reading what the
// agents actually said. Then the hard checks read the host's state, the judge scores the transcript, and the verdict
// is computed (scripts/realconv/judge.mjs). Evidence: <out>/<scene>/{transcript.md, evidence.json, tester.ndjson,
// result.json}.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { roomMessages } from "../hub-realtest-scenarios.mjs";
import { nextAshMove, scriptedProblem } from "./ash.mjs";
import { hardChecks, SEAT_IDS } from "./checks.mjs";
import { judgeScene, verdict } from "./judge.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ms = (value) => (typeof value === "number" ? value : value ? Date.parse(value) : 0);

/** The app's own notices for Ash in a chat's blocks ("waiting-on-you"), each with the time it was first seen. */
export function appNoticeLines(blocks, seen, now) {
  const out = [];
  for (const block of blocks ?? []) {
    if (block?.role !== "system" || block.notice !== "waiting-on-you" || !block.text) continue;
    if (!seen.has(block.id)) seen.set(block.id, now);
    out.push({ t: seen.get(block.id), text: block.text });
  }
  return out;
}

const SETTLED_STATES = new Set(["completed", "failed", "cancelled"]);
/**
 * A handoff started in this scene that hasn't settled: the room isn't done while one runs (S10 on Grok: the room went
 * quiet for 40 s while the Lead's workers ran, the scene ended at +3 min, and the review at +8 min was never judged).
 */
export function handoffsOpen(rows, since) {
  return rows.some((row) => ms(row.created_at) >= since - 1000 && !SETTLED_STATES.has(String(row.state)));
}
const rel = (t, t0) => `+${Math.round((t - t0) / 1000)}s`;
const STUCK = /stuck|waiting|needs? you|needs-you|question|permission|approv|blocked|failed|paused|out of credit|limit/i;

/** Every branch and tag, but not the hub's own turn checkpoints (refs/monocode/checkpoints/...): those are parentless
 * snapshots of the whole tree, so counting them made a scene that touched nothing list every file as changed. */
export const ALL_BUT_CHECKPOINTS = ["--exclude=refs/monocode/*", "--all"];

/** Whether the tester is shown the screen's buttons: a scene about clicking, or a chat held on Ash (a card to answer). */
export function shouldOfferButtons(scene, state) {
  return !!scene.clicks || !!state?.stuck;
}

/** The project's refs and worktrees now: where to measure changes from. */
export function gitMark(project) {
  try {
    const refs = execFileSync("git", ["for-each-ref", "--format=%(objectname)"], { cwd: project, encoding: "utf8" }).split("\n").filter(Boolean);
    return { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim(), refs: [...new Set(refs)] };
  } catch {
    return null;
  }
}

/** Files the agents changed since the mark: new commits on any branch, and uncommitted edits in every checkout. */
export function gitChanges(project, mark) {
  if (!mark) return { changed: [], diff: "", checkouts: [] };
  const run = (args, cwd = project) => {
    const out = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return out.status === 0 ? out.stdout : "";
  };
  const checkouts = run(["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const changed = new Set();
  let diff = "";
  const committed = run(["log", ...ALL_BUT_CHECKPOINTS, "--format=", "--name-only", "-p", "--not", ...mark.refs]);
  diff += committed;
  for (const line of run(["log", ...ALL_BUT_CHECKPOINTS, "--format=", "--name-only", "--not", ...mark.refs]).split("\n")) if (line.trim()) changed.add(line.trim());
  for (const dir of checkouts.length ? checkouts : [project]) {
    for (const line of run(["status", "--porcelain"], dir).split("\n")) if (line.trim()) changed.add(`${path.relative(project, dir) || "."}: ${line.slice(3).trim()}`);
    diff += run(["diff", "HEAD"], dir);
  }
  return { changed: [...changed], diff: diff.slice(0, 400_000), checkouts };
}

/** The project's own tests where Ash would look (the main checkout), and in each other checkout. */
export function projectTests(project, command, checkouts = []) {
  if (!command) return null;
  const run = (cwd) => {
    const out = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
    return { cwd, code: out.status ?? 1, tail: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n") };
  };
  const main = run(project);
  const others = checkouts.filter((dir) => path.resolve(dir) !== path.resolve(project)).map(run);
  return { command, code: main.code, tail: main.tail, worktrees: others, passesSomewhere: [main, ...others].some((r) => r.code === 0) };
}

/**
 * One scene. `ctx` is the realtest bench's (act, events, pump, claudeTexts, delegationRows, monoSession, usage, log,
 * leadId, roomId, project, spec, deadline, state). `tester` and `judge` are llm.mjs clients; `agentsReal` says whether
 * the hub's own agents ran on a real model (a fake app model is only for the runner's own tests).
 */
export async function runConversation(scene, ctx, { tester, judge, agentsReal, out, rubric, runScenario }) {
  const { act, events, log } = ctx;
  const dir = path.join(out, scene.id);
  fs.mkdirSync(dir, { recursive: true });
  const testerLog = (entry) => fs.appendFileSync(path.join(dir, "tester.ndjson"), `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
  const notes = [];
  const t0 = Date.now();
  const stopAt = Math.min(ctx.deadline + 5 * 60_000, t0 + (scene.minutes ?? 12) * 60_000);
  const turnsCap = scene.maxTurns ?? 60;
  const mark = gitMark(ctx.project);
  // Ash's real repos the scene works on, as throwaway copies (the book's `copies`).
  const copyMarks = (ctx.copies ?? []).map((copy) => ({ copy, mark: gitMark(copy.folder) }));
  // The chat screen as Ash sees it, for a design reviewer: after each reply settles, and at the end.
  const screens = [];
  // The place Ash is talking in, on screen (the room, the Mono's chat, the coding-team chat), as he'd have it open.
  const showPlace = async () => {
    const where = place.room ? { hub: { project: ctx.spec.project.id, item: "leadership-team" }, settleMs: 1200 } : place.mono ? { mono: place.mono } : place.session ? { session: place.session } : null;
    if (where) await act("open", where, 30_000).catch(() => null);
  };
  const shoot = async (name) => {
    if (!ctx.screenshot) return;
    // A click's own result (a preview, a dialog) stays as it is; every other shot shows the place first.
    if (!name.startsWith("click")) await showPlace();
    const shot = await ctx.screenshot(`${scene.id}-${name}`).catch((error) => ({ ok: false, why: error.message }));
    screens.push({ name, t: Date.now(), ...shot });
  };
  const monosBefore = new Set(((await act("snapshot").catch(() => null))?.monos ?? []).map((m) => m.id));

  // -- setup: the bench's own scripted steps (a decision made earlier, a job to talk about), recorded as setup ---------
  let chats = {};
  if (scene.setup?.length) {
    log(`  ${scene.id} setup: ${scene.setup.length} steps`);
    const setup = await runScenario({ id: `${scene.id}-setup`, title: `${scene.id} setup`, steps: scene.setup, minutes: Math.max(3, Math.round((stopAt - Date.now()) / 60_000) - 2), maxTurns: turnsCap }, ctx);
    chats = setup.chats ?? {};
    notes.push(...(setup.notes ?? []).map((n) => `setup: ${n}`));
  }

  // -- where Ash writes ------------------------------------------------------------------------------------------------
  const resolve = async (to) => {
    if (to.room) return { room: to.room === "room" ? ctx.roomId : to.room };
    if (to.mono) return { mono: to.mono === "lead" ? ctx.leadId : to.mono };
    if (to.chat) return chats[to.chat] ? { session: chats[to.chat] } : null;
    if (to.codingTeam) return { codingTeam: to.codingTeam === "project" ? ctx.spec.project.id : to.codingTeam };
    return null;
  };
  let place = await resolve(scene.openingTo ?? scene.place);
  if (!place) return finish({ invalid: `no place to send the opening (${JSON.stringify(scene.openingTo ?? scene.place)})` });
  const placeSession = async () => (place.session ? place.session : place.mono ? ctx.monoSession(place.mono) : null);

  // Lines the app itself writes into the chat for Ash (a "Waiting on you" notice), first seen at.
  const noticeSeen = new Map();
  const appNotices = async (session) => {
    if (!session || !ctx.sessionBlocks) return [];
    const blocks = await ctx.sessionBlocks(session).catch(() => []);
    return appNoticeLines(blocks, noticeSeen, Date.now());
  };

  const ashLines = [];
  const clicks = [];
  const send = async (text, { verbatim }) => {
    // A coding-team scene may start its chat in Full access (scene.runtimeMode; dev copy only, never Ash's default).
    const mode = place.codingTeam && scene.runtimeMode ? { runtimeMode: scene.runtimeMode } : {};
    const answer = await act("send", { to: place, text, ...mode }, 60_000).catch((error) => ({ ok: false, error: error.message }));
    const t = answer.at ?? Date.now();
    // A new coding-team chat: later lines go to that chat, not another new one.
    if (place.codingTeam && answer.session) place = { session: answer.session };
    ashLines.push({ t, text, verbatim, scripted: !!scriptedProblem(text), accepted: answer.ok !== false, error: answer.error ?? null });
    log(`  Ash -> ${place.room ?? place.mono ?? place.session}: ${text.slice(0, 90).replace(/\n/g, " ")}${answer.ok === false ? ` (NOT ACCEPTED: ${answer.error})` : ""}`);
    return t;
  };

  // -- what Ash can see, and whether something is stuck -------------------------------------------------------------------
  const stuckSeen = [];
  const lookedAtToday = new Set();
  const seenNow = async () => {
    await ctx.pump();
    const lines = ashLines.map((l) => ({ t: l.t, who: "Ash", text: l.text }));
    if (place.room) {
      for (const m of roomMessages(events, place.room, t0)) if (m.from !== "ash") lines.push({ t: m.t, who: m.from, text: m.text });
    } else {
      const session = await placeSession();
      for (const line of await ctx.claudeTexts(t0)) {
        if (line.session !== session || line.result) continue;
        const asked = (line.tools ?? []).filter((tool) => String(tool).startsWith("AskUserQuestion:"));
        if (line.text) lines.push({ t: line.t, who: "agent", text: line.text.slice(0, 2500) });
        if (asked.length) lines.push({ t: line.t, who: "agent (buttons)", text: asked.join(" ; ").replace(/AskUserQuestion: /g, "") });
      }
      for (const notice of await appNotices(session)) lines.push({ t: notice.t, who: "app", text: notice.text });
    }
    return lines.sort((a, b) => a.t - b.t);
  };
  const sample = async () => {
    const snap = await act("snapshot").catch(() => null);
    if (!snap) return { busy: "", stuck: "" };
    const busy = (snap.sessions ?? []).filter((s) => s.busy);
    // Stuck: a chat waiting on someone (a question, an approval, a limit, a failure, a pause), or a handoff whose worker
    // asked a question or failed (the delegations table).
    const rows = await ctx.delegationRows().catch(() => []);
    const stuckRows = rows.filter((r) => ms(r.updated_at) >= t0 && (r.state === "question" || r.state === "failed" || r.pending_question));
    const stuck = [
      ...(snap.sessions ?? []).filter((s) => s.question || s.usageLimit || s.approvals > 0 || ["needs-you", "failed", "paused"].includes(s.monoState?.status)),
      ...stuckRows.map((r) => ({ id: r.child_session ?? r.id, title: `${r.title ?? "a handoff"} (${r.state})` })),
    ];
    const marks = (snap.dom?.elements ?? []).filter((e) => e.visible && (STUCK.test(e.text ?? "") || Object.values(e.attrs ?? {}).some((v) => STUCK.test(String(v)))));
    for (const s of stuck) {
      // Ash would look at Today once something is stuck: open it once per stuck chat and keep what it shows.
      let today = [];
      if (!lookedAtToday.has(s.id)) {
        lookedAtToday.add(s.id);
        const view = await act("open", { hub: { project: "today", item: "inbox" }, settleMs: 1500 }, 30_000).catch(() => null);
        today = (view?.dom?.elements ?? []).filter((e) => e.visible && STUCK.test(`${e.text ?? ""} ${Object.values(e.attrs ?? {}).join(" ")}`));
        fs.writeFileSync(path.join(dir, `today-${s.id}.json`), JSON.stringify(view?.dom ?? null, null, 2));
      }
      stuckSeen.push({ t: Date.now(), session: s.id, title: s.title, visible: marks.length > 0 || today.length > 0, where: [...marks, ...today].slice(0, 5).map((e) => e.text?.slice(0, 120)) });
    }
    return { busy: busy.length ? `${busy.length} chat(s) working` : "", stuck: stuck.length ? stuck.map((s) => s.title ?? s.id).join(", ") : "" };
  };

  /** Until the place has answered Ash's last line and gone idle, or `until` (ms) passes. */
  const settle = async (since, until) => {
    while (Date.now() < until && Date.now() < stopAt) {
      await ctx.pump();
      if (ctx.usage(t0).turns >= turnsCap) {
        notes.push(`turn budget (${turnsCap}) reached`);
        return false;
      }
      if (place.room) {
        const msgs = roomMessages(events, place.room, since).filter((m) => m.from !== "ash");
        const typing = events.filter((e) => e.kind === "room-typing" && e.room === place.room).at(-1);
        const last = Math.max(since, ...msgs.map((m) => m.t), typing?.t ?? 0);
        if (msgs.length && !typing?.who && Date.now() - last >= (scene.quietSec ?? 40) * 1000) {
          // Quiet, but its handoffs still run: their reports and the review are part of the scene.
          if (!handoffsOpen(await ctx.delegationRows().catch(() => []), t0)) return true;
        }
      } else {
        const session = await placeSession();
        if (session && (await ctx.claudeTexts(since)).some((line) => line.session === session && line.result)) return true;
        // The app answered for a chat held on Ash's OK: that is the reply he gets until he decides.
        if ((await appNotices(session)).some((notice) => notice.t > since)) return true;
      }
      await sleep(2_000);
    }
    return false;
  };

  // -- the conversation --------------------------------------------------------------------------------------------------
  let invalid = null;
  let last = await send(scene.opening, { verbatim: true });
  let midSent = false;
  const midAt = scene.midChange ? t0 + scene.midChange.afterSec * 1000 : null;
  const maxAsh = scene.maxAshTurns ?? 4;
  while (Date.now() < stopAt) {
    const watch = scene.ashSilentAfterOpening ? Math.min(stopAt, t0 + (scene.watchSec ?? 900) * 1000) : Math.min(stopAt, Date.now() + 300_000);
    await settle(last, midAt && !midSent ? Math.min(watch, midAt) : watch);
    await shoot(`reply-${ashLines.length}`);
    const state = await sample();
    if (midAt && !midSent && Date.now() >= midAt) {
      // Alfred's own mid-work line (S3): sent as written, while the work runs.
      midSent = true;
      last = await send(scene.midChange.text, { verbatim: true });
      continue;
    }
    if (scene.ashSilentAfterOpening) break;
    if (ashLines.length >= maxAsh) {
      await settle(last, Math.min(stopAt, Date.now() + 240_000));
      break;
    }
    const seen = await seenNow();
    // A scene with `clicks` lets Ash use the buttons on screen (Apply, Discard, Undo, Cancel); never a delete. So does a
    // chat held on something only he can answer (an Allow/Deny card): in AD14 (run f451) the Hivra chat sat on a Bash
    // card and the tester, given no buttons, told it three times "there's no button to click".
    const offerButtons = shouldOfferButtons(scene, state);
    // The stuck check may have opened Today; put the place back on screen before reading its buttons.
    if (offerButtons && state.stuck) await showPlace();
    const buttons = offerButtons ? ((await act("buttons").catch(() => null))?.buttons ?? []) : undefined;
    const move = await nextAshMove(tester, scene, seen.map((l) => ({ who: l.who, text: l.text })), { elapsedSec: (Date.now() - t0) / 1000, ashTurns: ashLines.length, maxAshTurns: maxAsh, busy: state.busy, stuck: state.stuck, buttons }).catch((error) => ({ action: "invalid", refused: [`tester failed: ${error.message}`] }));
    testerLog({ move });
    if (move.action === "invalid") {
      invalid = `the tester couldn't write Ash's next line: ${move.refused.join(" | ")}`;
      break;
    }
    if (move.action === "done") break;
    if (move.action === "wait") {
      await sleep(20_000);
      continue;
    }
    if (move.action === "click") {
      const clicked = await act("click", { label: move.label }).catch((error) => ({ ok: false, error: error.message }));
      clicks.push({ t: Date.now(), label: move.label, ok: clicked.ok !== false, error: clicked.error ?? null });
      log(`  Ash clicks "${move.label}"${clicked.ok === false ? ` (FAILED: ${clicked.error})` : ""}`);
      await shoot(`click-${clicks.length}`);
      if (clicks.length >= 8) break;
      continue;
    }
    last = await send(move.text, { verbatim: false });
  }
  return finish({ invalid });

  // -- evidence, checks, judge, verdict ------------------------------------------------------------------------------------
  async function finish({ invalid: why }) {
    await ctx.pump();
    await shoot("end");
    const ended = Date.now();
    const snap = await act("snapshot").catch(() => null);
    const rows = (await ctx.delegationRows()).filter((row) => ms(row.created_at) >= t0 - 1000 || ms(row.updated_at) >= t0);
    const workers = new Set(rows.map((row) => row.child_session).filter(Boolean));
    const monoOf = Object.fromEntries((snap?.monos ?? []).filter((m) => m.sessionId).map((m) => [m.sessionId, m.id]));
    const texts = (await ctx.claudeTexts(t0)).map((line) => ({ ...line, who: monoOf[line.session] ?? (workers.has(line.session) ? "worker" : line.session ? `chat ${line.session.slice(0, 8)}` : "app helper call") }));
    const room = roomMessages(events, ctx.roomId, t0);
    const toAsh = [];
    const toAshAll = [
      ...room.filter((m) => m.from !== "ash").map((m) => ({ t: m.t, who: m.from, where: "room", text: m.text ?? "" })),
      // A room turn's or a Mono message's NO_REPLY is folded by the app into "nothing new to add" (RoomNoteCard): silence, not words to Ash.
      ...texts.filter((l) => l.text && !l.result && l.who !== "worker" && l.who !== "app helper call" && !(l.hidden && /^\W*NO_REPLY\W*$/i.test(l.text.trim()))).map((l) => ({ t: l.t, who: l.who, where: "chat", text: l.text, midTurn: (l.tools ?? []).length > 0 })),
      ...(place.room ? [] : (await appNotices(await placeSession())).map((n) => ({ t: n.t, who: "app", where: "chat", text: n.text }))),
    ].sort((a, b) => a.t - b.t);
    const shown = dropRoomEchoes(toAshAll);
    toAsh.length = 0;
    toAsh.push(...shown);
    const leaks = (ctx.spec.leak ?? []).flatMap((pattern) => [...toAsh, ...texts.filter((l) => l.text)].filter((m) => new RegExp(pattern, "i").test(m.text)).map((m) => ({ pattern, who: m.who, text: m.text.slice(0, 200) })));
    const changes = gitChanges(ctx.project, mark);
    const tests = scene.expect?.projectTests ? projectTests(ctx.project, scene.expect.projectTests, changes.checkouts) : null;
    const lastRoom = room.at(-1)?.t ?? t0;
    const hard = hardChecks({
      toAsh,
      ashLines,
      delegations: rows,
      stuckSeen,
      workerRoomPosts: room.filter((m) => m.from && !SEAT_IDS.has(m.from) && m.from !== ctx.leadId),
      leaks,
      git: changes,
      tests: tests && { ...tests, code: tests.passesSomewhere ? 0 : tests.code },
      expect: scene.expect ?? {},
      sessionsStarted: events.filter((e) => e.kind === "session-new" && e.t >= t0).map((e) => ({ session: e.session, title: e.title, mono: e.mono })),
      newMonos: (snap?.monos ?? []).filter((m) => !monosBefore.has(m.id)).map((m) => (m.name ? `${m.name} (${m.id})` : m.id)),
      roomEnded: scene.expect?.roomEnds ? ended - lastRoom >= (scene.quietSec ?? 60) * 1000 : null,
    });
    const triggered = scene.triggeredBy === "stuck" ? stuckSeen.length > 0 : true;
    const copies = copyMarks.map(({ copy, mark: copyMark }) => ({ name: copy.name, folder: copy.folder, ...copyLog(copy.folder, copyMark), changes: gitChanges(copy.folder, copyMark) }));
    const transcriptText = transcript(scene, { t0, ashLines, toAsh, texts, rows, changes, tests, stuckSeen, notes, copies, clicks });
    fs.writeFileSync(path.join(dir, "transcript.md"), transcriptText);
    const judged = why || !triggered ? null : await judgeScene(judge, scene, transcriptText, hard, rubric);
    const provenance = { agents: agentsReal === true, tester: tester.real === true, judge: judge.real === true };
    const result = { id: scene.id, title: scene.title, started: t0, ended, minutes: Math.round((ended - t0) / 600) / 100, provenance, screens, ...verdict({ hard, judged, provenance, invalid: why ?? (ashLines.some((l) => l.scripted) ? "a line sent as Ash was scripted" : null), triggered }), hard, judged, notes };
    fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ ashLines, toAsh, texts, delegations: rows, stuckSeen, changes: { ...changes, diff: changes.diff.slice(0, 50_000) }, tests, notes }, null, 2));
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
    log(`  ${scene.id}: ${result.verdict}${result.wouldBe ? ` (would be ${result.wouldBe})` : ""}${result.reasons?.length ? `: ${result.reasons.slice(0, 2).join("; ")}` : ""}`);
    return result;
  }
}

/** What a person and the judge read: every line in time order, then the host's facts. */
/**
 * A seat's room turn runs in its own chat, so the same words show up as its chat text and as its room post. Ash sees
 * them once, in the room: the chat copy is dropped.
 */
export function dropRoomEchoes(lines) {
  const key = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const roomPosts = lines.filter((l) => l.where === "room");
  const echoed = (l) => key(l.text) && roomPosts.some((r) => r.who === l.who && Math.abs(r.t - l.t) < 120_000 && String(r.text).replace(/\s+/g, " ").includes(key(l.text).slice(0, 80)));
  return lines.filter((l) => l.where !== "chat" || !echoed(l));
}

/** A copy's new commits since the mark, one line each (what landed on which branch). */
export function copyLog(folder, mark) {
  if (!mark) return { commits: [] };
  const out = spawnSync("git", ["log", ...ALL_BUT_CHECKPOINTS, "--format=%h %D | %s", "--not", ...mark.refs], { cwd: folder, encoding: "utf8" });
  return { commits: out.status === 0 ? out.stdout.split("\n").filter(Boolean).slice(0, 40) : [] };
}

export function transcript(scene, { t0, ashLines, toAsh, texts, rows, changes, tests, stuckSeen, notes, copies = [], clicks = [] }) {
  const timeline = [
    ...clicks.map((c) => ({ t: c.t, line: `**Ash clicks** "${c.label}"${c.ok ? "" : ` (it didn't take: ${c.error})`}` })),
    ...ashLines.map((l) => ({ t: l.t, line: `**Ash**${l.verbatim ? " (his own words)" : ""}${l.accepted ? "" : ` (NOT accepted: ${l.error})`}: ${l.text}` })),
    ...toAsh.map((m) => ({ t: m.t, line: `[${m.where}] **${m.who}**: ${m.text}` })),
    ...texts.filter((l) => l.who === "worker" && l.text).map((l) => ({ t: l.t, line: `[worker chat, Ash doesn't read this] ${l.text.slice(0, 600)}` })),
    ...texts.filter((l) => (l.tools ?? []).some((tool) => String(tool).startsWith("AskUserQuestion:"))).map((l) => ({ t: l.t, line: `[${l.who}] asks with buttons: ${(l.tools ?? []).filter((x) => String(x).startsWith("AskUserQuestion:")).join(" ; ")}` })),
    ...stuckSeen.map((s) => ({ t: s.t, line: `(the hub shows ${s.title ?? s.session} stuck; visible to Ash: ${s.visible ? `yes (${s.where.join(" | ")})` : "NO"})` })),
  ].sort((a, b) => a.t - b.t);
  return [
    `# ${scene.id}: ${scene.title}`,
    "",
    "## Timeline",
    "",
    ...timeline.map((e) => `- ${rel(e.t, t0)} ${e.line.replace(/\n+/g, " / ")}`),
    "",
    "## Handoffs (delegation rows)",
    "",
    ...rows.map((r) => `- ${r.id}: ${r.owner_mono ?? r.owner_session} -> ${r.child_session} "${r.title ?? ""}" state ${r.state}${r.goal ? ` goal "${String(r.goal).slice(0, 120)}"` : ""}${r.result ? ` result: ${String(r.result).slice(0, 300).replace(/\n/g, " ")}` : ""}`),
    "",
    "## The project after the scene",
    "",
    `Files changed: ${changes.changed.length ? changes.changed.join(", ") : "none"}`,
    ...copies.flatMap((c) => [
      "",
      `## ${c.name} (throwaway copy) after the scene`,
      "",
      `Files changed: ${c.changes.changed.length ? c.changes.changed.slice(0, 60).join(", ") : "none"}`,
      c.commits.length ? `New commits:\n${c.commits.map((line) => `- ${line}`).join("\n")}` : "New commits: none",
      c.changes.diff ? `\n\`\`\`diff\n${c.changes.diff.slice(0, 6000)}\n\`\`\`` : "",
    ]),
    tests ? `Tests (\`${tests.command}\`): exit ${tests.code} in the main checkout${tests.worktrees?.length ? `; ${tests.worktrees.map((w) => `exit ${w.code} in ${w.cwd}`).join("; ")}` : ""}\n\n\`\`\`\n${tests.tail}\n\`\`\`` : "",
    notes.length ? `\n## Harness notes\n\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    "",
  ].join("\n");
}
