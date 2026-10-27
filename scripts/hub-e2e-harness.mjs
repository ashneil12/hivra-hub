#!/usr/bin/env node
// The harness end to end, on a dev copy with its own data folder (first written as the 23 Oct blind QA runner, kept in
// the repo from r56): Leadership hands Ash's ask to the project's Lead, the Lead's worker edits the repo for real, a
// Mono answers "what's running" mid-job (the progress check), and the report comes back to the room; then two workers
// in parallel with an aside answered while they run.
// Uses the repo's own runBench (scripts/hub-realtest.mjs): throwaway HOME, dev identifier
// com.ash.monocode-hub.dev.<slot>, the DeepSeek subscription launcher for every chat.
// Never touches the daily app or its data: everything the app writes lands under a mkdtemp HOME.
//
// Coverage: scorecard D5, A1, A3, A11, H6, B9, H13.
//
//   node scripts/hub-e2e-harness.mjs            (evidence under $MONOCODE_E2E_OUT, default <tmp>/monocode-e2e)
//
// Evidence: <out>/<runId>/ — runBench's own artifacts (events.ndjson, snapshots, app log,
// claude ndjson, db copy) plus qa/<test>/evidence.json + transcript.md + dom dumps per test.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBench } from "./hub-realtest.mjs";

const SLOT = process.env.MONOCODE_E2E_SLOT || "monocode-hub-e2e";
const DEV_PREFIX = "com.ash.monocode-hub.dev.";
const OUT = process.env.MONOCODE_E2E_OUT || path.join(os.tmpdir(), "monocode-e2e");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The bench spec: Tally as the test project, the same invented memory the baseline bench uses. */
const SPEC = {
  version: 1,
  about: "Blind QA verification (dev copy, DeepSeek subscription): scorecard D5, A1, A3, A11, H6, B9, H13.",
  project: { id: "tally", name: "Tally", shortName: "Tally" },
  model: "sonnet",
  appModel: "claude:sonnet-5",
  effort: "medium",
  memory: {
    tally: [
      "Tally's accent colour is teal #0F766E; the board uses it for the +1 button and the streak badge (Ash, 18 Oct).",
      "The weekly board week starts on Monday, Europe/London time (Ash, 18 Oct).",
    ],
    ash: [
      "Ash writes lowercase and fast; answer in plain English, outcome first, short.",
      "Never use em dashes in anything written to Ash.",
      "Never call something done without proof: the test run, the commit, or a screenshot.",
    ],
  },
  budget: { maxTurns: 600, maxRequests: 4000, maxMinutes: 150 },
  scenarios: [],
};

/** The things only the run itself can know, found once the bench is up. */
const env = {};

function findDataDir(home) {
  const support = path.join(home, "Library/Application Support");
  for (const name of fs.existsSync(support) ? fs.readdirSync(support) : []) {
    if (name.startsWith(DEV_PREFIX)) return path.join(support, name);
  }
  return null;
}

/** The stub's throwaway token: <temp home>/.monocode-hub-dev/slots/<slot>/hub-token (or the real home for hub:dev slots). */
function readHubToken(tempHome) {
  for (const base of [tempHome, os.homedir()]) {
    const file = path.join(base, ".monocode-hub-dev/slots", SLOT, "hub-token");
    if (fs.existsSync(file)) return { file, token: fs.readFileSync(file, "utf8").trim() };
  }
  return null;
}

/** The stub listens in this same process (runBench imports it): find its port by probing our own listeners. */
async function findStubPort() {
  const out = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(process.pid)], { encoding: "utf8" });
  const ports = [...String(out.stdout ?? "").matchAll(/TCP\s+(?:\*|127\.0\.0\.1|localhost):(\d+)\s+\(LISTEN\)/g)].map((m) => Number(m[1]));
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      if (body?.service === "hub-stub") return port;
    } catch {
      /* not the stub */
    }
  }
  return null;
}

