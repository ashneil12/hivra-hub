// Hard checks for `npm run hub:realconv` (docs/REALCONV.md): facts read from the hub's own state (room messages,
// chat replies, delegation rows, sessions the hub started, the project's git diff and tests), never from what an agent
// claims. Any automatic fail fails the scene whatever the judge thinks; an expectation the scene card sets that the
// host state doesn't show counts as a missed scene check.

const SEATS = new Set(["ash", "chief-of-staff", "projects-manager", "frank", "alfred", "critiquito"]);
const ACK_WORDS = [
  "noted", "got it", "on it", "+1", "will do", "checking now", "checking", "ready", "ok", "okay", "k", "sure", "done",
  "acknowledged", "understood", "roger", "sounds good", "agreed", "great point", "good point", "thanks", "thank you",
  "nice", "perfect", "yes", "yep", "copy", "copy that", "makes sense", "good", "great", "cool", "all good", "will look",
  "looking", "looking now", "pass from me", "no reply",
];
const ACK_SET = new Set(ACK_WORDS);

/** The words of a message with emoji, punctuation and name prefixes gone, lowercased. */
function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2705\u2714\uFE0F]/gu, " ")
    .replace(/[^a-z0-9+' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * A reply that is only an acknowledgement: every phrase in it is an ack ("Noted.", "Got it, on it.", "+1", "Good,
 * noted."), or a very short line built around "noted"/"acknowledged" ("The copy is fixed, noted."). Empty is not an ack
 * (it's silence, checked elsewhere).
 */
export function isAckOnly(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (/^(no_reply|NO_REPLY)$/.test(raw)) return true;
  const w = words(raw);
  if (!w.length) return /^[\s\u{1F44D}\u2705\u2714\uFE0F]+$/u.test(raw);
  const phrases = raw.toLowerCase().split(/[.,;!\n]+/).map((p) => words(p).join(" ")).filter(Boolean);
  if (phrases.every((p) => ACK_SET.has(p) || p.split(" ").every((x) => ACK_SET.has(x)))) return true;
  return w.length <= 8 && w.some((x) => x === "noted" || x === "acknowledged");
}

/** Lines that echo a scripted marker or instruction rather than talk (the fake bench's VERIFY-WORKER style). */
export function looksScriptedReply(text) {
  return /\b[A-Z]{3,}(?:-[A-Z0-9]{2,})+\b/.test(String(text ?? "")) && words(text).length < 12;
}

/**
 * Every hard check over one scene. Inputs (all from host state):
 *  - toAsh: [{t, who, where: "room"|"chat", text}] what agents wrote where Ash reads (room posts and orchestrator chats)
 *  - ashLines: [{t, text, opening?}] what the tester sent as Ash
 *  - delegations: rows from the hub's database (created_at, updated_at, settled_at, state, owner_mono, owner_session, goal, result)
 *  - origins: {[owner_session or owner_mono]: true} where a handoff's chat-back has to land (the scene's own place)
 *  - stuckSeen: [{t, session, visible: bool, where}] what the player sampled while something was stuck
 *  - workerRoomPosts: room posts from anyone not a seat
 *  - leaks: [{pattern, who, text}] another project's facts found anywhere
 *  - git: {changed: [files], diff}, tests: {command, code, tail} | null
 *  - expect: the scene card's expectations
 */
export function hardChecks(input) {
  const { toAsh = [], ashLines = [], delegations = [], stuckSeen = [], workerRoomPosts = [], leaks = [], git = null, tests = null, expect = {}, sessionsStarted = [], newMonos = [], roomEnded = null } = input;
  const autoFails = [];
  const misses = [];
  const facts = {};

  // 1. Bare acknowledgements, and the same ack three times (a robotic loop).
  // A line written on the way to a tool call ("Checking.") is narration inside a turn, not a reply.
  const acks = toAsh.filter((m) => !m.midTurn && isAckOnly(m.text));
  for (const m of acks) autoFails.push({ check: "ack-only", who: m.who, at: m.t, text: m.text.slice(0, 120) });
  const ackCount = new Map();
  for (const m of acks) ackCount.set(words(m.text).join(" "), (ackCount.get(words(m.text).join(" ")) ?? 0) + 1);
  for (const [ack, n] of ackCount) if (n >= 3) autoFails.push({ check: "ack-loop", text: ack, times: n });
  for (const m of toAsh.filter((x) => looksScriptedReply(x.text))) autoFails.push({ check: "scripted-reply", who: m.who, at: m.t, text: m.text.slice(0, 120) });

  // 2. Scripted prompts from the tester's side make the scene invalid, not failed: it tests nothing.
  facts.scriptedAshLines = ashLines.filter((l) => l.scripted).map((l) => l.text);

  // 3. Handoffs that never chat back: a top-level delegation from the scene's place with nothing said to Ash or the
  //    room after it was made (still running), or after it settled (finished or failed).
  const top = delegations.filter((row) => !row.parent_id);
  const said = (after) => toAsh.some((m) => m.t > after);
  for (const row of top) {
    const made = ms(row.created_at);
    // Settled: the row says when (settled_at), or its state is past running/question (completed, failed, cancelled).
    const settled = row.settled_at ? ms(row.settled_at) : !["running", "question"].includes(row.state) ? ms(row.updated_at) : null;
    if (!said(made)) autoFails.push({ check: "handoff-no-chat-back", delegation: row.id, title: String(row.title ?? "").slice(0, 80), state: row.state });
    else if (settled && !said(settled)) autoFails.push({ check: "handoff-no-report-back", delegation: row.id, title: String(row.title ?? "").slice(0, 80), state: row.state });
  }
  facts.delegations = { count: top.length, states: count(top.map((r) => r.state)) };

  // 4. A stuck worker nobody can see: something sat in question/permission/failed and no sample ever showed it.
  const stuckSessions = [...new Set(stuckSeen.map((s) => s.session))];
  for (const session of stuckSessions) {
    const samples = stuckSeen.filter((s) => s.session === session);
    if (!samples.some((s) => s.visible)) autoFails.push({ check: "stuck-invisible", session, samples: samples.length });
  }
  facts.stuck = { sessions: stuckSessions.length, visible: stuckSessions.filter((s) => stuckSeen.some((x) => x.session === s && x.visible)).length };

  // 5. Work leaking between projects; workers talking in the room.
  for (const leak of leaks) autoFails.push({ check: "project-leak", ...leak });
  for (const post of workerRoomPosts) autoFails.push({ check: "worker-in-room", who: post.who, text: String(post.text).slice(0, 120) });

  // 6. What the scene expects of the host's state.
  facts.agentMessages = toAsh.length;
  facts.seats = [...new Set(toAsh.filter((m) => m.where === "room").map((m) => m.who))];
  facts.sessionsStarted = sessionsStarted.length;
  facts.filesChanged = git?.changed ?? [];
  // Monos made in the scene (they live in the app's home, not the project, so the git diff never shows them).
  facts.newMonos = newMonos;
  facts.tests = tests;
  facts.goals = top.filter((r) => r.goal).map((r) => ({ id: r.id, goal: String(r.goal).slice(0, 120), state: r.state, kept: r.state === "completed" && !!String(r.result ?? "").trim() }));
  if (!toAsh.length) misses.push("no agent said anything where Ash reads");
  if (expect.roomSeatsMin && facts.seats.length < expect.roomSeatsMin) misses.push(`expected at least ${expect.roomSeatsMin} seats to speak in the room, saw ${facts.seats.length}`);
  if (expect.eachSeatOnce) {
    // Ash wrote to the whole room: every seat gets one turn, and a seat with nothing to add says nothing (NO_REPLY).
    const twice = Object.entries(count(toAsh.filter((m) => m.where === "room").map((m) => m.who))).filter(([, n]) => n > 1).map(([who]) => who);
    if (twice.length) misses.push(`a seat replied more than once to one message from Ash: ${twice.join(", ")}`);
  }
  if (expect.delegation && !top.length) misses.push("expected a handoff (a delegation row), none was made");
  if (expect.delegationOrBrief && !top.length && !toAsh.some((m) => /\b(brief|briefed|handed|delegat|started)\b/i.test(m.text))) misses.push("no brief or handoff to start the work");
  if (expect.filesChanged && !facts.filesChanged.length) misses.push("expected the project to change, the git diff is empty");
  if (expect.diffMustMatch && git && !new RegExp(expect.diffMustMatch, "i").test(git.diff ?? "")) misses.push(`the diff never mentions /${expect.diffMustMatch}/`);
  if (expect.diffMustNotMatch && git && new RegExp(expect.diffMustNotMatch, "i").test(git.diff ?? "")) misses.push(`the diff still has /${expect.diffMustNotMatch}/`);
  if (expect.projectTests && tests && tests.code !== 0) misses.push(`the project's tests fail after the scene (${tests.command} exit ${tests.code})`);
  if (expect.roomEnds && roomEnded === false) misses.push("the room never went quiet: it didn't stop and wait for Ash");
  if (expect.noNewMonos && newMonos.length) autoFails.push({ check: "bots-created-without-yes", monos: newMonos });
  if (expect.seatToSeat) {
    const names = /\b(chief of staff|cos|projects? manager|pm|frank|alfred|critiquito|lead)\b/i;
    const roomPosts = toAsh.filter((m) => m.where === "room");
    facts.seatToSeat = roomPosts.filter((m) => names.test(m.text)).length;
    if (!facts.seatToSeat) misses.push("no seat addressed another by name");
  }
  return { autoFails, misses, facts };
}

const ms = (value) => (typeof value === "number" ? value : value ? Date.parse(value) : 0);
const count = (list) => list.reduce((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

export const SEAT_IDS = SEATS;
