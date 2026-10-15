// A tiny stand-in for Ash OS's hub API, for developing and testing the hub app without the real service.
//
// It answers the documented shapes (docs/HUB-BACKEND.md in exo-cc-studio, ashos/hub.py): POST /api/ash-hub-<name>,
// GET|POST /api/ash-hub-events (JSON poll, long poll, server-sent events), the same bearer token, Host and Origin
// checks, ISO timestamps with a Z. It is NOT the service: no ledger, no model, no real data. Everything here is
// invented and every title starts with "Example:".
//
//   node scripts/hub-stub-server.mjs --port 18868 --token-file /tmp/hub-stub/token [--dev]
//
// `--dev` (browser dev page only) adds CORS, GET /__stub/token and POST /__stub/control {op, ...} so a page that
// stands in for the Rust plugin can reach it and a person can move things while the page is open. The real service
// has none of that. In tests, `startStub()` returns an object that moves things directly.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IDLE_SECONDS = 1800;
const NEEDS_SHOWN = 5;
const DONE_KEEP = 600;

const TOPICS = [
  [/^(question|ask)\./, ["needs", "asks"]],
  [/^dump\./, ["asks"]],
  [/^hub\.need\./, ["needs"]],
  [/^(hub\.project\.|project\.created)/, ["projects"]],
  [/^hub\.activity\./, ["activity", "since"]],
  [/^hub\.since\./, ["since"]],
  [/^hub\.mono\./, ["monos"]],
  [/^hub\.memory\./, ["memory"]],
  [/^hub\.lead\./, ["lead"]],
  [/^hub\.job\./, ["jobs"]],
  [/^hub\.code\./, ["service"]],
];
const topicsOf = (kind) => (TOPICS.find(([re]) => re.test(kind)) || [null, []])[1];
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));