async function stubAct(name, body) {
  const res = await fetch(`http://127.0.0.1:${env.stubPort}/api/ash-hub-${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.token.token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`stub ${name}: ${data.error ?? res.status}`);
  return data.result;
}

// ---- small harness -------------------------------------------------------------------------------------------------

function makeHelpers(ctx, stopped) {
  const act = async (op, payload = {}, timeoutMs = 60_000) => {
    try {
      return await ctx.act(op, payload, timeoutMs);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  const snap = () => act("snapshot", {}, 90_000);
  const delegations = () => ctx.delegationRows();
  const monos = async () => (await snap()).monos ?? [];
  const rooms = async () => (await snap()).rooms ?? [];
  const waitFor = async (read, { timeoutMs = 60_000, everyMs = 2_000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const value = await read();
        if (value) return value;
      } catch {
        /* keep polling */
      }
      if (Date.now() > deadline || stopped()) return null;
      await sleep(everyMs);
    }
  };
  /** Timestamped room messages from the driver's own log (it ticks the whole window every ~400 ms). */
  const roomEvents = (roomId, since = 0) =>
    ctx.events.filter((e) => e.t >= since && (e.kind === "room-message" || e.kind === "room-draft") && e.room === roomId);
  /** Timestamped session-state events for one chat. */
  const sessionEvents = (sessionId, since = 0) => ctx.events.filter((e) => e.t >= since && e.kind !== "room-typing" && e.session === sessionId);
  const monoSession = (monoId) => ctx.monoSession(monoId);
  const sessionBusy = async (sessionId) => {
    const s = await snap();
    return s.sessions?.find((x) => x.id === sessionId)?.busy ?? false;
  };
  const write = (rel, data) => {
    const file = path.join(ctx.evidence, "qa", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
    return file;
  };
  const dumpSnap = async (name) => write(name, await snap());
  const viewDom = async (hubSel, name, settleMs = 2500) => {
    const res = await act("open", { hub: hubSel, settleMs }, 60_000);
    if (res?.dom) write(`${name}.json`, res.dom);
    if (res?.dom?.mainText) write(`${name}.txt`, res.dom.mainText);
    if (res?.dom?.bodyText) write(`${name}-body.txt`, res.dom.bodyText);
    return res?.dom ?? null;
  };
  /** A Mono's own chat on screen, then the DOM it shows. */
  const monoDom = async (monoId, name, settleMs = 2500) => {
    await act("open", { mono: monoId }, 60_000);
    await sleep(settleMs);
    const s = await snap();
    if (s?.dom) write(`${name}.json`, s.dom);
    if (s?.dom?.mainText) write(`${name}.txt`, s.dom.mainText);
    return s?.dom ?? null;
  };
  const sessionDump = async (sessionId, name) => {
    if (!sessionId) return null;
    const blocks = await ctx.sessionBlocks(sessionId).catch(() => []);
    write(name, blocks);
    return blocks;
  };
  /** Everything an agent wrote: room messages + every assistant line the wrapper logged. */
  const texts = async () => {
    const lines = [];
    for (const e of ctx.events)
      if (e.kind === "room-message" && e.from && e.from !== "ash") lines.push({ t: e.t, where: `room:${e.room}`, from: e.from, text: e.text });
    const claude = await ctx.claudeTexts().catch(() => []);
    for (const line of claude)
      if (line.text && !line.hidden) lines.push({ t: line.t, where: `claude:${line.session ?? line.pid}`, from: "assistant", text: line.text });
    return lines;
  };
  /** Does a dom dump show the mono_create draft card? */
  const draftInDom = (dom) =>
    (dom?.elements ?? []).find((e) => Object.keys(e.attrs).some((a) => a === "data-mono-draft" || a === "data-mono-draft-in-chat")) ?? null;
  return { act, snap, delegations, monos, rooms, waitFor, roomEvents, sessionEvents, monoSession, sessionBusy, write, dumpSnap, viewDom, monoDom, sessionDump, texts, draftInDom };
}

// Words a blind run must never hear (it isn't a test to them).
const TEST_WORDS = /\btest fault\b|dev-faults|on purpose for a test|set to fail|\bbenchmark\b|\bscorecard\b|\bblind (?:test|run|qa)\b|\bthe tester\b|\brealtest\b|marked test residue|old test card/i;
// The bench's own throwaway folder (monocode-realtest-*) shows up in honest worktree paths; that is not the app saying "test".
const isTestWording = (text) => TEST_WORDS.test(String(text ?? "").replace(/\S*monocode-realtest-\S*/g, ""));
const HE_WORDS = /\b(?:he|him)\b/i;

const stamp = () => new Date().toISOString().slice(11, 19);
const esc = (s) => String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- D5: a Lead's workers keep failing; the job goes red Needs you ----------------------------------------------------

async function testD5(ctx, h) {
  const dir = "d5";
  const log = [];
  const say = (line) => { log.push(`[${stamp()}] ${line}`); ctx.log(`[d5] ${line}`); };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail ?? "" }); say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const out = { id: "D5", title: "A Lead's workers keep failing; the job goes red Needs you with the reason and Open <Lead>'s chat", checks, evidence: {} };

  say(`armed ${env.faultFile} (count 3); asking the Tally lead for a small worker job`);
  const t0 = Date.now();
  const sent = await h.act("send", { to: { mono: "tally-lead" }, text: "hey can u get a worker onto the stats test thats red on tally, keep it a small fix" });
  h.write(`${dir}/sent.txt`, "hey can u get a worker onto the stats test thats red on tally, keep it a small fix\n");
  out.evidence.leadSession = sent.session;
  const leadSession = sent.session;

  // A delegated worker starts.
  const first = await h.waitFor(
    async () => (await h.delegations()).find((r) => ["running", "failed", "completed", "cancelled"].includes(r.state)),
    { timeoutMs: 4 * 60_000 },
  );
  check("a delegated worker started", !!first, first ? `row ${first.id} (${first.title})` : "no delegation row in 4 min");

  // Watch the failure cycle until the Lead is idle with nothing left running — held steady for 25 s so a gap between
  // retries doesn't end the watch early.
  const seen = new Map();
  const deadline = Date.now() + 16 * 60_000;
  let calmSince = null;
  let leadIdleAfterFailure = false;
  if (first) for (;;) {
    const rows = await h.delegations();
    for (const row of rows) {
      const prev = seen.get(row.id);
      const sig = `${row.state}|${row.delivery}|${row.error}`;
      if (prev !== sig) {
        seen.set(row.id, sig);
        say(`row ${row.id} "${String(row.title).slice(0, 60)}": ${row.state}${row.error ? ` (${String(row.error).split("\n")[0].slice(0, 100)})` : ""} delivery=${row.delivery}`);
      }
    }
    const open = rows.filter((r) => r.state === "running" || r.state === "question");
    const failed = rows.filter((r) => r.state === "failed");
    const busy = leadSession ? await h.sessionBusy(leadSession) : false;
    const calm = !open.length && failed.length > 0 && !busy;
    if (calm) {
      calmSince ??= Date.now();
      if (Date.now() - calmSince > 25_000) { leadIdleAfterFailure = true; break; }
    } else calmSince = null;
    if (Date.now() > deadline) break;
    await sleep(4_000);
  }
  out.evidence.rows = await h.delegations();
  h.write(`${dir}/delegations.json`, out.evidence.rows);

  const failed = out.evidence.rows.filter((r) => r.state === "failed");
  const plain = failed.filter((r) => /stopped with an error\.?/i.test(String(r.error ?? "")));
  check("worker(s) faulted with the plain error", plain.length > 0, plain.map((r) => `${r.id} after ${Math.round(((r.settled_at ?? r.updated_at) - r.created_at) / 1000)}s`).join("; ") || `${failed.length} failed, errors: ${failed.map((r) => String(r.error).slice(0, 60)).join(" | ")}`);
  check("the fault came ~20 s in (not at the end of the job)", plain.some((r) => { const d = ((r.settled_at ?? r.updated_at) - r.created_at) / 1000; return d >= 10 && d <= 90; }), plain.map((r) => `${Math.round(((r.settled_at ?? r.updated_at) - r.created_at) / 1000)}s`).join(","));

  const leftover = fs.existsSync(env.faultFile) ? fs.readFileSync(env.faultFile, "utf8") : null;
  check("the armed fault file was spent", !leftover || /(^|\n)0\s*$/m.test(leftover), leftover ? `still reads ${JSON.stringify(leftover)}` : "file gone");
  // Belt and braces: nothing left armed may poison later tests.
  try { fs.rmSync(env.faultFile, { force: true }); } catch { /* gone already */ }

  check("the Lead's turn ended after the failures", leadIdleAfterFailure, "");
  // The faulted work is never relayed as done (the r45/r49 bug).
  const doneOverFail = out.evidence.rows.filter((r) => r.state === "completed" && /stats|test/i.test(`${r.title} ${r.brief} ${r.goal} ${r.result}`));
  check("no failed worker reported as done", doneOverFail.length === 0, doneOverFail.map((r) => r.id).join(","));
  const leadText = (await h.sessionDump(leadSession, `${dir}/lead-chat-blocks.json`)) ?? [];
  const leadSaidDone = leadText.filter((b) => b.role === "assistant" && /done|fixed|sorted|shipped|all green/i.test(String(b.text ?? "")) && !/fail|stopped|error|didn'?t|couldn'?t|gave up|needs you/i.test(String(b.text ?? "")));
  check("the Lead never told Ash it was done", leadSaidDone.length === 0, leadSaidDone.map((b) => String(b.text).slice(0, 120)).join(" | "));

  // What Ash sees: the rail, Being built and Today must carry the red Needs you with the reason and Open <Lead>'s chat.
  await ctx.pump();
  const rail = await dumpSnapAll(h, `${dir}/snapshot-final`);
  const built = await h.viewDom({ project: "tally", item: "being-built" }, `${dir}/view-being-built`, 3000);
  const today = await h.viewDom({ project: "today", item: "inbox" }, `${dir}/view-today`, 3000);
  const leadDom = await h.monoDom("tally-lead", `${dir}/view-lead`, 3000);
  const allText = [rail, built, today, leadDom].map((d) => `${d?.mainText ?? ""}\n${(d?.elements ?? []).map((e) => e.text).join("\n")}`).join("\n");
  const allAttrs = [rail, built, today, leadDom].map((d) => JSON.stringify((d?.elements ?? []).map((e) => e.attrs))).join("\n");
  check("red 'Needs you' is on screen", /needs you/i.test(allText) || /needs[-_ ]?you/i.test(allAttrs), "");
  check("the reason reads 'Stopped with an error.'", /stopped with an error/i.test(allText), allText.match(/.{0,50}stopped with an error.{0,80}/i)?.[0] ?? "");
  const leadName = (await h.monos()).find((m) => m.id === "tally-lead")?.name ?? "Tally";
  const openChat = allText.match(/.{0,60}(?:opens?|open)\s+[^\n]{0,50}chat[^\n]{0,40}/i);
  check("'Open <Lead>'s chat' is offered", !!openChat && new RegExp(esc(leadName), "i").test(openChat[0]), openChat?.[0]?.trim() ?? "no open-chat line");
  // No test wording leaks into anything visible.
  const lines = await h.texts();
  const leaked = lines.filter((l) => isTestWording(l.text));
  check("no test-fault wording anywhere visible", leaked.length === 0, leaked.map((l) => `${l.where}: ${l.text.slice(0, 100)}`).join(" | "));

  out.evidence.leadName = leadName;
  out.evidence.failedCount = failed.length;
  out.verdict = checks.every((c) => c.ok) ? "pass" : checks.some((c) => c.ok) ? "partial" : "fail";
  h.write(`${dir}/evidence.json`, out);
  h.write(`${dir}/transcript.md`, `# D5 transcript\n\n${log.join("\n")}\n`);
  return out;
}

async function dumpSnapAll(h, name) {
  const s = await h.snap();
  h.write(`${name}.json`, s);
  return s?.dom ?? null;
}

// ---- A1: a room and a Mono drafted with Ash, nothing made before his yes ---------------------------------------------

async function testA1(ctx, h) {
  const dir = "a1";
  const log = [];
  const say = (line) => { log.push(`[${stamp()}] ${line}`); ctx.log(`[a1] ${line}`); };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail ?? "" }); say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const out = { id: "A1", title: "New room with CoS + PM and a mono_create draft; no Mono before Ash's yes", checks, evidence: {} };
  const roomId = "tally:leadership";

  const before = await h.monos();
  const roomsBefore = (await h.rooms()).map((r) => r.id);
  out.evidence.monosBefore = before.map((m) => m.id);
  out.evidence.roomsBefore = roomsBefore;

  say("sending the blind ask in a fresh Leadership conversation");
  const t0 = Date.now();
  const ask = "can u set up a content room with cos and pm, and draft a new mono to help write changelog notes";
  const sent = await h.act("send", { to: { room: "tally" }, text: ask, fresh: true });
  h.write(`${dir}/sent.txt`, `${ask}\n`);
  const convId = sent.conversation;

  // The first thing the room does: either a shaping question (answer it) or straight to the room + draft.
  const firstBeat = await h.waitFor(() => {
    const msgs = h.roomEvents(roomId, t0).filter((e) => e.kind === "room-message" && e.from !== "ash" && (!convId || e.conv === convId));
    if (!msgs.length) return null;
    return msgs;
  }, { timeoutMs: 4 * 60_000, everyMs: 2_500 });
  const question = (firstBeat ?? []).slice().reverse().find((m) => /\?/.test(m.text));
  out.evidence.firstBeat = firstBeat;
  if (question) {
    check("a seat asked Ash a shaping question", true, `${question.from}: "${String(question.text).slice(0, 140)}"`);
    say(`answering the shaping question in Ash's style (to ${question.from})`);
    const answer = "it should draft changelog notes off whats shipped, drafts only for my ok, and it answers to cos";
    await h.act("send", { to: { room: "tally" }, text: answer });
    h.write(`${dir}/answered.txt`, `${answer}\n`);
  } else {
    check("a seat asked Ash a shaping question", false, firstBeat ? `first reply was not a question: "${String(firstBeat[0].text).slice(0, 140)}"` : "silence for 4 min");
  }

  // The content room and the draft card should follow; nothing is made before the yes.
  const deadline = Date.now() + 6 * 60_000;
  let newRoom = null;
  let draft = null;
  let madeBeforeYes = null;
  for (;;) {
    const rs = await h.rooms();
    const candidates = rs.filter((r) => !roomsBefore.includes(r.id) && r.id !== roomId);
    newRoom = candidates.find((r) => r.memberIds?.includes("chief-of-staff") && r.memberIds?.includes("projects-manager")) ?? candidates[0] ?? newRoom;
    const ms = await h.monos();
    madeBeforeYes = ms.find((m) => !before.some((b) => b.id === m.id)) ?? madeBeforeYes;
    // The draft card renders in the chat it was drafted in — most likely this room's conversation.
    if (!draft) {
      const dom = await h.viewDom({ project: "tally", item: "leadership-team" }, `${dir}/probe-leadership`, 1200).catch(() => null);
      draft = dom ? h.draftInDom(dom) : null;
    }
    if ((newRoom && draft) || madeBeforeYes || Date.now() > deadline) break;
    await sleep(4_000);
  }
  out.evidence.newRoom = newRoom ? { id: newRoom.id, name: newRoom.name, memberIds: newRoom.memberIds } : null;
  check("a new room exists", !!newRoom, newRoom ? `${newRoom.id} "${newRoom.name}"` : "none in 6 min");
  if (newRoom) {
    check("the room seats CoS and PM", (newRoom.memberIds ?? []).includes("chief-of-staff") && (newRoom.memberIds ?? []).includes("projects-manager"), (newRoom.memberIds ?? []).join(", "));
  }
  check("no Mono was created before Ash's yes", !madeBeforeYes, madeBeforeYes ? `unexpected new Mono ${madeBeforeYes.id}` : `${(await h.monos()).length} Monos, all known`);

  // The draft card wherever it lives: leadership view first, then CoS's own chat.
  if (!draft) {
    const cosDom = await h.monoDom("chief-of-staff", `${dir}/probe-cos`, 2000);
    draft = cosDom ? h.draftInDom(cosDom) : null;
  }
  if (!draft && newRoom) {
    const roomDom = await h.viewDom({ project: "tally", item: `chat:${newRoom.id}` }, `${dir}/probe-newroom`, 2000);
    draft = roomDom ? h.draftInDom(roomDom) : null;
  }
  const draftDom = await h.viewDom({ project: "tally", item: "leadership-team" }, `${dir}/view-leadership`, 2500);
  draft = draft ?? (draftDom ? h.draftInDom(draftDom) : null);
  const draftText = draftDom ? `${draftDom.mainText}\n${(draftDom.elements ?? []).map((e) => e.text).join("\n")}` : "";
  out.evidence.draft = draft;
  check("the mono_create draft card is on screen", !!draft, draft ? `card ${JSON.stringify(draft.attrs)} "${String(draft.text).slice(0, 120)}"` : "no data-mono-draft element");
  check("the card says it waits on Ash's yes", /nothing is made yet|waiting for your ok|say yes/i.test(draft ? `${draft.text}\n${draftText}` : draftText), (draft?.text ?? draftText).match(/.{0,60}(?:nothing is made|waiting for your ok|say yes).{0,60}/i)?.[0] ?? "");

  // Ash's yes makes it.
  say("saying yes in the room");
  await h.act("send", { to: { room: "tally" }, text: "yes do it" });
  const made = await h.waitFor(async () => {
    const ms = await h.monos();
    return ms.find((m) => !before.some((b) => b.id === m.id)) ?? null;
  }, { timeoutMs: 4 * 60_000 });
  out.evidence.made = made ?? null;
  check("the Mono was made after his yes", !!made, made ? `${made.id} "${made.name ?? ""}"` : "no new Mono in 4 min");
  if (made && newRoom) {
    const roomNow = (await h.rooms()).find((r) => r.id === newRoom.id);
    out.evidence.roomAfterMake = roomNow?.memberIds ?? [];
    say(`note: room members after the make: ${(roomNow?.memberIds ?? []).join(", ")}`);
  }

  const lines = (await h.texts()).filter((l) => (l.t ?? 0) >= t0);
  const testLines = lines.filter((l) => isTestWording(l.text));
  const heLines = lines.filter((l) => HE_WORDS.test(l.text));
  check("no test wording", testLines.length === 0, testLines.map((l) => `${l.where}: ${l.text.slice(0, 90)}`).join(" | "));
  check("no Mono calls Ash 'he'", heLines.length === 0, heLines.map((l) => `${l.where}: ${l.text.slice(0, 90)}`).join(" | "));
  out.evidence.roomAfter = h.roomEvents(roomId, t0).slice(-25);
  h.write(`${dir}/leadership-events.json`, out.evidence.roomAfter);
  if (newRoom) h.write(`${dir}/new-room.json`, newRoom);

  out.verdict = checks.every((c) => c.ok) ? "pass" : checks.some((c) => c.ok) ? "partial" : "fail";
  h.write(`${dir}/evidence.json`, out);
  h.write(`${dir}/transcript.md`, `# A1 transcript\n\n${log.join("\n")}\n`);
  return out;
}

