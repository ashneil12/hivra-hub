// The real-Claude bench's scenario player (scripts/hub-realtest.mjs, docs/REALTEST.md). A scenario is Ash's side of a
// conversation: timed messages to the leadership room, a Lead, a chat in the project's coding team (a new one, named
// with `as`, then by that name) or a worker, a Stop, an outage, waits on what the team does, and looks at Today /
// Being built / the coding team / the rail. Every wait is bounded by the scenario's minutes and the run's
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
  /** Coding-team chats this scenario started, by the name its steps give them (`as`). */
  const chats = new Map();
  const chatSession = (name) => chats.get(name) ?? null;
  const overBudget = () => usage(t0).turns >= turnsCap;
  const expired = () => Date.now() > stop;
  const resolveMono = (name) => (name === "lead" ? leadId : name);
  const resolveRoom = (name) => (name === "room" || name === "leadership" ? roomId : name.includes(":") ? name : `${name}:leadership`);

  const target = async (to) => {
    if (to.room) return { room: resolveRoom(to.room) };
    if (to.mono) return { mono: resolveMono(to.mono) };
    // A new chat in a project's coding team ("project": the test project), as Ash's New session there makes one.
    // ctx.project is the test project's folder (a path); its hub id is the spec's. Reading `.id` off the path sent
    // `{}` to the driver ("send: no chat for {}", the coding-team run of 20 Oct).
    if (to.codingTeam) return { codingTeam: to.codingTeam === "project" ? (ctx.spec?.project?.id ?? ctx.project?.id) : to.codingTeam };
    if (to.chat) {
      const session = chatSession(to.chat);
      return session ? { session } : null;
    }
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
    if (cond.chatReply || cond.chatText) {
      const session = chatSession(cond.chatReply ?? cond.chatText);
      if (!session) return false;
      const since = cond.chatText ? t0 : (lastSendTo.get(session) ?? ref);
      const lines = (await ctx.claudeTexts(since)).filter((line) => line.session === session);
      if (cond.chatText) return lines.some((line) => line.text && new RegExp(cond.pattern, "i").test(line.text));
      return lines.some((line) => line.result);
    }
    if (cond.monoQuestion) {
      const snap = await act("snapshot");
      const asking = (snap.sessions ?? []).some((x) => x.mono === resolveMono(cond.monoQuestion) && x.question);
      // `gone`: the question it was waiting on is answered (or moved on).
      return cond.gone ? !asking : asking;
    }
    if (cond.monoAnswered) {
      // The chat itself shows a reply after the last cut-turn note (a resumed turn), and its turn is over.
      const snap = await act("snapshot");
      const chat = (snap.sessions ?? []).find((x) => x.mono === resolveMono(cond.monoAnswered));
      // Nothing of Ash's may still wait in its queue: a message that never went in was not answered.
      if (!chat || chat.busy || chat.queued) return false;
      const tail = chat.tail ?? [];
      const after = Math.max(tail.map((block) => block.notice).lastIndexOf("interrupt"), tail.map((block) => block.role).lastIndexOf("user"));
      return tail.slice(after + 1).some((block) => block.role === "assistant" && String(block.text ?? "").trim());
    }
    if (cond.monoSaid) {
      // Anything the Mono wrote (text or a tool call) since Ash's last message to it.
      const monoId = resolveMono(cond.monoSaid);
      const session = await ctx.monoSession(monoId);
      if (!session) return false;
      const since = lastSendTo.get(monoId) ?? ref;
      return (await ctx.claudeTexts(since)).some((line) => line.session === session && !line.result && (line.text || line.tools?.length));
    }
    if (cond.delegation) {
      const rows = (await ctx.delegationRows()).filter((row) => ms(row.created_at) >= t0 - 1000 || ms(row.updated_at) >= t0);
      const match = rows.filter(
        (row) =>
          (!cond.delegation.owner || row.owner_mono === resolveMono(cond.delegation.owner)) &&
          (!cond.delegation.ownerChat || row.owner_session === chatSession(cond.delegation.ownerChat)) &&
          (!cond.delegation.state || [].concat(cond.delegation.state).includes(row.state)) &&
          (!cond.delegation.title || new RegExp(cond.delegation.title, "i").test(`${row.title ?? ""} ${row.brief ?? ""}`)),
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
      // r73: read the page again after the screenshot. The 2 s settle can miss a list that draws late (blind s06: the
      // shot showed Today's Waiting-on-you row while the text the grader read still said "Nothing new here").
      const later = (await act("snapshot").catch(() => null))?.dom;
      const dom = later?.bodyText || later?.mainText ? later : answer.dom;
      record.views.push({ t: Date.now(), name, view: step.view, mainText: dom?.bodyText ?? dom?.mainText ?? "", elements: dom?.elements ?? [], screenshot: shot });
      if (!shot.ok) record.notes.push(`screenshot ${name}: ${shot.why}`);
    } catch (error) {
      record.views.push({ t: Date.now(), name, error: error.message });
    }
  };

  // r79 (c02): Ash lets the bench tap Allow on the dev copy's own permission cards as soon as they show, in the chats
  // the scenario names ({"allowPromptly": ["dump"]}), so a card no longer sits until the next scripted approve step.
  // Only the hub's own Allow cards in this test copy: never a device or account sign-in, never a macOS dialog.
  const allowPromptly = async () => {
    for (const as of scenario.allowPromptly ?? []) {
      const session = chatSession(as);
      if (!session) continue;
      const answer = await act("approve", { session }).catch((error) => ({ ok: false, error: error.message }));
      if (!answer.ok || !answer.approved) continue;
      record.marks.push({ t: Date.now(), approve: { chat: as, promptly: true }, answer });
      log(`  Ash taps Allow in ${as} (as the card showed): ${answer.approved} card(s)`);
    }
  };

  for (const step of scenario.steps ?? []) {
    await allowPromptly();
    if (expired()) {
      record.notes.push(`scenario time (${scenario.minutes} min) ran out before step ${JSON.stringify(step).slice(0, 80)}`);
      break;
    }
    // r76: a send or a Today answer can be skipped when an earlier step (by label) already reached Ash's agent.
    if ((step.send || step.answer) && step.unlessSent && wentOut(record.sends, step.unlessSent)) {
      record.notes.push(`${step.send ? "send" : "answer"} ${step.label ?? ""}: not needed (${[step.unlessSent].flat().join(" or ")} went out)`);
      continue;
    }
    if (step.send) {
      const text = textOf(step.text);
      if (TAGGED.test(text)) record.notes.push("scenario text tags someone (should not)");
      const to = await target(step.send);
      if (!to) {
        record.sends.push({ t: Date.now(), to: step.send, label: step.label ?? null, skipped: "no such target yet" });
        record.notes.push(`send ${step.label ?? ""}: no target for ${JSON.stringify(step.send)}`);
        continue;
      }
      if (to.mono) {
        const snap = await act("snapshot").catch(() => null);
        const chat = (snap?.sessions ?? []).find((x) => x.mono === to.mono);
        if (chat?.question) {
          record.notes.push(`${to.mono} had a question pending for Ash when he wrote "${text.slice(0, 40)}"`);
          if (scenario.takePendingPick) {
            const taken = await act("answer", { mono: to.mono }).catch((error) => ({ ok: false, error: error.message }));
            record.sends.push({ t: Date.now(), todayAnswer: { mono: to.mono, auto: true }, result: taken });
            log(`  (${to.mono} was waiting on a question; Ash tapped Take the pick first: ${taken.ok ? "ok" : taken.error})`);
            await sleep(3000);
          }
        }
      }
      const mode = to.codingTeam && step.runtimeMode ? { runtimeMode: step.runtimeMode } : {};
      const answer = await act("send", { to: to.room ? { room: to.room } : to.mono ? { mono: to.mono } : to.codingTeam ? { codingTeam: to.codingTeam } : { session: to.session }, owner: to.owner, text, ...mode }, 60_000).catch((error) => ({ ok: false, error: error.message }));
      const t = answer.at ?? Date.now();
      record.sends.push({ t, to, label: step.label ?? null, text, answer: { ok: answer.ok, error: answer.error ?? null, session: answer.session ?? null, conversation: answer.conversation ?? null } });
      if (to.mono) lastSendTo.set(to.mono, t);
      if (to.session) lastSendTo.set(to.session, t);
      if (to.codingTeam && answer.session) {
        chats.set(step.as ?? "team", answer.session);
        lastSendTo.set(answer.session, t);
      }
      log(`  Ash -> ${to.room ?? to.mono ?? (to.codingTeam ? `${to.codingTeam}'s coding team (new chat ${answer.session ?? "?"})` : to.session)}: ${text.slice(0, 90).replace(/\n/g, " ")}${answer.ok === false ? ` (NOT ACCEPTED: ${answer.error ?? "refused"})` : ""}`);
    } else if (step.wait) {
      const ref = record.sends.at(-1)?.t ?? t0;
      const limit = Math.min(stop, Date.now() + (step.wait.maxSec ?? 300) * 1000);
      const begun = Date.now();
      let met = false;
      while (Date.now() < limit) {
        await allowPromptly();
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
    } else if (step.approve) {
      // Ash taps Allow on the chat's permission cards ({approve: {chat: "<as>"}}); none waiting is noted, not an error.
      const session = step.approve.chat ? chatSession(step.approve.chat) : step.approve.session ?? null;
      const answer = session ? await act("approve", { session }).catch((error) => ({ ok: false, error: error.message })) : { ok: false, error: "no such chat yet" };
      record.marks.push({ t: Date.now(), approve: step.approve, answer });
      log(`  Ash taps Allow in ${step.approve.chat ?? session}: ${answer.ok ? `${answer.approved} card(s)` : answer.error}`);
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
    } else if (step.answer) {
      const answer = await act("answer", { mono: step.answer.mono ? resolveMono(step.answer.mono) : undefined, session: step.answer.session, text: step.answer.text }).catch((error) => ({ ok: false, error: error.message }));
      record.sends.push({ t: Date.now(), label: step.label, todayAnswer: step.answer, result: answer });
      log(`  Ash answered from Today (${step.answer.text ? "in his words" : "Take the pick"}): ${answer.ok ? `"${String(answer.question ?? "").slice(0, 80)}"` : `not possible: ${answer.error}`}`);
    } else if (step.reload) {
      // The window reloads (a vite full reload, View > Reload): whatever runs is cut the way that cuts it.
      const answer = await act("reload", { afterMs: step.reload.afterMs ?? 300 }).catch((error) => ({ ok: false, error: error.message }));
      record.marks.push({ t: Date.now(), mark: "reload", answer });
      log(`  the window reloads${answer.ok === false ? ` (NOT DONE: ${answer.error})` : ""}`);
      await sleep(1500);
      const back = await act("ping", {}, 120_000).catch(() => null);
      record.marks.push({ t: Date.now(), mark: back?.ok ? "reloaded" : "reload: the driver never came back" });
      log(`  ${back?.ok ? "the reloaded window answers the driver" : "the reloaded window never answered"}`);
    } else if (step.retry) {
      // The "Try again" button on a Mono whose last turn failed (Today, Being built, the rail).
      const answer = await act("retry", { mono: resolveMono(step.retry.mono) }).catch((error) => ({ ok: false, error: error.message }));
      record.sends.push({ t: Date.now(), retry: step.retry, answer });
      if (step.retry.mono) lastSendTo.set(resolveMono(step.retry.mono), Date.now());
      log(`  Ash tapped Try again on ${step.retry.mono}: ${answer.ok ? "ok" : `not possible: ${answer.error}`}`);
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
  const teamName = Object.fromEntries([...chats].map(([name, session]) => [session, `coding-team chat "${name}"`]));
  const childOwner = Object.fromEntries((await ctx.delegationRows()).map((row) => [row.child_session, row.owner_mono ?? monoOfSession[row.owner_session] ?? teamName[row.owner_session] ?? row.owner_session]));
  const texts = (await ctx.claudeTexts(t0)).map((line) => ({
    ...line,
    who: monoOfSession[line.session] ?? teamName[line.session] ?? (childOwner[line.session] ? `worker of ${childOwner[line.session]}` : line.session ? `chat ${titleOf[line.session] ?? line.session}` : "app helper call (room router or title; never shown to Ash)"),
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
      // First words Ash could read: a live message (the turn's words as it writes them) or a landed one.
      const shown = events.filter((e) => (e.kind === "room-draft" || e.kind === "room-message") && e.room === send.to.room && e.t > send.t && e.from !== ASH)[0];
      send.firstWords = shown ? { from: shown.from, afterSec: Math.round((shown.t - send.t) / 100) / 10, live: shown.kind === "room-draft" } : null;
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
    // Parallel workers (baseline, 20 Oct: two shared port 4317 and one killed the other's server): each brief's port,
    // and which workers had a checkout of their own.
    workers: workerSpread(rows, snap?.sessions ?? []),
    workersInRoom: room.filter((m) => m.from && !["ash", "chief-of-staff", "projects-manager", "frank", "alfred", "critiquito"].includes(m.from)).map((m) => m.from),
    replies: record.sends.filter((s) => s.firstReply).map((s) => ({ label: s.label, to: s.to.room ?? s.to.mono ?? (s.to.codingTeam ? `coding team (${s.answer?.session})` : s.to.session), firstReplySec: s.firstReply.afterSec, from: s.firstReply.from ?? null, turnEndSec: s.turnEnd?.afterSec ?? null, firstWordsSec: s.firstWords?.afterSec ?? null })),
    // Room posts' length (Ash: short, a few lines).
    postChars: room.filter((m) => m.from !== ASH && m.text).map((m) => m.text.length),
  };
  if (scenario.checks) metrics.checks = runChecks(scenario.checks, { room, texts, saved: await savedChatTexts(ctx, texts, t0), events: events.filter((e) => e.t >= t0), memoryCalls: ctx.memoryCalls?.() ?? [] });
  const result = { ...record, ended, metrics, room, otherRooms, texts, answers: questionAnswers(ctx.state, t0), delegations: rows, criteria: scenario.criteria ?? "" };
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dir, "transcript.md"), transcript(scenario, result, t0));
  log(`  ${scenario.id}: ${metrics.usage.turns} turns, ${metrics.room.messages} room messages, ${metrics.delegations.count} delegations, ${metrics.minutes} min`);
  return { id: scenario.id, title: scenario.title, bench: scenario.bench ?? [], metrics, notes: record.notes, waits: record.waits, chats: Object.fromEntries(chats) };
}

/** The workers of the rows: the port each brief gave it, whether those ports are all different, and their checkouts. */
export function workerSpread(rows, sessions) {
  const workers = rows.filter((row) => !row.follow && String(row.brief ?? "").startsWith("[MonoCode brief from "));
  const ports = workers.map((row) => {
    const found = /\bPORT=(\d{4,5})\b/.exec(String(row.brief ?? ""));
    return found ? Number(found[1]) : null;
  });
  const given = ports.filter((port) => port != null);
  const worktreeOf = Object.fromEntries(sessions.map((session) => [session.id, session.worktree ?? null]));
  return {
    count: workers.length,
    ports,
    distinctPorts: new Set(given).size === given.length,
    ownCheckouts: workers.filter((row) => worktreeOf[row.child_session]).length,
  };
}

/**
 * What the app answered Claude's AskUserQuestion calls with (the control_response lines the claude wrapper logs): the
 * proof an answer reached the agent, not just the screen.
 */
export function questionAnswers(state, since = 0) {
  const logs = path.join(state ?? "", "claude");
  if (!state || !fs.existsSync(logs)) return [];
  const out = [];
  for (const name of fs.readdirSync(logs).filter((n) => n.endsWith(".ndjson"))) {
    for (const raw of fs.readFileSync(path.join(logs, name), "utf8").split("\n")) {
      if (!raw.includes('"control-answer"')) continue;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (entry.dir !== "control-answer" || entry.t < since) continue;
      let message;
      try {
        message = JSON.parse(entry.line);
      } catch {
        continue;
      }
      const response = message.response?.response ?? {};
      const answers = response.updatedInput?.answers;
      if (!answers && response.behavior !== "deny") continue;
      out.push({ t: entry.t, pid: name.replace(".ndjson", ""), behavior: response.behavior ?? null, answers: answers ?? null, message: response.message ?? null });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Did the step labelled `label` reach its target? A chat send that failed, or a Today answer with nothing waiting, did not. */
export function wentOut(sends, label) {
  const labels = [label].flat();
  return sends.some((send) => labels.includes(send.label) && !send.skipped && send.answer?.ok !== false && send.result?.ok !== false);
}

/** Whose lines Ash reads: not a worker's, not the app's own helper calls. */
const readByAsh = (who) => !String(who).startsWith("worker") && !String(who).startsWith("app helper");

/**
 * r77: what the app saved for each chat Ash reads (its assistant blocks since t0), as he sees it. The raw stream is what
 * the model wrote before the app cleans it (withoutEmDashes on a sealed block), so the em dash check reads this.
 */
export async function savedChatTexts(ctx, texts, t0) {
  if (!ctx.sessionBlocks) return undefined;
  const whoOf = new Map();
  for (const line of texts) if (line.session && line.text && !line.result && readByAsh(line.who)) whoOf.set(line.session, line.who);
  const out = [];
  for (const [session, who] of whoOf) {
    const blocks = await ctx.sessionBlocks(session).catch(() => []);
    for (const block of blocks)
      if (block?.role === "assistant" && !block.internal && typeof block.text === "string" && block.text.trim() && !(typeof block.startedAt === "number" && block.startedAt < t0))
        out.push({ who, session, text: block.text });
  }
  return out;
}

/**
 * Run-wide rule checks: another project's facts showing up (leak), em dashes in what agents wrote to Ash, workers in
 * the room, the same room message twice, console errors, and which projects' memory each chat read. `saved` (r77): the
 * chats' saved text, read for em dashes instead of the raw stream when given.
 */
export function runChecks(checks, { room, texts, saved, events, memoryCalls }) {
  const roomToAsh = room.filter((m) => m.from !== ASH).map((m) => ({ who: m.from, where: "room", text: m.text }));
  const toAsh = [
    ...roomToAsh,
    ...texts.filter((line) => line.text && !line.result && readByAsh(line.who)).map((line) => ({ who: line.who, where: "chat", text: line.text })),
  ];
  const shownToAsh = saved ? [...roomToAsh, ...saved.map((line) => ({ who: line.who, where: "chat (saved)", text: line.text }))] : toAsh;
  const everything = [...toAsh, ...texts.filter((line) => line.text).map((line) => ({ who: line.who, where: "any", text: line.text }))];
  const leaks = (checks.leak ?? []).flatMap((pattern) =>
    everything.filter((entry) => new RegExp(pattern, "i").test(entry.text)).map((entry) => ({ pattern, who: entry.who, where: entry.where, text: entry.text.slice(0, 240) })),
  );
  const emDashes = shownToAsh.filter((entry) => /\u2014/.test(entry.text)).map((entry) => ({ who: entry.who, where: entry.where, text: entry.text.slice(0, 160) }));
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
    emDashes: { count: emDashes.length, of: shownToAsh.length, read: saved ? "saved" : "stream", examples: emDashes.slice(0, 5) },
    duplicateRoomMessages: duplicates,
    tagsByAgents: toAsh.filter((entry) => /(^|\s)@[A-Za-z]/.test(entry.text)).length,
    consoleErrors: { count: consoleErrors.length, distinct: [...new Set(consoleErrors)].slice(0, 15) },
    roomErrors: events.filter((e) => e.kind === "room-error").map((e) => e.error),
    memoryCalls: memoryCalls.map((call) => ({ tool: call.tool, project: call.project, cwd: call.cwd, text: call.text ?? null, error: call.error ?? null })),
  };
}

/** What a reader (and the grader) needs, in time order. */
// A chat line as the grader reads it: whole up to the cap, and plainly marked when the harness cuts it (r76: a
// silent 1200-character cut made s13's full reply look cut off at "28. T").
const CHAT_LINE_MAX = 6000;
function chatLine(text) {
  return text.length <= CHAT_LINE_MAX ? text : `${text.slice(0, CHAT_LINE_MAX)} [${text.length - CHAT_LINE_MAX} more characters clipped by the test harness, not by the chat]`;
}

export function transcript(scenario, result, t0) {
  const lines = [`# ${scenario.id}: ${scenario.title}`, "", `Benchmark: ${(scenario.bench ?? []).join(", ")}`, "", "## What this checks", "", scenario.criteria ?? "", ""];
  const timeline = [];
  for (const send of result.sends) {
    if (send.stop) timeline.push({ t: send.t, line: `**Ash pressed Stop** on ${JSON.stringify(send.stop)}` });
    else if (send.todayAnswer)
      timeline.push({ t: send.t, line: `**Ash answered from Today** (${send.todayAnswer.text ? `in his words: "${send.todayAnswer.text}"` : "Take the pick"}${send.todayAnswer.auto ? ", because the chat was waiting on him" : ""}): ${send.result?.ok ? `question "${send.result.question ?? ""}"; the agent had suggested "${send.result.recommended ?? send.result.pick ?? ""}"; Ash's decision: "${send.result.decision ?? send.todayAnswer.text ?? send.result.recommended ?? send.result.pick ?? ""}"` : `not possible: ${send.result?.error}`}` });
    else if (send.retry) continue;
    else if (send.skipped) timeline.push({ t: send.t, line: `(Ash's message "${send.label}" could not be sent: ${send.skipped})` });
    else
      timeline.push({
        t: send.t,
        line: `**Ash -> ${send.to.room ? `room ${send.to.room}` : send.to.mono ? `${send.to.mono} (1:1)` : send.to.codingTeam ? `a new chat in ${send.to.codingTeam}'s coding team` : `chat ${send.to.session}`}**${send.answer?.ok === false ? ` (NOT accepted: ${send.answer.error ?? ""})` : ""}: ${send.text}`,
      });
  }
  for (const m of result.room) if (m.from !== ASH) timeline.push({ t: m.t, line: `[room] **${m.from}**${m.quiet ? " (quiet)" : ""}: ${m.text}` });
  for (const m of result.otherRooms) timeline.push({ t: m.t, line: `[room ${m.room}] **${m.from}**: ${m.text}` });
  for (const line of result.texts) {
    if (line.result) {
      if (line.isError) timeline.push({ t: line.t, line: `[${line.who}] turn ended with an ERROR: ${line.text}` });
      continue;
    }
    const asked = (line.tools ?? []).filter((tool) => String(tool).startsWith("AskUserQuestion:"));
    if (asked.length) timeline.push({ t: line.t, line: `[${line.who} chat] asks with buttons: ${asked.join(" ; ").replace("AskUserQuestion: ", "")}` });
    if (!line.text) continue;
    timeline.push({ t: line.t, line: `[${line.who} chat] ${chatLine(line.text)}${line.tools?.length ? ` (tools: ${line.tools.filter((tool) => !String(tool).startsWith("AskUserQuestion:")).join(", ")})` : ""}` });
  }
  for (const a of result.answers ?? [])
    timeline.push({ t: a.t, line: a.answers ? `(the app answered the question in Claude: ${JSON.stringify(a.answers).slice(0, 400)})` : `(the app declined the question in Claude: ${a.message ?? a.behavior})` });
  for (const s of result.sends) if (s.retry) timeline.push({ t: s.t, line: `**Ash tapped Try again** on ${s.retry.mono}: ${s.answer?.ok ? "ok" : `not possible: ${s.answer?.error}`}` });
  for (const m of result.marks ?? []) if (String(m.mark).startsWith("reload")) timeline.push({ t: m.t, line: `(test harness: ${m.mark === "reload" ? "the window reloads" : m.mark})` });
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
