// The real-Claude bench's scenario player (scripts/hub-realtest.mjs, docs/REALTEST.md). A scenario is Ash's side of a
// conversation: timed messages to the leadership room, a Lead or a worker, a Stop, an outage, waits on what the team
// does, and looks at Today / Being built / the rail. Every wait is bounded by the scenario's minutes and the run's
// deadline; a scenario that spends its turn budget stops waiting. After the steps it writes the evidence:
// scenarios/<id>/evidence.json (sends, every room message and Claude reply with times, delegation rows, views,
// metrics) and transcript.md (what the grader and a person read).

import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ms = (value) => (typeof value === "number" ? value : value ? Date.parse(value) : 0);
const rel = (t, t0) => `+${Math.round((t - t0) / 1000)}s`;
const ASH = "ash";

/** Ash's message as the scenario file writes it: a string, or lines joined with newlines. */
const textOf = (value) => (Array.isArray(value) ? value.join("\n") : String(value ?? ""));

/** Messages in one room after `since`, in order. */
export function roomMessages(events, room, since = 0) {
  return events.filter((event) => event.kind === "room-message" && event.room === room && event.t >= since);
}

/** Room timings per Ash message: who answered first and how fast, how many replies before Ash spoke again. */
export function roomRounds(messages) {
  const rounds = [];
  for (const message of messages) {
    if (message.from === ASH) rounds.push({ t: message.t, text: message.text, replies: [] });
    else if (rounds.length) rounds.at(-1).replies.push(message);
  }
  return rounds.map((round) => ({
    ash: round.text.slice(0, 160),
    t: round.t,
    replies: round.replies.length,
    first: round.replies[0] ? { from: round.replies[0].from, afterSec: Math.round((round.replies[0].t - round.t) / 100) / 10 } : null,
    order: round.replies.map((reply) => reply.from),
    seats: [...new Set(round.replies.map((reply) => reply.from))],
  }));
}

/** Words that would mean Ash had to tag someone; the scenarios never do, this checks the scenario file too. */
const TAGGED = /(^|\s)@[A-Za-z]/;