// ---- A11 & H6: Leadership -> Lead double delegation; shared task understanding ---------------------------------------

async function testA11H6(ctx, h) {
  const dir = "a11-h6";
  const log = [];
  const say = (line) => { log.push(`[${stamp()}] ${line}`); ctx.log(`[a11/h6] ${line}`); };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail ?? "" }); say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const out = { id: "A11+H6", title: "Leadership delegates to the coding team's Lead; the report comes back; tasks are shared knowledge", checks, evidence: {} };
  const roomId = "tally:leadership";

  // The Lead's chat may not exist yet: the brief itself can open it (run dd7f, 27 Oct, read it before the ask and got
  // null, so every check after the brief was skipped). It is whichever chat of tally-lead's a new row's child is.
  let leadSession = await h.monoSession("tally-lead");
  const rowsBefore = (await h.delegations()).map((r) => r.id);
  const leadChats = async () => {
    const sessions = (await h.snap()).sessions ?? [];
    return new Set([...(leadSession ? [leadSession] : []), ...sessions.filter((s) => s.mono === "tally-lead").map((s) => s.id)]);
  };

  say("asking Leadership to hand work to the coding team");
  const t0 = Date.now();
  const ask = "cos get the coding team to update the tally readme so it matches what the board actually does now, n tell me when its back";
  await h.act("send", { to: { room: "tally" }, text: ask });
  h.write(`${dir}/sent.txt`, `${ask}\n`);

  // A delegation row whose child IS the Lead's own long-running chat = the double-delegate brief.
  const brief = await h.waitFor(async () => {
    const rows = (await h.delegations()).filter((r) => !rowsBefore.includes(r.id) && !r.parent_id);
    if (!rows.length) return null;
    const lead = await leadChats();
    return rows.find((r) => lead.has(r.child_session)) ?? null;
  }, { timeoutMs: 4 * 60_000 });
  if (brief) leadSession = brief.child_session;
  out.evidence.leadSession = leadSession;
  out.evidence.briefRow = brief;
  check("Leadership briefed the project's Lead (tasks.delegate lead)", !!brief, brief ? `row ${brief.id}: ${brief.owner_mono ?? brief.owner_session} -> Lead chat` : "no lead-brief row in 4 min");
  const fellBack = (await h.delegations()).find((r) => !rowsBefore.includes(r.id) && (!leadSession || r.child_session !== leadSession));
  if (!brief && fellBack) { out.evidence.fellBackToWorker = fellBack; say(`note: work went to a worker row ${fellBack.id} instead of the Lead's chat`); }

  // While it runs, ask frank what's running (H6): task_status's othersRunning should tell it.
  if (brief) {
    await sleep(10_000);
    say("asking frank what's running (H6)");
    await h.act("send", { to: { room: "tally" }, text: "frank wats running rn" });
  }

  // The job runs to a result; the report lands back in the Leadership room.
  const deadline = Date.now() + 12 * 60_000;
  let settled = null;
  let report = null;
  for (;;) {
    const rows = await h.delegations();
    settled = rows.find((r) => brief && r.id === brief.id && ["completed", "failed", "cancelled"].includes(r.state));
    if (!report) {
      // The report is what the room hears after the row settles (run r56b, 27 Oct: an earlier line from frank, said
      // while the job ran, was taken for the report six seconds before the Lead's real one landed).
      const after = settled ? (settled.settled_at ?? settled.updated_at ?? 0) - 2_000 : Infinity;
      const msgs = h.roomEvents(roomId, t0).filter((e) => e.kind === "room-message" && e.from !== "ash" && (e.t ?? 0) >= after);
      const last = msgs.at(-1);
      if (last && settled) report = last;
    }
    if ((settled && report) || Date.now() > deadline) break;
    await sleep(6_000);
  }
  const finalRow = (await h.delegations()).find((r) => brief && r.id === brief.id) ?? null;
  out.evidence.settledRow = settled ?? finalRow;
  check("the Lead ran the job to a result", !!settled, settled ? `state ${settled.state}` : `no result in 12 min (state ${finalRow?.state ?? "?"})`);
  check("the report landed back in the Leadership room", !!report, report ? `${report.from}: "${String(report.text).slice(0, 140)}"` : "no reply in the room after the row settled");
  if (report) h.write(`${dir}/report.txt`, String(report.text));

  // H6: what frank's turn read (task_status othersRunning) and said. Frank's room turn runs on its room session:
  // find the session whose blocks carry my "what's running" message.
  const snapNow = await h.snap();
  const frankSessions = (snapNow.sessions ?? []).filter((s) => s.mono === "frank").map((s) => s.id);
  let frankBlocks = [];
  for (const sessionId of frankSessions) {
    const blocks = await ctx.sessionBlocks(sessionId).catch(() => []);
    if (blocks.some((b) => /wats running|what'?s running/i.test(String(b.text ?? "")))) { frankBlocks = blocks; h.write(`${dir}/frank-blocks-${sessionId.slice(0, 8)}.json`, blocks); break; }
  }
  if (!frankBlocks.length && frankSessions.length) frankBlocks = await h.sessionDump(frankSessions[0], `${dir}/frank-blocks.json`) ?? [];
  const statusResult = frankBlocks.filter((b) => /othersRunning|others_running/i.test(JSON.stringify(b)));
  const frankRoomLines = h.roomEvents(roomId, t0).filter((e) => e.kind === "room-message" && e.from === "frank").map((e) => e.text);
  const lastFrank = frankRoomLines.at(-1) ?? frankBlocks.filter((b) => b.role === "assistant" && b.text).map((b) => b.text).at(-1) ?? "";
  out.evidence.frank = { sawOthersRunning: statusResult.length > 0, said: String(lastFrank).slice(0, 800) };
  check("frank read the team's open jobs (task_status othersRunning)", statusResult.length > 0, statusResult.length ? "" : "no othersRunning in frank's blocks — it may have answered blind");
  check("frank's reply reflects the running job", /tally|readme|coding team|lead|cos|working|running|on it/i.test(String(lastFrank)) && !/nothing('?s| is)? (running|on)|no jobs|nobody.*on/i.test(String(lastFrank)), String(lastFrank).slice(0, 160));
  h.write(`${dir}/delegations.json`, await h.delegations());
  check("the lead-brief is a shared top-level row (what othersRunning lists)", !!finalRow && !finalRow.parent_id, finalRow ? `owner=${finalRow.owner_mono ?? finalRow.owner_session}` : "");

  // The Lead's own chat shows the brief in, workers out, report back (double delegation).
  const leadBlocks = await h.sessionDump(leadSession, `${dir}/lead-chat-blocks.json`);
  const delegated = (await h.delegations()).filter((r) => r.owner_session === leadSession && brief && r.created_at > brief.created_at);
  check("the Lead delegated the work on", delegated.length > 0 || (leadBlocks ?? []).some((b) => /delegate|worker/i.test(String(b.text ?? ""))), delegated.map((r) => `${r.id} ${r.state}`).join(", ") || "no child workers");

  const lines = (await h.texts()).filter((l) => (l.t ?? 0) >= t0);
  const testLines = lines.filter((l) => isTestWording(l.text));
  check("no test wording", testLines.length === 0, testLines.map((l) => `${l.where}: ${l.text.slice(0, 90)}`).join(" | "));

  out.verdict = checks.every((c) => c.ok) ? "pass" : checks.some((c) => c.ok) ? "partial" : "fail";
  h.write(`${dir}/evidence.json`, out);
  h.write(`${dir}/transcript.md`, `# A11 & H6 transcript\n\n${log.join("\n")}\n`);
  return out;
}

// ---- B9: two workers in parallel, Ash's aside answered mid-run --------------------------------------------------------

async function testB9(ctx, h) {
  const dir = "b9";
  const log = [];
  const say = (line) => { log.push(`[${stamp()}] ${line}`); ctx.log(`[b9] ${line}`); };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail ?? "" }); say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const out = { id: "B9", title: "Two workers in parallel from the Lead's chat; Ash's aside is answered while they run", checks, evidence: {} };

  const leadSession = await h.monoSession("tally-lead");
  const rowsBefore = (await h.delegations()).map((r) => r.id);

  say("asking the Lead for two parallel workers");
  const ask = "can u get two things going at once - one worker to write the streaks section in the readme, another to double-check the weekly reset logic actually matches it";
  const sent = await h.act("send", { to: { mono: "tally-lead" }, text: ask });
  h.write(`${dir}/sent.txt`, `${ask}\n`);

  // Two running delegation rows owned by the Lead's chat, started close together.
  const two = await h.waitFor(async () => {
    const rows = (await h.delegations()).filter((r) => !rowsBefore.includes(r.id) && r.owner_session === leadSession);
    const open = rows.filter((r) => r.state === "running" || r.state === "question");
    return open.length >= 2 ? rows : null;
  }, { timeoutMs: 5 * 60_000 });
  out.evidence.parallelRows = two ?? null;
  check("two workers run in parallel", !!two && two.filter((r) => r.state === "running" || r.state === "question").length >= 2, two ? two.map((r) => `${r.id} ${r.state} @${new Date(r.created_at).toISOString().slice(11, 19)}`).join("; ") : "fewer than 2 in 5 min");
  if (two && two.length >= 2) {
    const times = two.map((r) => r.created_at).sort();
    check("their start times overlap", times.at(-1) - times[0] < 120_000, `${Math.round((times.at(-1) - times[0]) / 1000)}s apart`);
  }

  // The aside, while both are out.
  say("sending the aside while workers run");
  const asideAt = Date.now();
  const aside = "oh n do streaks need a daily cap or just let em run";
  await h.act("send", { to: { mono: "tally-lead" }, text: aside });
  h.write(`${dir}/aside.txt`, `${aside}\n`);

  // An answer lands in the Lead's chat: the driver's session events carry the last assistant text once the turn ends.
  let asideReply = null;
  let bothSettledAt = null;
  const deadline = Date.now() + 12 * 60_000;
  for (;;) {
    const rows = (await h.delegations()).filter((r) => two?.some((t) => t.id === r.id));
    const open = rows.filter((r) => r.state === "running" || r.state === "question");
    if (open.length === 0 && !bothSettledAt) bothSettledAt = Date.now();
    if (!asideReply) {
      const ev = ctx.events.find((e) => e.t >= asideAt && e.session === leadSession && e.kind === "session" && !e.busy && e.last && !/^\[monocode report/i.test(String(e.last)));
      if (ev) {
        asideReply = { t: ev.t, text: ev.last };
        say(`aside answered at +${Math.round((ev.t - asideAt) / 1000)}s: "${String(ev.last).slice(0, 120)}"`);
      }
    }
    if ((asideReply && bothSettledAt) || Date.now() > deadline) break;
    await sleep(4_000);
  }
  out.evidence.asideReply = asideReply;
  out.evidence.bothSettledAt = bothSettledAt;
  check("the aside was answered", !!asideReply, asideReply ? `after ${Math.round((asideReply.t - asideAt) / 1000)}s: "${String(asideReply.text).slice(0, 140)}"` : "no reply in the Lead's chat");
  check("the reply was not stuck behind the workers", !!asideReply && (!bothSettledAt || asideReply.t <= bothSettledAt + 30_000),
    asideReply && bothSettledAt ? `reply +${Math.round((asideReply.t - asideAt) / 1000)}s vs settled +${Math.round((bothSettledAt - asideAt) / 1000)}s` : "");

  const rows = (await h.delegations()).filter((r) => two?.some((t) => t.id === r.id));
  h.write(`${dir}/delegations.json`, rows);
  check("both worker rows settled", rows.length >= 2 && rows.every((r) => ["completed", "failed", "cancelled"].includes(r.state)), rows.map((r) => `${r.id}: ${r.state}`).join("; "));
  check("both worker reports arrived cleanly", rows.filter((r) => r.state === "completed" && String(r.result ?? "").trim()).length >= 2,
    rows.map((r) => `${r.id}: ${r.state} result=${String(r.result ?? "").slice(0, 60)}`).join("; "));
  const leadBlocks = await h.sessionDump(leadSession, `${dir}/lead-chat-blocks.json`);
  const reportBlocks = (leadBlocks ?? []).filter((b) => /report|readme|streak|reset/i.test(String(b.text ?? "")) && b.role !== "user");
  check("the Lead's chat shows the reports", reportBlocks.length > 0, `${reportBlocks.length} matching blocks`);

  out.verdict = checks.every((c) => c.ok) ? "pass" : checks.some((c) => c.ok) ? "partial" : "fail";
  h.write(`${dir}/evidence.json`, out);
  h.write(`${dir}/transcript.md`, `# B9 transcript\n\n${log.join("\n")}\n`);
  return out;
}

// ---- H13: a coding-team chat knows where the hub docs live -------------------------------------------------------------

async function testH13(ctx, h) {
  const dir = "h13";
  const log = [];
  const say = (line) => { log.push(`[${stamp()}] ${line}`); ctx.log(`[h13] ${line}`); };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail ?? "" }); say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const out = { id: "H13", title: "A coding-team chat finds the hub docs plainly; Monos keep their own voices", checks, evidence: {} };

  say("asking a coding-team chat where the hub docs live");
  const ask = "where do the hub docs live? like the pages build contract n the agent notes, i can never find em";
  const sent = await h.act("send", { to: { codingTeam: "tally" }, text: ask });
  h.write(`${dir}/sent.txt`, `${ask}\n`);
  const sessionId = sent.session;
  out.evidence.session = sessionId;
  check("a coding-team chat took the message", !!sessionId, sessionId ?? sent.error ?? "");

  const reply = await h.waitFor(async () => {
    const ev = [...ctx.events].reverse().find((e) => e.session === sessionId && e.kind === "session" && !e.busy && e.last);
    if (ev) return { text: ev.last, t: ev.t };
    const blocks = await ctx.sessionBlocks(sessionId).catch(() => []);
    const answers = blocks.filter((b) => (b.role === "assistant" || b.role === "agent") && String(b.text ?? "").trim());
    const s = await h.snap();
    const busy = s.sessions?.find((x) => x.id === sessionId)?.busy;
    return answers.length && busy === false ? { text: answers.at(-1).text } : null;
  }, { timeoutMs: 5 * 60_000 });
  const text = String(reply?.text ?? "");
  out.evidence.reply = text;
  h.write(`${dir}/reply.txt`, text);
  check("it answered", !!text, "");
  check("it names docs/pages-build-contract.md", /pages-build-contract\.md/i.test(text), text.slice(0, 200));
  check("it names docs/hub/agent-notes.md", /agent-notes\.md/i.test(text), "");
  check("the answer is plain", text.length > 0 && text.length < 2500 && !TEST_WORDS.test(text), `${text.length} chars`);

  // Distinct voices: the room replies we've seen so far, grouped by Mono — same script twice is a failure.
  const lines = await h.texts();
  const byMono = {};
  for (const l of lines.filter((l) => l.where.startsWith("room:"))) (byMono[l.from] ??= []).push(l.text);
  const samples = Object.fromEntries(Object.entries(byMono).map(([k, v]) => [k, v.slice(-3)]));
  out.evidence.voices = samples;
  h.write(`${dir}/voices.json`, samples);
  const distinct = Object.keys(samples).length >= 2 && new Set(Object.values(samples).map((v) => v.join("|").slice(0, 200))).size > 1;
  check("Monos speak in distinct voices", distinct, Object.keys(samples).join(", "));

  const testLines = lines.filter((l) => isTestWording(l.text));
  check("no test wording", testLines.length === 0, testLines.map((l) => `${l.where}: ${l.text.slice(0, 90)}`).join(" | "));

  out.verdict = checks.every((c) => c.ok) ? "pass" : checks.some((c) => c.ok) ? "partial" : "fail";
  h.write(`${dir}/evidence.json`, out);
  h.write(`${dir}/transcript.md`, `# H13 transcript\n\n${log.join("\n")}\n`);
  return out;
}