/** "2:20pm", in this machine's own time zone (what the real service puts in sentText). */
const clock = (ms) => {
  const d = new Date(ms);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${d.getHours() < 12 ? "am" : "pm"}`;
};

const ACTION_LABELS = { start: "Start", open: "Open", sign_in: "Sign in", see_options: "See options", accept: "Looks right" };

/** The invented starting state: four projects, a few Needs, a "since" paragraph. */
export function seedState(now = Date.now()) {
  const h = 3600_000;
  return {
    projects: [
      { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "folder", folder: "/Users/example/Projects/vg-game", workOwner: "ash_os", status: "active" },
      { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder", folder: "/Users/example/Projects/hivra", workOwner: "ash_os", status: "active" },
      { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "folder", folder: "/Users/example/Projects/nibbii", workOwner: "ash_os", status: "active" },
      { id: "ash", name: "Harness & how I work", shortName: "Harness", iconShape: "folder", folder: null, workOwner: "ash_os", status: "active" },
    ],
    needs: [
      { id: "q1", projectId: "vg-game", title: "Example: play Areas 1 and 2", why: "The new level changed how these play. It needs your hands on it.", actionType: "start", actionTarget: "gate:project:playtests", rank: 1, since: now - 5 * h },
      { id: "q2", projectId: "vg-game", title: "Example: skim the new game rules", why: "Four rules written down. Check they match what you meant.", actionType: "see_options", actionTarget: "question:q2", rank: 2, since: now - 4 * h },
      { id: "q3", projectId: "hivra", title: "Example: pick the waitlist headline", why: "Two versions tested about the same. Your taste call.", actionType: "see_options", actionTarget: "question:q3", rank: 2, since: now - 3 * h },
      { id: "q4", projectId: "ash", title: "Example: approve the Q4 hiring plan", why: "Two roles changed since last week.", actionType: "open", actionTarget: "ask:a4", rank: 3, since: now - 2 * h },
      { id: "q5", projectId: "ash", title: "Example: sign the vendor renewal", why: "Due Friday; price is unchanged.", actionType: "open", actionTarget: "ask:a5", rank: 3, since: now - 2 * h },
      { id: "q6", projectId: "ash", title: "Example: review the on-call rota", why: "Next month has a gap on the 12th.", actionType: "open", actionTarget: "ask:a6", rank: 3, since: now - 2 * h },
      { id: "q7", projectId: "ash", title: "Example: pick the offsite dates", why: "Three options; everyone else has voted.", actionType: "see_options", actionTarget: "question:q7", rank: 3, since: now - 2 * h },
      { id: "q8", projectId: "ash", title: "Example: check the budget summary", why: "Spend is 4% under plan.", actionType: "open", actionTarget: "ask:a8", rank: 3, since: now - 2 * h },
      { id: "q9", projectId: "ash", title: "Example: renew the domain names", why: "Recovered from an old chat. Nothing is due.", actionType: "see_options", actionTarget: "question:q9", rank: 9, later: true, since: now - 30 * h },
    ].map((n) => ({ later: false, state: "open", ...n })),
    activity: { lastActive: now - 20 * 60_000, since: now - 6 * h, sessionStart: now - 25 * 60_000 },
    since: {
      overall: "Example: the game's new level is in and working. Hivra has a headline to pick. the harness has five decisions waiting for you.",
      projects: {
        "vg-game": "Example: the new level is in and working. Two things need your hands.",
        hivra: "Example: the waitlist headline is waiting for your pick.",
        ash: "Example: five decisions are waiting for you.",
      },
      details: ["EXO - Example: level 3 build finished (card c-101)", "Hivra - Example: headline test finished (ask a-77)"],
    },
    memberships: [
      { monoId: "chief-of-staff", projectId: "vg-game", role: "member", addedAt: iso(now - 90 * h) },
      { monoId: "chief-of-staff", projectId: "hivra", role: "member", addedAt: iso(now - 90 * h) },
    ],
  };
}

/**
 * The jobs scenario (`startStub({ jobs: true })`, `--jobs`): leads and jobs in every state, a given-up job as its red
 * Needs row, a Looks-right row, and older questions. Kept apart so the plain stub stays small.
 */
export function jobsScenario(now = Date.now()) {
  const min = 60_000;
  const iso2 = (ms) => iso(ms);
  const job = (id, projectId, title, state, extra = {}) => ({
    id, projectId, title, lead: extra.noLead ? null : `${projectId}-lead`, leadName: extra.noLead ? null : `${projectId === "vg-game" ? "EXO" : projectId[0].toUpperCase() + projectId.slice(1)} lead`,
    owner: "in-app-lead", state, reason: "", startedAt: iso2(now - (extra.ago ?? 40) * min), lastActiveAt: iso2(now - (extra.active ?? 1) * min),
    finishedAt: null, sourceRef: `ask:a_${id}`, seen: false, ...extra.wire,
  });
  const jobs = [
    job("j_air", "vg-game", "Adding the air dodge", "working", { ago: 42, active: 0 }),
    job("j_save", "vg-game", "Fixing the save bug", "checking", { ago: 12, active: 2 }),
    job("j_photo", "vg-game", "The photo mode", "parked", { ago: 300, active: 160, wire: { reason: "Paused by you", finishedAt: iso2(now - 160 * min) } }),
    job("j_mail", "hivra", "Writing the welcome emails", "working", { ago: 25, active: 3 }),
    job("j_backup", "hivra", "Moving the nightly backup", "sent_to_lead", {
      ago: 130, active: 6,
      wire: { reason: "The disk was full twice.", circle: "amber", word: "Stuck", sentAt: iso2(now - 20 * min), sentText: "Sent to coding team lead at 2:20pm", gotIt: { at: iso2(now - 19 * min), text: "Got it" } },
    }),
    job("j_sender", "hivra", "Sending the waitlist emails", "lead_gave_up", {
      ago: 200, active: 55,
      wire: { reason: "The email sender refused the login.", circle: "red", word: "Needs you", tried: ["the runner's own attempt", "splitting the job", "a different worker"], why: "Coding team lead tried splitting the job and a different worker since 11:10am, still failing. Tried before it reached the lead: the runner's own attempt." },
    }),
    job("j_footer", "hivra", "Fixing the footer link", "done", { ago: 90, active: 30, wire: { finishedAt: iso2(now - 30 * min) } }),
    job("j_sound", "nibbii", "Tidying the sound files", "stuck", { noLead: true, ago: 80, active: 14, wire: { reason: "No sound card in the test box.", circle: "amber", word: "Stuck" } }),
  ];
  const needs = [
    { id: "s:a_cannon", projectId: "nibbii", title: "Example: rework the app's notch pet", why: "Finished and flagged critical: check it, then tap Looks right.", actionType: "accept", actionTarget: "ask:a_cannon", rank: 3, since: now - 6 * 3600_000, state: "open", later: false },
    // What Ash OS sent for a Looks-right row before "accept" existed: action Open, marked seen instead.
    { id: "s:a_legacy", projectId: "nibbii", title: "Example: tidy the settings page", why: "Finished and flagged critical: check it, then tap Looks right.", actionType: "open", actionTarget: "ask:a_legacy", rank: 3, since: now - 7 * 3600_000, state: "open", later: false },
    { id: "j:j_sender", projectId: "hivra", title: "Sending the waitlist emails", why: "Coding team lead tried splitting the job and a different worker since 11:10am, still failing. Tried before it reached the lead: the runner's own attempt.", actionType: "see_options", actionTarget: "job:j_sender", rank: 0, since: now - 55 * min, state: "open", later: false, circle: "red", word: "Needs you" },
    ...[
      ["o1", "hivra", "Example: which Hivra folder is the real one?"], ["o2", "hivra", "Example: should the old waitlist be archived?"],
      ["o3", "vg-game", "Example: is the second boss still wanted?"],
    ].map(([id, projectId, title], i) => ({ id: `q:${id}`, projectId, title, why: "Recovered from an old chat. Nothing is due.", actionType: "see_options", actionTarget: `question:${id}`, rank: 9, since: now - (30 + i) * 3600_000, state: "open", later: false, older: true })),
  ];
  return { jobs, needs };
}

/** Start a stub. Returns {port, url, token, state, calls, ...moves, close()}. */
export async function startStub({
  port = 0,
  token = "stub-token-not-a-real-key",
  tokenFile,
  dev = false,
  pingMs = 15_000,
  pendingSinceOnce = false,
  jobs: withJobs = false,
  seq = 100,
  now = () => Date.now(),
} = {}) {
  const state = seedState(now());
  state.jobs = [];
  if (withJobs) {
    const extra = jobsScenario(now());
    state.jobs = extra.jobs;
    state.needs.push(...extra.needs);
  }
  const events = [];
  let latest = seq;
  const calls = [];
  const sseClients = new Set();
  const waiters = new Set();
  let sinceReady = !pendingSinceOnce;
  let currentToken = token;
  let httpServer;

  const writeToken = () => {
    if (!tokenFile) return;
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, currentToken, { mode: 0o600 });
  };
  writeToken();

  function emit(kind, ref = null, project) {
    latest += 1;
    const e = { seq: latest, kind, ref, topics: topicsOf(kind), at: iso(now()), ...(project ? { project } : {}) };
    events.push(e);
    for (const w of [...waiters]) w();
    return e;
  }

  const eventsAfter = (after, topics) => {
    const wanted = new Set(topics || []);
    return events.filter((e) => e.seq > after && e.topics.length && (!wanted.size || e.topics.some((t) => wanted.has(t))));
  };

  function feed(after, topics, limit = 500) {
    if (after > latest) return { events: [], latest, cursor: latest, reset: true };
    const list = eventsAfter(after, topics).slice(0, limit);
    return { events: list, latest, cursor: list.length === limit ? list[list.length - 1].seq : latest };
  }

  function waitEvents(after, timeoutSeconds, topics) {
    const first = feed(after, topics);
    if (first.events.length || first.reset || !timeoutSeconds) return Promise.resolve(first);
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.min(timeoutSeconds, 25) * 1000);
      function done() {
        clearTimeout(timer);
        waiters.delete(check);
        resolve(feed(after, topics));
      }
      const check = () => {
        if (eventsAfter(after, topics).length) done();
      };
      waiters.add(check);
    });
  }

  // ---- the calls ---------------------------------------------------------------------------------------------------
  const openNeeds = () => state.needs.filter((n) => n.state === "open" && !n.older);
  const row = (n) => {
    const r = { id: n.id, projectId: n.projectId, title: n.title, why: n.why, actionType: n.actionType, actionLabel: ACTION_LABELS[n.actionType], actionTarget: n.actionTarget, state: n.state, since: iso(n.since) };
    if (n.detail) r.detail = n.detail;
    if (n.circle) Object.assign(r, { circle: n.circle, word: n.word });
    if (n.later || n._later) r.later = true;
    if (n.state === "done") {
      r.doneAt = iso(n.doneAt);
      r.doneReason = n.doneReason;
    }
    return r;
  };

  function projectsCall(v) {
    const counts = {};
    for (const n of openNeeds()) counts[n.projectId] = (counts[n.projectId] || 0) + 1;
    return {
      projects: state.projects
        .filter((p) => v.include_archived || !p.archived)
        .map((p) => ({ ...p, ...(counts[p.id] ? { needsCount: counts[p.id] } : {}) })),
      seq: latest,
    };
  }

  function needsCall(v) {
    const keep = Number(v.keep_done ?? DONE_KEEP) * 1000;
    const t = now();
    if (v.project && !state.projects.some((p) => p.id === v.project)) throw new Error(`Unknown project: ${v.project}`);
    const byProject = new Map();
    const older = [];
    for (const n of state.needs) {
      if (n.older) {
        if (n.state === "open" && (!v.project || n.projectId === v.project)) older.push(n);
        continue;
      }
      if (v.project && n.projectId !== v.project) continue;
      if (n.state === "done" && !(n.doneAt > t - keep)) continue;
      if (!byProject.has(n.projectId)) byProject.set(n.projectId, []);
      byProject.get(n.projectId).push(n);
    }
    const names = Object.fromEntries(state.projects.map((p) => [p.id, p.name]));
    const out = [];
    for (const [pid, items] of byProject) {
      const opened = items.filter((n) => n.state === "open").sort((a, b) => a.rank - b.rank || b.since - a.since);
      const main = opened.filter((n) => !n.later);
      const shown = main.slice(0, NEEDS_SHOWN);
      const later = [...main.slice(NEEDS_SHOWN), ...opened.filter((n) => n.later)];
      const entry = { projectId: pid, projectName: names[pid] || pid, shown: shown.map(row), later: later.map((n) => row({ ...n, _later: true })), done: items.filter((n) => n.state === "done").map(row) };
      const n = shown.length + later.length;
      if (n) entry.count = n;
      if (n || entry.done.length) out.push(entry);
    }
    out.sort((a, b) => (b.count || 0) - (a.count || 0) || a.projectName.localeCompare(b.projectName));
    older.sort((a, b) => b.since - a.since);
    return {
      projects: out, setup: [], ...(older.length ? { older: { count: older.length, rows: older.map(row) } } : {}),
      notes: { unreadableBoards: [], stale: false }, total: out.reduce((s, e) => s + (e.count || 0), 0), seq: latest, at: iso(t),
    };
  }

  const activityCall = () => ({ lastActiveAt: iso(state.activity.lastActive), sinceAt: iso(state.activity.since), sessionStartedAt: iso(state.activity.sessionStart), idleSeconds: IDLE_SECONDS });

  function activeCall(v) {
    const t = now();
    let stamp = v.at == null || v.at === "" ? t : typeof v.at === "number" ? (v.at > 1e11 ? v.at : v.at * 1000) : Date.parse(v.at);
    if (!Number.isFinite(stamp)) stamp = t;
    stamp = Math.min(stamp, t);
    const a = state.activity;
    let resumed = false;
    if (a.lastActive == null) {
      Object.assign(a, { lastActive: stamp, sessionStart: stamp, since: null });
      resumed = true;
    } else {
      if (stamp - a.lastActive > IDLE_SECONDS * 1000) {
        Object.assign(a, { since: a.lastActive, sessionStart: stamp });
        resumed = true;
      }
      a.lastActive = Math.max(a.lastActive, stamp);
    }
    if (v.mark_seen) a.since = t;
    if (resumed) emit("hub.activity.resumed", null);
    return activityCall();
  }

  function sinceCall(v) {
    const only = v.project ? state.projects.find((p) => p.id === v.project)?.id : null;
    if (v.project && !only) throw new Error(`Unknown project: ${v.project}`);
    const assumed = !state.activity.since && !v.since;
    const sinceMs = v.since ? Date.parse(v.since) : state.activity.since || now() - 24 * 3600_000;
    const head = { sinceAt: iso(sinceMs), assumed, lastActiveAt: iso(state.activity.lastActive) };
    const pending = !sinceReady;
    const plainText = only ? state.since.projects[only] || "Nothing finished and nothing new was decided. Nothing is waiting on you." : pending ? "Some things happened. The details are on their way." : state.since.overall;
    const summary = { plainText, details: state.since.details.join("\n"), detailLines: state.since.details, source: pending ? "fallback" : "model", pending };
    return only ? { ...head, summary } : { ...head, summary, projects: Object.fromEntries(Object.entries(state.since.projects).map(([k, t]) => [k, { plainText: t, details: "", detailLines: [] }])) };
  }

  function monoProjectsCall(v) {
    const list = state.memberships.filter((m) => (!v.project || m.projectId === v.project) && (!v.mono_id || m.monoId === v.mono_id));
    const byProject = {};
    const byMono = {};
    for (const m of list) {
      (byProject[m.projectId] ||= []).push(m.monoId);
      (byMono[m.monoId] ||= []).push(m.projectId);
    }
    return { memberships: list, byProject, byMono };
  }

  // ---- jobs ---------------------------------------------------------------------------------------------------------
  const findJob = (id) => state.jobs.find((j) => j.id === id);
  const needOf = (jobId) => state.needs.find((n) => n.id === `j:${jobId}`);
  const OPTIONS = [
    { id: "try_tonight", label: "Try again tonight", needsText: false, note: "It runs again tonight." },
    { id: "try_different", label: "Try it a different way\u2026", needsText: true, note: "You type a hint and it goes to the coding team lead.", placeholder: "A hint for the coding team lead" },
    { id: "pause", label: "Pause this job", needsText: false, note: "The job is parked and nothing runs until you bring it back." },
    { id: "drop", label: "Drop it", needsText: false, note: "The job stops and its ask is marked dropped. Your words stay in the record; nothing is deleted." },
  ];
  function jobsCall(v) {
    if (v.project && !state.projects.some((p) => p.id === v.project)) throw new Error(`Unknown project: ${v.project}`);
    const groups = new Map();
    for (const j of state.jobs) {
      if (j.state === "dropped" || (j.state === "done" && j.seen) || (v.project && j.projectId !== v.project)) continue;
      const key = `${j.projectId}|${j.lead ?? ""}`;
      if (!groups.has(key)) groups.set(key, { leadId: j.lead, leadName: j.leadName ?? `${state.projects.find((p) => p.id === j.projectId)?.name} (no lead yet)`, projectId: j.projectId, jobs: [] });
      groups.get(key).jobs.push(j);
    }
    return { groups: [...groups.values()], seq: latest, at: iso(now()) };
  }
  function jobOptionsCall(v) {
    const j = findJob(v.job_id);
    if (!j) throw new Error("No such job.");
    if (j.state !== "lead_gave_up") throw new Error("That job isn't waiting on you.");
    return { jobId: j.id, projectId: j.projectId, title: j.title, why: j.why ?? "", options: OPTIONS };
  }
  function jobActCall(v) {
    const j = findJob(v.job_id);
    if (!j) throw new Error("No such job.");
    if (j.state !== "lead_gave_up") throw new Error("That job isn't waiting on you.");
    const option = OPTIONS.find((o) => o.id === v.option);
    if (!option) throw new Error("Pick one of the options.");
    if (option.needsText && !String(v.hint || "").trim()) throw new Error("Say what to try.");
    const t = now();
    if (v.option === "try_tonight") Object.assign(j, { state: "working", reason: "Trying again tonight at 2:00am", retryAt: iso(t + 3600_000) });
    else if (v.option === "try_different") Object.assign(j, { state: "sent_to_lead", reason: "Trying it your way", hint: String(v.hint).trim(), circle: "amber", word: "Stuck", sentText: `Sent to coding team lead at ${clock(t)}`, gotIt: null });
    else if (v.option === "pause") Object.assign(j, { state: "parked", reason: "Paused by you", finishedAt: iso(t) });
    else Object.assign(j, { state: "dropped" });
    delete j.tried;
    delete j.why;
    if (j.state !== "sent_to_lead") {
      delete j.circle;
      delete j.word;
    }
    j.lastActiveAt = iso(t);
    const need = needOf(j.id);
    if (need && need.state === "open") Object.assign(need, { state: "done", doneAt: t, doneReason: "answered" });
    emit("hub.job.acted", j.id, j.projectId);
    emit("hub.job.changed", j.id, j.projectId);
    if (need) emit("hub.need.done", need.id, j.projectId);
    return { job: j, option: v.option };
  }
  function jobSeenCall(v) {
    const ids = Array.isArray(v.job_ids) ? v.job_ids : v.job_id ? [v.job_id] : [];
    let n = 0;
    for (const id of ids) {
      const j = findJob(id);
      if (j && j.state === "done" && !j.seen) {
        j.seen = true;
        n += 1;
      }
    }
    if (n) emit("hub.job.changed", ids[0]);
    return { seen: n };
  }
  function needSeenCall(v) {
    const n = state.needs.find((x) => x.id === v.id);
    if (!n || n.state !== "open") throw new Error("That isn't waiting on you any more.");
    if (!String(n.id).startsWith("s:")) throw new Error("Only a Looks-right row can be marked seen.");
    Object.assign(n, { state: "done", doneAt: now(), doneReason: "seen" });
    emit("hub.need.done", n.id, n.projectId);
    return { id: n.id, seen: true };
  }

  function needAcceptCall(v) {
    const n = state.needs.find((x) => x.id === v.id);
    if (!n || n.state !== "open") throw new Error("That isn't waiting on you any more.");
    if (n.actionType !== "accept") throw new Error("Only finished work waiting for Looks right can be accepted.");
    Object.assign(n, { state: "done", doneAt: now(), doneReason: "accepted or changed" });
    emit("hub.need.done", n.id, n.projectId);
    return { id: n.id, accepted: true };
  }

  // ---- questions (ash-hub-question / ash-hub-answer, contract from the coordinator; branch ash-os-hub-answer) ----
  const QUESTIONS = {
    q2: { options: [{ label: "They match what I meant" }, { label: "Two of them are off", detail: "Say which in your own words." }, { label: "Park the rules for now" }], recommendedIndex: 0, recommendation: "Yes: they read like what you said on 12 Oct." },
    q3: { options: [{ label: "Headline A", detail: "\"Your agents, on your Mac\"" }, { label: "Headline B", detail: "\"Hire the team you can't afford\"" }], recommendedIndex: 1, recommendation: "B tested a little better with founders." },
  };
  const questionOf = (id) => state.needs.find((n) => n.actionTarget === `question:${id}`);
  function questionCall(v) {
    const n = questionOf(v.id);
    if (!n) throw new Error("No such question.");
    const q = QUESTIONS[v.id] ?? { options: [{ label: "Yes" }, { label: "No" }], recommendedIndex: 0, recommendation: "Yes." };
    return { question: n.title, options: q.options, recommendation: q.recommendation, ...(q.recommendedIndex != null ? { recommendedIndex: q.recommendedIndex } : {}), asks: [`a_${v.id}`], askedAt: iso(n.since) };
  }
  function answerCall(v) {
    const n = questionOf(v.id);
    if (!n || n.state !== "open") throw new Error("That question isn't waiting on you any more.");
    const q = QUESTIONS[v.id] ?? { options: [{ label: "Yes" }, { label: "No" }] };
    const text = String(v.text ?? "").trim();
    const picked = typeof v.choice === "number" ? q.options[v.choice]?.label : undefined;
    if (!picked && !text) throw new Error("Pick an option or say something.");
    if (typeof v.choice === "number" && !picked) throw new Error("That option isn't one of the choices.");
    Object.assign(n, { state: "done", doneAt: now(), doneReason: "answered" });
    emit("question.answered", v.id, n.projectId);
    emit("hub.need.done", n.id, n.projectId);
    const project = state.projects.find((p) => p.id === n.projectId)?.name ?? n.projectId;
    return { ok: true, receipt: `Got it: ${picked ?? `"${text}"`}. ${project}'s lead picks it up from here.` };
  }

  async function action(name, v) {
    switch (name) {
      case "jobs": return jobsCall(v);
      case "job-options": return jobOptionsCall(v);
      case "job-act": return jobActCall(v);
      case "job-seen": return jobSeenCall(v);
      case "need-seen": return needSeenCall(v);
      case "need-accept": return needAcceptCall(v);
      case "question": return questionCall(v);
      case "answer": return answerCall(v);
      case "projects": return projectsCall(v);
      case "needs": return needsCall(v);
      case "active": return activeCall(v);
      case "since": return sinceCall(v);
      case "events": return waitEvents(Number(v.after || 0), Number(v.timeout || 0), v.topics);
      case "mono-projects": return monoProjectsCall(v);
      default: throw new Error("Unknown hub action");
    }
  }

  // ---- moves a test (or a person at the dev page) makes --------------------------------------------------------------
  const moves = {
    addNeed(n) {
      const need = { later: false, state: "open", rank: 5, since: now(), actionType: "open", actionTarget: `ask:${n.id}`, why: "", ...n };
      state.needs.push(need);
      emit("hub.need.opened", need.id, need.projectId);
    },
    doneNeed(id, reason = "answered") {
      const n = state.needs.find((x) => x.id === id);
      if (!n || n.state === "done") return;
      Object.assign(n, { state: "done", doneAt: now(), doneReason: reason });
      emit("hub.need.done", id, n.projectId);
    },
    addJob(j) {
      state.jobs.push({ owner: "in-app-lead", reason: "", seen: false, finishedAt: null, startedAt: iso(now()), lastActiveAt: iso(now()), lead: `${j.projectId}-lead`, leadName: "Lead", state: "working", ...j });
      emit("hub.job.changed", j.id, j.projectId);
    },
    setJob(id, patch, kind = "hub.job.changed") {
      const j = findJob(id);
      if (!j) return;
      Object.assign(j, patch);
      emit(kind, id, j.projectId);
    },
    addProject(p) {
      state.projects.push({ iconShape: "folder", workOwner: "ash_os", status: "active", folder: null, shortName: p.name, ...p });
      emit("hub.project.created", p.id, p.id);
    },
    setSince(overall, projects) {
      state.since.overall = overall;
      if (projects) state.since.projects = projects;
      emit("hub.since.ready", "*");
    },
    finishPendingSince() {
      sinceReady = true;
      emit("hub.since.ready", "*");
    },
    /** The service restarted: a new key, a new "code version" event, every open stream ends. */
    restart({ newToken } = {}) {
      if (newToken) {
        currentToken = newToken;
        writeToken();
      }
      emit("hub.code.version", "stub");
      for (const c of [...sseClients]) c.end();
    },
    /** Cut every open stream without saying anything (a dropped connection). */
    closeStreams() {
      for (const c of [...sseClients]) c.destroy();
    },
    /** The service's ledger was restored: the app's cursor is now ahead of it. */
    rewindTo(n) {
      latest = n;
      events.length = 0;
    },
    setActivity(a) {
      Object.assign(state.activity, a);
    },
  };

  // ---- HTTP ----------------------------------------------------------------------------------------------------------
  const send = (res, code, body, extra = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(data), ...extra });
    res.end(data);
  };

  httpServer = http.createServer(async (req, res) => {
    const myPort = httpServer.address().port;
    const url = new URL(req.url, `http://127.0.0.1:${myPort}`);
    const cors = dev ? { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Private-Network": "true" } : {};
    if (dev && req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (dev && url.pathname === "/__stub/token") return send(res, 200, { token: currentToken }, cors);
    if (dev && url.pathname === "/__stub/control" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const { op, ...args } = body;
        if (op === "doneNeed") moves.doneNeed(args.id, args.reason);
        else if (op === "addNeed") moves.addNeed(args.need);
        else if (op === "restart") moves.restart(args);
        else if (op === "addJob") moves.addJob(args.job);
        else if (op === "setJob") moves.setJob(args.id, args.patch, args.kind);
        else if (op === "setSince") moves.setSince(args.overall, args.projects);
        else if (op === "finishPendingSince") moves.finishPendingSince();
        else throw new Error("Unknown op");
        return send(res, 200, { ok: true }, cors);
      } catch (e) {
        return send(res, 400, { ok: false, error: String(e.message || e) }, cors);
      }
    }
    // The real service's checks, in the same order.
    if (![`127.0.0.1:${myPort}`, `localhost:${myPort}`].includes(req.headers.host || "")) return send(res, 403, { ok: false, error: "Host refused" });
    if (url.pathname === "/health") return send(res, 200, { ok: true, service: "hub-stub" });
    const isEvents = url.pathname === "/api/ash-hub-events";
    if (req.method === "GET" && !isEvents) return send(res, 404, { error: "Not found" });
    if (req.headers.authorization !== `Bearer ${currentToken}`) return send(res, 401, { ok: false, error: "Studio authorization required" }, cors);
    const origin = req.headers.origin;
    if (origin && !dev && ![`http://127.0.0.1:${myPort}`, `http://localhost:${myPort}`].includes(origin)) return send(res, 403, { ok: false, error: "Origin refused" });
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { host: req.headers.host, origin: req.headers.origin, authorization: req.headers.authorization } });

    try {
      if (isEvents && req.method === "GET") {
        const after = Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0);
        const topics = (url.searchParams.get("topics") || "").split(",").filter(Boolean);
        if (url.searchParams.get("stream") === "1" || (req.headers.accept || "").includes("text/event-stream")) {
          return sse(req, res, after, topics.length ? topics : null, Number(url.searchParams.get("max_seconds") || 300), cors);
        }
        return send(res, 200, { ok: true, result: await waitEvents(after, Number(url.searchParams.get("timeout") || 0), topics.length ? topics : null) }, cors);
      }
      if (req.method !== "POST" || !url.pathname.startsWith("/api/ash-hub-")) return send(res, 404, { ok: false, error: "Unknown endpoint" }, cors);
      const body = await readBody(req);
      const result = await action(url.pathname.slice("/api/ash-hub-".length), body);
      return send(res, 200, { ok: true, result }, cors);
    } catch (e) {
      return send(res, 400, { ok: false, error: String(e.message || e) }, cors);
    }
  });

  function sse(req, res, after, topics, maxSeconds, cors) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "close", ...cors });
    let cursor = after;
    const first = feed(after, topics);
    res.write(`event: hello\ndata: ${JSON.stringify({ latest: first.latest, reset: !!first.reset })}\n\n`);
    if (first.reset) cursor = first.latest;
    const flush = () => {
      for (const e of eventsAfter(cursor, topics)) {
        res.write(`id: ${e.seq}\nevent: hub\ndata: ${JSON.stringify(e)}\n\n`);
        cursor = e.seq;
      }
    };
    flush();
    waiters.add(flush);
    const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
    const end = setTimeout(() => res.end(), Math.min(maxSeconds, 300) * 1000);
    const cleanup = () => {
      clearInterval(ping);
      clearTimeout(end);
      waiters.delete(flush);
      sseClients.delete(client);
    };
    const client = {
      end: () => {
        cleanup();
        res.end();
      },
      destroy: () => {
        cleanup();
        res.destroy();
      },
    };
    sseClients.add(client);
    res.on("close", cleanup);
    req.on("close", cleanup);
  }

  await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  const actualPort = httpServer.address().port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    get token() {
      return currentToken;
    },
    state,
    calls,
    events,
    get latest() {
      return latest;
    },
    emit,
    ...moves,
    async close() {
      for (const c of [...sseClients]) c.destroy();
      for (const w of [...waiters]) w();
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString() || "{}";
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
        resolve(value);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---- command line -------------------------------------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const stub = await startStub({
    port: Number(arg("port", 18868)),
    tokenFile: arg("token-file"),
    token: arg("token", "stub-token-not-a-real-key"),
    dev: process.argv.includes("--dev"),
    jobs: process.argv.includes("--jobs"),
    pendingSinceOnce: process.argv.includes("--pending-since"),
  });
  console.log(`hub stub on ${stub.url}${arg("token-file") ? ` (key written to ${arg("token-file")})` : ""}`);
  process.on("SIGINT", () => stub.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => stub.close().then(() => process.exit(0)));
}