export async function runScenario(scenario, ctx) {
  const { act, events, usage, log, evidence, leadId, roomId, deadline } = ctx;
  // A run-wide look (no steps of its own): everything since the run began.
  const t0 = scenario.since === "run" ? ctx.runStarted : Date.now();
  const stop = Math.min(deadline + 10 * 60_000, Date.now() + (scenario.minutes ?? 10) * 60_000);
  const turnsCap = scenario.maxTurns ?? 60;
  const dir = path.join(evidence, "scenarios", scenario.id);
  fs.mkdirSync(dir, { recursive: true });
  const record = { id: scenario.id, title: scenario.title, bench: scenario.bench ?? [], started: t0, sends: [], waits: [], views: [], shots: [], marks: [], faults: [], notes: [] };
  const lastSendTo = new Map();
  const overBudget = () => usage(t0).turns >= turnsCap;
  const expired = () => Date.now() > stop;
  const resolveMono = (name) => (name === "lead" ? leadId : name);
  const resolveRoom = (name) => (name === "room" || name === "leadership" ? roomId : name.includes(":") ? name : `${name}:leadership`);

  const target = async (to) => {
    if (to.room) return { room: resolveRoom(to.room) };
    if (to.mono) return { mono: resolveMono(to.mono) };
    if (to.worker) {
      const rows = await ctx.delegationRows();
      const leadSession = await ctx.monoSession(leadId);
      const open = rows.filter((row) => (row.owner_mono === leadId || row.owner_session === leadSession) && (to.worker === "any" || ["running", "question"].includes(row.state)));
      const pick = to.worker === "question" ? open.filter((row) => row.state === "question").at(-1) : open.at(-1);
      if (!pick) return null;
      return { session: pick.child_session, owner: pick.owner_session };
    }
    if (to.session) return { session: to.session };
    return null;
  };

  const conditionMet = async (cond, ref) => {
    await ctx.pump();
    if (cond.any) {
      for (const one of cond.any) if (await conditionMet(one, ref)) return true;
      return false;
    }
    if (cond.roomQuiet || cond.roomReply) {
      const room = resolveRoom(cond.roomQuiet ?? cond.roomReply);
      const all = roomMessages(events, room, ref);
      const replies = all.filter((m) => m.from !== ASH && (!cond.from || m.from === cond.from) && (!cond.pattern || new RegExp(cond.pattern, "i").test(m.text)));
      if (cond.roomReply) return replies.length >= (cond.count ?? 1);
      const typing = events.filter((e) => e.kind === "room-typing" && e.room === room).at(-1);
      const last = Math.max(ref, ...all.map((m) => m.t), typing?.t ?? 0);
      return replies.length > 0 && !typing?.who && Date.now() - last >= (cond.quietSec ?? 40) * 1000;
    }
    if (cond.monoReply || cond.monoText) {
      const monoId = resolveMono(cond.monoReply ?? cond.monoText);
      const session = await ctx.monoSession(monoId);
      if (!session) return false;
      const since = cond.monoText ? t0 : (lastSendTo.get(monoId) ?? ref);
      const lines = (await ctx.claudeTexts(since)).filter((line) => line.session === session);
      if (cond.monoText) return lines.some((line) => line.text && new RegExp(cond.pattern, "i").test(line.text));
      return lines.some((line) => line.result);
    }
    if (cond.delegation) {
      const rows = (await ctx.delegationRows()).filter((row) => ms(row.created_at) >= t0 - 1000 || ms(row.updated_at) >= t0);
      const match = rows.filter(
        (row) =>
          (!cond.delegation.owner || row.owner_mono === resolveMono(cond.delegation.owner)) &&
          (!cond.delegation.state || [].concat(cond.delegation.state).includes(row.state)),
      );
      return match.length >= (cond.delegation.count ?? 1);
    }
    if (cond.settled) {
      const rows = (await ctx.delegationRows()).filter((row) => ms(row.created_at) >= t0 - 1000);
      return rows.length > 0 && rows.every((row) => !["running", "question"].includes(row.state));
    }
    if (cond.quiet) {
      const snap = await act("snapshot");
      const busy = (snap.sessions ?? []).filter((s) => s.busy);
      const typing = (snap.rooms ?? []).some((r) => r.typing);
      const recent = events.filter((e) => (e.kind === "room-message" || e.kind === "session") && e.t >= ref).at(-1);
      return !busy.length && !typing && Date.now() - Math.max(ref, recent?.t ?? 0) >= (cond.quietSec ?? 45) * 1000;
    }
    throw new Error(`unknown wait ${JSON.stringify(cond)}`);
  };

  const view = async (step) => {
    const name = step.name ?? `${step.view.project}-${step.view.item}`;
    try {
      const answer = await act("open", { hub: step.view, settleMs: 2000 }, 30_000);
      const shot = await ctx.screenshot(`${scenario.id}-${name}`);
      record.views.push({ t: Date.now(), name, view: step.view, mainText: answer.dom?.bodyText ?? answer.dom?.mainText ?? "", elements: answer.dom?.elements ?? [], screenshot: shot });
      if (!shot.ok) record.notes.push(`screenshot ${name}: ${shot.why}`);
    } catch (error) {
      record.views.push({ t: Date.now(), name, error: error.message });
    }
  };

  for (const step of scenario.steps ?? []) {
    if (expired()) {
      record.notes.push(`scenario time (${scenario.minutes} min) ran out before step ${JSON.stringify(step).slice(0, 80)}`);
      break;
    }
    if (step.send) {
      if (step.unlessSent && record.sends.some((send) => send.label === step.unlessSent && !send.skipped && send.answer?.ok !== false)) {
        record.notes.push(`send ${step.label ?? ""}: not needed (${step.unlessSent} went out)`);
        continue;
      }
      const text = textOf(step.text);
      if (TAGGED.test(text)) record.notes.push("scenario text tags someone (should not)");
      const to = await target(step.send);
      if (!to) {
        record.sends.push({ t: Date.now(), to: step.send, label: step.label ?? null, skipped: "no such target yet" });
        record.notes.push(`send ${step.label ?? ""}: no target for ${JSON.stringify(step.send)}`);
        continue;
      }
      const answer = await act("send", { to: to.room ? { room: to.room } : to.mono ? { mono: to.mono } : { session: to.session }, owner: to.owner, text }, 60_000).catch((error) => ({ ok: false, error: error.message }));
      const t = answer.at ?? Date.now();
      record.sends.push({ t, to, label: step.label ?? null, text, answer: { ok: answer.ok, error: answer.error ?? null, session: answer.session ?? null, conversation: answer.conversation ?? null } });
      if (to.mono) lastSendTo.set(to.mono, t);
      if (to.session) lastSendTo.set(to.session, t);
      log(`  Ash -> ${to.room ?? to.mono ?? to.session}: ${text.slice(0, 90).replace(/\n/g, " ")}${answer.ok === false ? ` (NOT ACCEPTED: ${answer.error ?? "refused"})` : ""}`);
    } else if (step.wait) {
      const ref = record.sends.at(-1)?.t ?? t0;
      const limit = Math.min(stop, Date.now() + (step.wait.maxSec ?? 300) * 1000);
      const begun = Date.now();
      let met = false;
      while (Date.now() < limit) {
        if (await conditionMet(step.wait, ref)) {
          met = true;
          break;
        }
        if (overBudget()) {
          record.notes.push(`turn budget (${turnsCap}) reached while waiting for ${JSON.stringify(step.wait)}`);
          break;
        }
        await sleep(2_000);
      }
      record.waits.push({ t: Date.now(), wait: step.wait, met, afterSec: Math.round((Date.now() - begun) / 1000) });
      log(`  wait ${JSON.stringify(step.wait).slice(0, 100)}: ${met ? "met" : "NOT met"} after ${Math.round((Date.now() - begun) / 1000)}s`);
      if (!met && step.required) break;
    } else if (step.sleep) {
      await sleep(Math.min(step.sleep * 1000, Math.max(0, stop - Date.now())));
    } else if (step.stop) {
      const answer = await act("stop", step.stop.mono ? { mono: resolveMono(step.stop.mono) } : { session: step.stop.session }).catch((error) => ({ ok: false, error: error.message }));
      record.sends.push({ t: Date.now(), stop: step.stop, answer });
      log(`  Ash pressed Stop on ${JSON.stringify(step.stop)}`);
    } else if (step.fault !== undefined) {
      const file = path.join(ctx.state, "fault.json");
      if (step.fault) {
        const fault = { ...step.fault, until: Date.now() + (step.fault.maxSec ?? 120) * 1000, set: Date.now() };
        fs.writeFileSync(file, JSON.stringify(fault));
        record.faults.push({ t: Date.now(), on: fault });
        log(`  outage on: ${JSON.stringify(step.fault)}`);
      } else {
        fs.rmSync(file, { force: true });
        record.faults.push({ t: Date.now(), off: true });
        log("  outage off");
      }
    } else if (step.view) await view(step);
    else if (step.snapshot) {
      const snap = await act("snapshot").catch(() => null);
      if (snap) fs.writeFileSync(path.join(dir, `snapshot-${step.snapshot}.json`), JSON.stringify(snap, null, 2));
    } else if (step.mark) record.marks.push({ t: Date.now(), mark: step.mark });
  }
  fs.rmSync(path.join(ctx.state, "fault.json"), { force: true });

  // -- evidence ----------------------------------------------------------------------------------------------------------
  await ctx.pump();
  const ended = Date.now();
  const snap = await act("snapshot").catch(() => null);
  if (snap) fs.writeFileSync(path.join(dir, "snapshot-end.json"), JSON.stringify(snap, null, 2));
  const monoOfSession = Object.fromEntries((snap?.monos ?? []).filter((m) => m.sessionId).map((m) => [m.sessionId, m.id]));
  const titleOf = Object.fromEntries((snap?.sessions ?? []).map((s) => [s.id, s.title]));
  const rows = (await ctx.delegationRows()).filter((row) => ms(row.created_at) >= t0 - 1000 || ms(row.updated_at) >= t0);
  const childOwner = Object.fromEntries((await ctx.delegationRows()).map((row) => [row.child_session, row.owner_mono ?? monoOfSession[row.owner_session] ?? row.owner_session]));
  const texts = (await ctx.claudeTexts(t0)).map((line) => ({
    ...line,
    who: monoOfSession[line.session] ?? (childOwner[line.session] ? `worker of ${childOwner[line.session]}` : line.session ? `chat ${titleOf[line.session] ?? line.session}` : "helper/unknown"),
  }));
  const room = roomMessages(events, roomId, t0);
  const otherRooms = events.filter((e) => e.kind === "room-message" && e.room !== roomId && e.t >= t0);
  const roomErrors = events.filter((e) => e.kind === "room-error" && e.t >= t0);
  const spent = usage(t0);

  // Per-send timings: the first visible answer and the end of the turn.
  for (const send of record.sends) {
    if (!send.to || send.skipped) continue;
    if (send.to.room) {
      const after = room.filter((m) => m.t > send.t && m.from !== ASH);
      send.firstReply = after[0] ? { from: after[0].from, afterSec: Math.round((after[0].t - send.t) / 100) / 10 } : null;
    } else {
      const session = send.answer?.session ?? send.to.session;
      const own = texts.filter((line) => line.session === session && line.t > send.t);
      const firstText = own.find((line) => line.text && !line.result);
      const done = own.find((line) => line.result);
      send.firstReply = firstText ? { afterSec: Math.round((firstText.t - send.t) / 100) / 10, text: firstText.text.slice(0, 200) } : null;
      send.turnEnd = done ? { afterSec: Math.round((done.t - send.t) / 100) / 10, isError: done.isError } : null;
    }
  }

  const metrics = {
    minutes: Math.round((ended - t0) / 600) / 100,
    usage: spent,
    room: { messages: room.length, rounds: roomRounds(room), errors: roomErrors.map((e) => e.error), otherRooms: otherRooms.length },
    delegations: {
      count: rows.length,
      byOwner: rows.reduce((acc, row) => ({ ...acc, [row.owner_mono ?? monoOfSession[row.owner_session] ?? "chat"]: (acc[row.owner_mono ?? monoOfSession[row.owner_session] ?? "chat"] ?? 0) + 1 }), {}),
      states: rows.reduce((acc, row) => ({ ...acc, [row.state]: (acc[row.state] ?? 0) + 1 }), {}),
    },
    workersInRoom: room.filter((m) => m.from && !["ash", "chief-of-staff", "projects-manager", "frank", "alfred", "critiquito"].includes(m.from)).map((m) => m.from),
    replies: record.sends.filter((s) => s.firstReply).map((s) => ({ label: s.label, to: s.to.room ?? s.to.mono ?? s.to.session, firstReplySec: s.firstReply.afterSec, from: s.firstReply.from ?? null, turnEndSec: s.turnEnd?.afterSec ?? null })),
  };
  if (scenario.checks) metrics.checks = runChecks(scenario.checks, { room, texts, events: events.filter((e) => e.t >= t0), memoryCalls: ctx.memoryCalls?.() ?? [] });
  const result = { ...record, ended, metrics, room, otherRooms, texts, delegations: rows, criteria: scenario.criteria ?? "" };
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dir, "transcript.md"), transcript(scenario, result, t0));
  log(`  ${scenario.id}: ${metrics.usage.turns} turns, ${metrics.room.messages} room messages, ${metrics.delegations.count} delegations, ${metrics.minutes} min`);
  return { id: scenario.id, title: scenario.title, bench: scenario.bench ?? [], metrics, notes: record.notes, waits: record.waits };
}

