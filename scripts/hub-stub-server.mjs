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
  [/^hub\.code\./, ["service"]],
];
const topicsOf = (kind) => (TOPICS.find(([re]) => re.test(kind)) || [null, []])[1];
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));

const ACTION_LABELS = { start: "Start", open: "Open", sign_in: "Sign in", see_options: "See options" };

/** The invented starting state: four projects, a few Needs, a "since" paragraph. */
export function seedState(now = Date.now()) {
  const h = 3600_000;
  return {
    projects: [
      { id: "exo-game", name: "EXO game", shortName: "EXO", iconShape: "ghost", folder: "/Users/example/Projects/exo-game", workOwner: "ash_os", status: "active" },
      { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/example/Projects/hivra", workOwner: "ash_os", status: "active" },
      { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "palette", folder: "/Users/example/Projects/nibbii", workOwner: "ash_os", status: "active" },
      { id: "org", name: "Org", shortName: "Org", iconShape: "gauge", folder: null, workOwner: "ash_os", status: "active" },
    ],
    needs: [
      { id: "q1", projectId: "exo-game", title: "Example: play Areas 1 and 2", why: "The new level changed how these play. It needs your hands on it.", actionType: "start", actionTarget: "gate:project:playtests", rank: 1, since: now - 5 * h },
      { id: "q2", projectId: "exo-game", title: "Example: skim the new game rules", why: "Four rules written down. Check they match what you meant.", actionType: "see_options", actionTarget: "question:q2", rank: 2, since: now - 4 * h },
      { id: "q3", projectId: "hivra", title: "Example: pick the waitlist headline", why: "Two versions tested about the same. Your taste call.", actionType: "see_options", actionTarget: "question:q3", rank: 2, since: now - 3 * h },
      { id: "q4", projectId: "org", title: "Example: approve the Q4 hiring plan", why: "Two roles changed since last week.", actionType: "open", actionTarget: "ask:a4", rank: 3, since: now - 2 * h },
      { id: "q5", projectId: "org", title: "Example: sign the vendor renewal", why: "Due Friday; price is unchanged.", actionType: "open", actionTarget: "ask:a5", rank: 3, since: now - 2 * h },
      { id: "q6", projectId: "org", title: "Example: review the on-call rota", why: "Next month has a gap on the 12th.", actionType: "open", actionTarget: "ask:a6", rank: 3, since: now - 2 * h },
      { id: "q7", projectId: "org", title: "Example: pick the offsite dates", why: "Three options; everyone else has voted.", actionType: "see_options", actionTarget: "question:q7", rank: 3, since: now - 2 * h },
      { id: "q8", projectId: "org", title: "Example: check the budget summary", why: "Spend is 4% under plan.", actionType: "open", actionTarget: "ask:a8", rank: 3, since: now - 2 * h },
      { id: "q9", projectId: "org", title: "Example: renew the domain names", why: "Recovered from an old chat. Nothing is due.", actionType: "see_options", actionTarget: "question:q9", rank: 9, later: true, since: now - 30 * h },
    ].map((n) => ({ later: false, state: "open", ...n })),
    activity: { lastActive: now - 20 * 60_000, since: now - 6 * h, sessionStart: now - 25 * 60_000 },
    since: {
      overall: "Example: the game's new level is in and working. Hivra has a headline to pick. Org has five decisions waiting for you.",
      projects: {
        "exo-game": "Example: the new level is in and working. Two things need your hands.",
        hivra: "Example: the waitlist headline is waiting for your pick.",
        org: "Example: five decisions are waiting for you.",
      },
      details: ["EXO game - Example: level 3 build finished (card c-101)", "Hivra - Example: headline test finished (ask a-77)"],
    },
    memberships: [
      { monoId: "chief-of-staff", projectId: "exo-game", role: "member", addedAt: iso(now - 90 * h) },
      { monoId: "chief-of-staff", projectId: "hivra", role: "member", addedAt: iso(now - 90 * h) },
    ],
  };
}

/** Start a stub. Returns {port, url, token, state, calls, ...moves, close()}. */
export async function startStub({
  port = 0,
  token = "stub-token-not-a-real-key",
  tokenFile,
  dev = false,
  pingMs = 15_000,
  pendingSinceOnce = false,
  seq = 100,
  now = () => Date.now(),
} = {}) {
  const state = seedState(now());
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
  const openNeeds = () => state.needs.filter((n) => n.state === "open");
  const row = (n) => {
    const r = { id: n.id, projectId: n.projectId, title: n.title, why: n.why, actionType: n.actionType, actionLabel: ACTION_LABELS[n.actionType], actionTarget: n.actionTarget, state: n.state, since: iso(n.since) };
    if (n.detail) r.detail = n.detail;
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
    for (const n of state.needs) {
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
    return { projects: out, setup: [], total: out.reduce((s, e) => s + (e.count || 0), 0), seq: latest, at: iso(t) };
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

  async function action(name, v) {
    switch (name) {
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
  });
  console.log(`hub stub on ${stub.url}${arg("token-file") ? ` (key written to ${arg("token-file")})` : ""}`);
  process.on("SIGINT", () => stub.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => stub.close().then(() => process.exit(0)));
}