// ---- A3: renamed and deleted Monos; a new project reuses the crew ------------------------------------------------------

async function testA3(ctx, h) {
  const dir = "a3";
  const log = [];
  const say = (line) => { log.push(`[${stamp()}] ${line}`); ctx.log(`[a3] ${line}`); };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail ?? "" }); say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const out = { id: "A3", title: "Rename CoS out and back, create+delete a spare Mono, a new project reuses the crew", checks, evidence: {} };

  const monosJson = path.join(env.dataDir, "monos", "MONOS.json");
  const readRoster = () => JSON.parse(fs.readFileSync(monosJson, "utf8"));
  const writeRoster = (change) => {
    const roster = readRoster();
    change(roster);
    roster.savedAt = Date.now();
    fs.writeFileSync(monosJson, `${JSON.stringify(roster, null, 2)}\n`);
  };
  const reloadAndWait = async () => {
    await h.act("reload");
    await h.waitFor(async () => ((await h.act("ping", {}, 10_000))?.ok ? true : null), { timeoutMs: 90_000, everyMs: 1_000 });
    await sleep(3_000);
  };
  /** A roster edit as the app makes it, then a reload to reconcile; retried once in case the app saved over it. */
  const rosterEdit = async (label, change, verify) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      writeRoster(change);
      await reloadAndWait();
      const ms = await h.monos();
      if (verify(ms)) return ms;
      say(`${label}: attempt ${attempt + 1} didn't take (app may have rewritten the roster) — retrying`);
    }
    return h.monos();
  };

  say("renaming chief-of-staff to Boss (the same write saveMonoName makes), then reloading");
  let ms = await rosterEdit("rename to Boss", (r) => { for (const m of r.monos) if (m.id === "chief-of-staff") m.name = "Boss"; }, (l) => l.find((m) => m.id === "chief-of-staff")?.name === "Boss");
  check("renamed to Boss", ms.find((m) => m.id === "chief-of-staff")?.name === "Boss", ms.find((m) => m.id === "chief-of-staff")?.name);

  say("renaming back to Chief of Staff and adding a spare Mono");
  ms = await rosterEdit("rename back + spare", (r) => {
    for (const m of r.monos) if (m.id === "chief-of-staff") m.name = "Chief of Staff";
    if (!r.monos.some((m) => m.id === "qa-spare")) r.monos.push({ id: "qa-spare", name: "Spare", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] });
  }, (l) => l.find((m) => m.id === "chief-of-staff")?.name === "Chief of Staff" && l.some((m) => m.id === "qa-spare"));
  check("renamed back to Chief of Staff", ms.find((m) => m.id === "chief-of-staff")?.name === "Chief of Staff", ms.find((m) => m.id === "chief-of-staff")?.name);
  check("the spare Mono exists", ms.some((m) => m.id === "qa-spare"), ms.map((m) => m.id).join(", "));

  say("deleting the spare Mono");
  ms = await rosterEdit("delete spare", (r) => { r.monos = r.monos.filter((m) => m.id !== "qa-spare"); }, (l) => !l.some((m) => m.id === "qa-spare"));
  check("the spare Mono is gone", !ms.some((m) => m.id === "qa-spare"), ms.map((m) => m.id).join(", "));

  // A new project the way the app's New project flow registers it with Ash OS.
  say("creating project nibbii-stuff via the stub (the same ash-hub call New project makes)");
  const folder = path.join(env.scratch, "projects", "nibbii-stuff");
  fs.mkdirSync(folder, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder });
  fs.writeFileSync(path.join(folder, "README.md"), "# Nibbii Stuff\n");
  execFileSync("git", ["add", "-A"], { cwd: folder });
  execFileSync("git", ["-c", "user.name=qa", "-c", "user.email=qa@invalid", "commit", "-q", "-m", "start"], { cwd: folder });
  out.evidence.projectCreate = await stubAct("project-create", {
    name: "Nibbii Stuff", one_line: "side project for nibbii work, same crew", project_id: "nibbii-stuff", short_name: "Nibbii", code: true, folder,
  }).catch((e) => ({ error: e.message }));
  say(`project-create: ${JSON.stringify(out.evidence.projectCreate).slice(0, 200)}`);

  const ready = await h.waitFor(async () => {
    const snap = await h.snap();
    const lead = snap.monos?.find((m) => m.id === "nibbii-stuff-lead");
    const room = snap.rooms?.find((r) => r.id === "nibbii-stuff:leadership");
    return lead && room?.memberIds?.length ? { lead, room, monos: snap.monos } : null;
  }, { timeoutMs: 3 * 60_000, everyMs: 3_000 });
  out.evidence.newProject = ready ? { lead: ready.lead.id, room: ready.room.id, members: ready.room.memberIds } : null;
  check("the new project got its Lead", !!ready?.lead, ready?.lead?.id ?? "no nibbii-stuff-lead in 3 min");
  check("its Leadership room seats the same crew (ids, rename-proof)", !!ready && ["chief-of-staff", "projects-manager", "frank", "alfred"].every((id) => ready.room.memberIds.includes(id)),
    ready ? ready.room.memberIds.join(", ") : "");
  const tied = ready?.monos?.filter((m) => ["chief-of-staff", "projects-manager", "frank", "alfred"].includes(m.id) && m.projects?.some((p) => /nibbii-stuff/i.test(p)));
  check("the crew is tied to the new project's folder", (tied?.length ?? 0) >= 2, (tied ?? []).map((m) => `${m.id} -> ${(m.projects ?? []).join(";")}`).join(" | ") || "none");
  ms = await h.monos();
  check("the deleted spare stays deleted", !ms.some((m) => m.id === "qa-spare"), ms.map((m) => m.id).join(", "));
  check("CoS kept its real name through it all", ms.find((m) => m.id === "chief-of-staff")?.name === "Chief of Staff", ms.find((m) => m.id === "chief-of-staff")?.name);

  h.write(`${dir}/monos-final.json`, ms);
  h.write(`${dir}/rooms-final.json`, await h.rooms());

  out.verdict = checks.every((c) => c.ok) ? "pass" : checks.some((c) => c.ok) ? "partial" : "fail";
  h.write(`${dir}/evidence.json`, out);
  h.write(`${dir}/transcript.md`, `# A3 transcript\n\n${log.join("\n")}\n`);
  return out;
}