/**
 * Run-wide rule checks: another project's facts showing up (leak), em dashes in what agents wrote to Ash, workers in
 * the room, the same room message twice, console errors, and which projects' memory each chat read.
 */
export function runChecks(checks, { room, texts, events, memoryCalls }) {
  const toAsh = [
    ...room.filter((m) => m.from !== ASH).map((m) => ({ who: m.from, where: "room", text: m.text })),
    ...texts.filter((line) => line.text && !line.result && !String(line.who).startsWith("worker") && !String(line.who).startsWith("helper")).map((line) => ({ who: line.who, where: "chat", text: line.text })),
  ];
  const everything = [...toAsh, ...texts.filter((line) => line.text).map((line) => ({ who: line.who, where: "any", text: line.text }))];
  const leaks = (checks.leak ?? []).flatMap((pattern) =>
    everything.filter((entry) => new RegExp(pattern, "i").test(entry.text)).map((entry) => ({ pattern, who: entry.who, where: entry.where, text: entry.text.slice(0, 240) })),
  );
  const emDashes = toAsh.filter((entry) => /\u2014/.test(entry.text)).map((entry) => ({ who: entry.who, where: entry.where, text: entry.text.slice(0, 160) }));
  const seen = new Map();
  const duplicates = [];
  for (const m of room.filter((x) => x.from !== ASH)) {
    const key = `${m.from}|${m.text.trim().slice(0, 300)}`;
    if (seen.has(key)) duplicates.push({ from: m.from, text: m.text.slice(0, 160) });
    seen.set(key, true);
  }
  const consoleErrors = events.filter((e) => e.kind === "console" && (e.level === "error" || e.level === "uncaught" || e.level === "unhandled")).map((e) => e.text);
  return {
    leaks,
    emDashes: { count: emDashes.length, of: toAsh.length, examples: emDashes.slice(0, 5) },
    duplicateRoomMessages: duplicates,
    tagsByAgents: toAsh.filter((entry) => /(^|\s)@[A-Za-z]/.test(entry.text)).length,
    consoleErrors: { count: consoleErrors.length, distinct: [...new Set(consoleErrors)].slice(0, 15) },
    roomErrors: events.filter((e) => e.kind === "room-error").map((e) => e.error),
    memoryCalls: memoryCalls.map((call) => ({ tool: call.tool, project: call.project, cwd: call.cwd, text: call.text ?? null, error: call.error ?? null })),
  };
}

/** What a reader (and the grader) needs, in time order. */
export function transcript(scenario, result, t0) {
  const lines = [`# ${scenario.id}: ${scenario.title}`, "", `Benchmark: ${(scenario.bench ?? []).join(", ")}`, "", "## What this checks", "", scenario.criteria ?? "", ""];
  const timeline = [];
  for (const send of result.sends) {
    if (send.stop) timeline.push({ t: send.t, line: `**Ash pressed Stop** on ${JSON.stringify(send.stop)}` });
    else if (send.skipped) timeline.push({ t: send.t, line: `(Ash's message "${send.label}" could not be sent: ${send.skipped})` });
    else
      timeline.push({
        t: send.t,
        line: `**Ash -> ${send.to.room ? `room ${send.to.room}` : send.to.mono ? `${send.to.mono} (1:1)` : `worker chat ${send.to.session}`}**${send.answer?.ok === false ? ` (NOT accepted: ${send.answer.error ?? ""})` : ""}: ${send.text}`,
      });
  }
  for (const m of result.room) if (m.from !== ASH) timeline.push({ t: m.t, line: `[room] **${m.from}**${m.quiet ? " (quiet)" : ""}: ${m.text}` });
  for (const m of result.otherRooms) timeline.push({ t: m.t, line: `[room ${m.room}] **${m.from}**: ${m.text}` });
  for (const line of result.texts) {
    if (line.result) {
      if (line.isError) timeline.push({ t: line.t, line: `[${line.who}] turn ended with an ERROR: ${line.text}` });
      continue;
    }
    if (!line.text) continue;
    timeline.push({ t: line.t, line: `[${line.who} chat] ${line.text.slice(0, 1200)}${line.tools?.length ? ` (tools: ${line.tools.join(", ")})` : ""}` });
  }
  for (const f of result.faults) timeline.push({ t: f.t, line: f.off ? "(test harness: outage off)" : `(test harness: model outage on, ${f.on.fixture ?? "529"})` });
  for (const v of result.views) timeline.push({ t: v.t, line: `(looked at ${v.name}${v.screenshot?.ok ? `, screenshot ${v.screenshot.file}` : ""})` });
  timeline.sort((a, b) => a.t - b.t);
  lines.push("## Timeline", "");
  for (const entry of timeline) lines.push(`- ${rel(entry.t, t0)} ${entry.line.replace(/\n+/g, " / ")}`);
  lines.push("", "## Delegations touched", "");
  for (const row of result.delegations)
    lines.push(`- ${row.id} owner ${row.owner_mono ?? row.owner_session} -> ${row.child_session}: "${row.title}" state ${row.state}${row.error_class ? ` (${row.error_class}: ${row.error})` : ""}${row.pending_question ? ` question: ${String(row.pending_question).slice(0, 200)}` : ""}${row.result ? ` result: ${String(row.result).slice(0, 300).replace(/\n/g, " ")}` : ""}`);
  lines.push("", "## Views", "");
  for (const v of result.views) {
    lines.push(`### ${v.name}`, "", "```", String(v.mainText ?? v.error ?? "").slice(0, 2500), "```", "");
  }
  lines.push("## Metrics", "", "```json", JSON.stringify(result.metrics, null, 2), "```", "");
  if (result.notes.length) lines.push("## Harness notes", "", ...result.notes.map((n) => `- ${n}`), "");
  return `${lines.join("\n")}\n`;
}