// ---- main --------------------------------------------------------------------------------------------------------------

const options = {
  scenarios: "(spec passed by hook)",
  only: [],
  build: true,
  keep: false,
  grade: false,
  gradeOnly: null,
  slot: SLOT,
  maxTurns: 600,
  maxMinutes: 150,
  maxRequests: 4000,
  claudeConfigs: [],
  grokSub: false,
  deepseekSub: true,
};

const result = await runBench(options, {
  spec: SPEC,
  evidenceDir: OUT,
  label: "r56-e2e",
  async afterReady(ctx) {
    env.scratch = path.dirname(path.dirname(ctx.project));
    env.home = path.join(env.scratch, "home");
    env.dataDir = findDataDir(env.home);
    env.stubPort = await findStubPort();
    ctx.log(`data dir ${env.dataDir}; stub :${env.stubPort}`);
    if (!env.dataDir) throw new Error(`no dev data dir under ${env.home}`);
    const dir = path.join(env.dataDir, "dev-faults");
    fs.mkdirSync(dir, { recursive: true });
    env.faultFile = path.join(dir, "fail-next-workers");
    // r56 e2e: no fault armed; this run proves real workers start and report back.
  },
  async play(ctx, { stopped }) {
    const h = makeHelpers(ctx, stopped);
    const results = [];
    // D5 first: the armed fault file is spent by the first delegated workers, so no other test may delegate before it.
    for (const test of [testA11H6, testB9]) {
      if (stopped()) { results.push({ id: test.name, skipped: stopped() }); continue; }
      try {
        results.push(await test(ctx, h));
      } catch (error) {
        ctx.log(`${test.name} crashed: ${error.stack ?? error.message}`);
        results.push({ id: test.name, error: String(error.stack ?? error) });
      }
      h.write(`${String(results[results.length - 1].id ?? test.name).replaceAll("+", "-")}-done.marker`, `${new Date().toISOString()}\n`);
    }
    h.write("summary.json", results);
    return results;
  },
});

console.log(`\nrun ${result.id}: ${result.evidence}`);
for (const r of result.results ?? []) console.log(`  ${r.id}: ${r.verdict ?? r.skipped ?? r.error ?? "?"}`);
