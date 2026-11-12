// Ready-made pages: built with the same connected bridge a Mono's page uses (hub.watch and the taps), so Ash can see it
// working and ask a Mono for his own on the same pattern (Rebuild changes it from his words). They go through the same
// preview and Keep and allow as any page. C8 (Ash: "a few default dashboards that always come with every setup, that
// just explain the basics"): on a fresh setup the four are kept once by themselves (readyPagesSeed.ts), each with its
// one-line `what` shown under its title.
import type { Page } from "./pages";
import type { BespokeSpec } from "./pageSpec";
import { hasOwnCode } from "./ownCode";

/** The request a ready-made page is kept with: how Pages knows the page is already there. */
export const AGENTS_READY = "Ready-made: Agents";
export const NEEDS_READY = "Ready-made: Needs you";
export const BUILT_READY = "Ready-made: Being built";
export const PROJECTS_READY = "Ready-made: Projects";
export const READY_BY = "Ready-made";

// The layer all four share on top of the hub kit (hubKit.ts, in every hub): the row parts keep their old hooks
// (.row, .worker, .name, .doing, .status, .acts, .question, .pick) so tests and a Rebuild still find them.
const BASE_CSS = `
.problem{font-size:12px;color:color-mix(in srgb,var(--color-content) 80%,transparent)}
.row .doing{flex:1.2 1 180px}
.row .status,.worker .status{flex:none}
.worker .name{font-weight:400}
.worker .doing{font-size:12px;flex:1.2 1 160px}
@media (max-width:659px){
.row .doing,.worker .doing{order:3;flex-basis:100%;padding-left:44px}
.worker .doing{padding-left:0}
.row > .acts,.worker > .acts{order:4}
}
`;

// Plain DOM, no libraries: a page re-draws on every push and keeps what Ash is typing (and where) across a redraw.
const BASE_JS = `
const $ = (sel) => document.querySelector(sel);
const el = kit.el;
// r67 (Critiquito): a hub still waiting for Allow says what to tap, not "Can't read …: This hub is waiting for you…".
const problemLine = (what, err) => /waiting for you to allow/i.test(String((err && err.message) || "")) ? "Tap Allow to show " + what : "Can't read " + what + ": " + ((err && err.message) || err);
const WORD = { asking: "Asking", stuck: "With its lead", working: "Working", paused: "Paused", idle: "Idle", failed: "Failed", done: "Done", stopped: "Stopped" };
const ICON = { "Open": "open", "Stop": "stop", "Message": "message", "Take it": "check", "Tasks": "down" };
const open = {};      // which answer or message box is open, and what is typed in it
const notes = {};     // what a tap said, by row
let focusNext = null; // a box just opened takes the focus
const ago = kit.ago;

// The red rule (r30c): red "Needs you" only when Ash must act; a stall or failure its lead or a retry has is grey.
function status(state, since, word, red) {
  const s = kit.pill(kit.tone(state, red), (word || WORD[state]) + (since && state !== "idle" ? " · " + ago(since) : ""), { live: state === "working" && !red });
  s.classList.add("status");
  if (red) s.classList.add("red");
  return s;
}
async function tap(key, button, call, args) {
  button.disabled = true;
  notes[key] = "";
  try {
    const out = await hub.call(call, args);
    notes[key] = out && out.done ? out.done + "." : "Done.";
    delete open[key];
  } catch (e) {
    notes[key] = e.message;
  }
  draw();
}
function btn(label, onClick, primary, name) {
  return kit.button(label, onClick, { primary, name, icon: primary ? null : ICON[label] });
}
function acts(buttons) {
  const a = el("div", "acts k-actions");
  for (const b of buttons) if (b) a.appendChild(b);
  return a;
}
function box(key, placeholder, send) {
  const wrap = el("div", "answer k-field");
  const input = el("input", "k-input");
  input.placeholder = placeholder;
  input.value = open[key].text || "";
  input.dataset.box = key;
  input.addEventListener("input", () => { open[key].text = input.value; });
  const go = (b) => { if (input.value.trim()) send(b, input.value.trim()); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(sendBtn); if (e.key === "Escape") { delete open[key]; draw(); } });
  const sendBtn = btn("Send", go, true);
  wrap.appendChild(input); wrap.appendChild(sendBtn); wrap.appendChild(btn("Cancel", () => { delete open[key]; draw(); }));
  return wrap;
}
// A row: its picture, its name and what sits under it, then (when there is one) what it is doing in its own cell, its
// state and its buttons. "Doing" is a cell of the row, never inside the name's cell (WP-01).
function line(o) {
  const r = el("div", o.cls || "row k-row");
  if (o.key) r.dataset.row = o.key;
  if (o.lead) r.appendChild(o.lead);
  const main = el("div", "k-main");
  main.appendChild(el("div", "name k-title", o.name));
  if (o.under) main.appendChild(el("div", "under k-sub", o.under));
  r.appendChild(main);
  if (o.doing) r.appendChild(el("div", "doing k-text", o.doing));
  if (o.status) r.appendChild(o.status);
  r.appendChild(acts(o.buttons || []));
  return r;
}
// What sits under a row: the question it asks (with its suggestion), a box, what a tap said.
function callout(key, text, hint, tone, extra) {
  const c = el("div", "more k-callout");
  if (tone) c.dataset.tone = tone;
  if (text) c.appendChild(el("div", "question k-callout-text", text));
  if (hint) c.appendChild(el("div", "pick k-callout-hint", hint));
  for (const x of extra || []) if (x) c.appendChild(x);
  if (notes[key]) c.appendChild(el("div", "note k-note", notes[key]));
  return c.childNodes.length ? c : null;
}
// Fill a list, show its section only when it has rows, put the count by its title and line the rows' buttons up.
function fill(name, items, build) {
  const list = $('[data-list="' + name + '"]');
  list.textContent = "";
  for (const item of items) list.appendChild(build(item));
  $('[data-section="' + name + '"]').hidden = !items.length;
  const count = $('[data-count="' + name + '"]');
  if (count) count.textContent = items.length;
  for (const sel of [".row > .acts", ".worker > .acts"]) {
    const all = [...list.querySelectorAll(sel)];
    all.forEach((a) => { a.style.minWidth = ""; });
    const w = Math.max(0, ...all.map((a) => a.getBoundingClientRect().width));
    if (w && innerWidth >= 660) all.forEach((a) => { a.style.minWidth = Math.ceil(w) + "px"; });
  }
}
// The numbers on top: each one scrolls to its list.
function stats(tiles) {
  const box = $("[data-stats]");
  box.textContent = "";
  for (const t of tiles) box.appendChild(kit.stat({ ...t, onClick: t.section ? () => { const s = $('[data-section="' + t.section + '"]'); if (s && !s.hidden) s.scrollIntoView({ behavior: "smooth", block: "start" }); } : null }));
  box.hidden = !tiles.length;
}
function summary(text, quiet) {
  const s = $("[data-summary]");
  s.textContent = text;
  s.classList.toggle("k-sr", !!quiet);
  // A head with only a quiet summary in it takes no room.
  s.parentElement.hidden = !!quiet && s.parentElement.children.length === 1;
}
function takeFocus() {
  const key = focusNext || (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.box : null);
  focusNext = null;
  return key;
}
function restoreFocus(key) {
  if (!key) return;
  const box = document.querySelector('[data-box="' + key + '"]');
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}
`;

const head = (summaryText: string, extra = "") =>
  `<div class="k-head"><div class="k-lede" data-summary>${summaryText}</div>${extra}</div>
<div class="problem" data-problem hidden></div>
<div class="k-stats" data-stats hidden></div>`;
const section = (name: string, title: string, list = `<div class="k-card" data-list="${name}"></div>`) =>
  `<section class="k-section" data-section="${name}" hidden><div class="k-section-head">${title}<span class="k-count" data-count="${name}"></span></div>${list}</section>`;

const AGENTS_CSS =
  BASE_CSS +
  `
.k-card[data-list=attention]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-status-bad) 30%,var(--color-surface-ring))}
`;

const AGENTS_HTML = `<div class="k-page">
${head("Reading your agents…")}
${section("attention", "Needs you")}
${section("working", "Working")}
${section("idle", "Idle", `<div class="k-grid" data-list="idle"></div>`)}
<div data-empty hidden></div>
</div>`;

const AGENTS_JS =
  BASE_JS +
  `
let data = null;
const ROLE = { lead: "Lead", team: "Team" };

// One row: its picture, a name and what is under it, what it is doing, its state and time, its buttons; then its
// question, and the work it handed out under it.
function row(item) {
  const wrap = el("div", "item k-item");
  wrap.dataset.item = item.key;
  const q = item.question;
  const o = open[item.key];
  wrap.appendChild(line({
    key: item.key, name: item.name, under: item.under, doing: item.doing,
    lead: kit.avatar(item.name, { tone: kit.tone(item.state, item.needsYou), icon: item.key.startsWith("w:") ? "build" : null }),
    status: status(item.state, item.since, item.word, item.needsYou),
    buttons: [
      q && q.canAnswer && q.pick ? btn("Take it", (b) => tap(item.key, b, "agents.pick", { chatId: q.chatId }), false, item.name) : null,
      q && q.canAnswer ? btn("Answer", () => { open[item.key] = { kind: "answer", text: "" }; focusNext = item.key; draw(); }, true, item.name) : null,
      item.canMessage ? btn("Message", () => { open[item.key] = { kind: "message", text: "" }; focusNext = item.key; draw(); }, false, item.name) : null,
      btn("Open", (b) => tap(item.key, b, "chats.open", item.openArgs), false, item.name),
      item.stopArgs ? btn("Stop", (b) => tap(item.key, b, "agents.stop", item.stopArgs), false, item.name) : null,
    ],
  }));
  const boxNode = o && o.kind === "answer" && q ? box(item.key, "Your answer…", (b, text) => tap(item.key, b, "agents.answer", { chatId: q.chatId, text }))
    : o && o.kind === "message" ? box(item.key, "Message " + item.name + "…", (b, text) => tap(item.key, b, "agents.message", { agentId: item.agentId, text })) : null;
  const c = callout(item.key, q ? q.text : item.reason, q && q.pick ? "Suggested: " + q.pick : "", q ? "warn" : null, [boxNode]);
  if (c) wrap.appendChild(c);
  if (item.workers && item.workers.length) {
    const nest = el("div", "k-nest");
    for (const w of item.workers) nest.appendChild(workerLine(w));
    wrap.appendChild(nest);
  }
  return wrap;
}
function workerLine(w) {
  const doing = w.state === "working" ? w.doing : w.reason || "";
  const r = line({
    cls: "worker k-row", name: w.title, doing,
    lead: kit.avatar(w.title, { small: true, icon: "build", tone: kit.tone(w.state, w.needsYou) }),
    status: status(w.state, w.state === "done" || w.state === "failed" || w.state === "stopped" ? 0 : w.since, w.word, w.needsYou),
    buttons: [
      btn("Open", (b) => tap("w:" + w.id, b, "chats.open", { workerId: w.id })),
      w.state === "working" ? btn("Stop", (b) => tap("w:" + w.id, b, "agents.stop", { workerId: w.id })) : null,
    ],
  });
  r.dataset.worker = w.id;
  return r;
}
// An idle agent: a small card with its name, its role and the last thing it handed out.
function idleTile(item) {
  const last = item.workers && item.workers.length ? item.workers[item.workers.length - 1] : null;
  const t = kit.tile({
    lead: kit.avatar(item.name, { tone: "idle" }), title: item.name,
    sub: [ROLE[item.role] || "", last ? "Last: " + last.title : "Free for work"].filter(Boolean).join(" · "),
    actions: [
      item.canMessage ? btn("Message", () => { open[item.key] = { kind: "message", text: "" }; focusNext = item.key; draw(); }, false, item.name) : null,
      btn("Open", (b) => tap(item.key, b, "chats.open", item.openArgs), false, item.name),
    ].filter(Boolean),
  });
  t.classList.add("item");
  t.dataset.item = item.key;
  const o = open[item.key];
  if (o && o.kind === "message") t.appendChild(box(item.key, "Message " + item.name + "…", (b, text) => tap(item.key, b, "agents.message", { agentId: item.agentId, text })));
  if (notes[item.key]) t.appendChild(el("div", "note k-note", notes[item.key]));
  return t;
}

// Everything that needs Ash, from the agents and from the work they handed out (at any depth).
function attention(agents) {
  const out = [];
  const walk = (agent, workers, path) => {
    for (const w of workers) {
      if (w.state === "asking" || w.needsYou)
        out.push({ key: "w:" + w.id, name: w.title, under: "From " + path, doing: "", state: w.state, since: w.since, reason: w.reason, word: w.word, needsYou: w.needsYou,
          question: w.question, openArgs: { workerId: w.id }, stopArgs: { workerId: w.id } });
      walk(agent, w.workers || [], path);
    }
  };
  for (const a of agents) {
    if (a.state === "asking" || a.needsYou)
      out.push({ key: "a:" + a.id, name: a.name, doing: a.state === "stuck" ? a.doing : "", state: a.state, since: a.since, reason: a.reason, question: a.question, word: a.word, needsYou: a.needsYou,
        agentId: a.id, openArgs: { agentId: a.id }, stopArgs: a.state === "stuck" && a.chatId ? { agentId: a.id } : null });
    walk(a, a.workers || [], a.name);
  }
  return out.sort((x, y) => (x.state === "asking" ? 0 : 1) - (y.state === "asking" ? 0 : 1) || (x.since || 0) - (y.since || 0));
}
const recent = (workers) => workers.filter((w) => !w.needsYou && w.state !== "asking").slice(-5);
const handedOut = (agents) => { let n = 0; const walk = (ws) => { for (const w of ws) { if (w.state === "working") n++; walk(w.workers || []); } }; for (const a of agents) walk(a.workers || []); return n; };

function draw() {
  if (!data) return;
  const focused = takeFocus();
  const agents = data.agents || [];
  const need = attention(agents);
  const busy = agents.filter((a) => (a.state === "working" || a.state === "paused" || a.state === "stuck") && !need.some((n) => n.key === "a:" + a.id));
  const idle = agents.filter((a) => a.state === "idle");
  fill("attention", need, row);
  fill("working", busy.map((a) => ({ key: "a:" + a.id, name: a.name, under: ROLE[a.role], doing: a.doing, state: a.state, since: a.since, reason: a.reason, word: a.word, agentId: a.id, canMessage: !!a.chatId,
    openArgs: { agentId: a.id }, stopArgs: a.chatId ? { agentId: a.id } : null, workers: recent(a.workers || []) })), row);
  fill("idle", idle.map((a) => ({ key: "a:" + a.id, name: a.name, role: a.role, state: "idle", agentId: a.id, canMessage: !!a.chatId,
    openArgs: { agentId: a.id }, workers: recent(a.workers || []) })), idleTile);
  const parts = [];
  if (need.length) parts.push(need.length + (need.length === 1 ? " needs you" : " need you"));
  const working = agents.filter((a) => a.state === "working").length;
  if (working) parts.push(working + " working");
  if (idle.length) parts.push(idle.length + " idle");
  const none = "No agents yet. Your first mates show here once they're on the team.";
  summary(agents.length ? parts.join(" · ") : none, true);
  stats(agents.length ? [
    { label: "Needs you", value: need.length, tone: need.length ? "bad" : null, section: "attention" },
    { label: "Working", value: working, tone: working ? "ok" : null, section: "working" },
    { label: "Work handed out", value: handedOut(agents), section: "working" },
    { label: "Idle", value: idle.length, section: "idle" },
  ] : []);
  const empty = $("[data-empty]");
  empty.textContent = "";
  if (!agents.length) empty.appendChild(kit.empty(none, "users"));
  empty.hidden = agents.length > 0;
  restoreFocus(focused);
}

hub.watch("agents.read", (d) => { data = d; $("[data-problem]").hidden = true; $("[data-summary]").hidden = false; draw(); },
  (err) => { const p = $("[data-problem]"); p.hidden = false; $("[data-summary]").hidden = true; p.textContent = problemLine("your agents", err); });
setInterval(draw, 30000);
`;

/** Every agent and what it is doing, the stuck and asking ones on top with Answer, Take it, Open and Stop. */
export const AGENTS_PAGE: BespokeSpec = {
  kind: "bespoke",
  title: "Agents",
  html: AGENTS_HTML,
  css: AGENTS_CSS,
  js: AGENTS_JS,
  permissions: ["agents.read", "agents.answer", "agents.pick", "agents.message", "agents.stop", "chats.open"],
};

// A hub's empty state: one sentence under a quiet picture (DESIGN.md 4.12), drawn when there is nothing at all.
const EMPTY_JS = `
function showEmpty(text, iconName, on) {
  const empty = $("[data-empty]");
  empty.textContent = "";
  if (on) empty.appendChild(kit.empty(text, iconName));
  empty.hidden = !on;
}
`;

const NEEDS_HTML = `<div class="k-page">
${head("Reading what's waiting on you…")}
${section("waiting", "Asking you")}
${section("needs", "Waiting on you")}
<div data-empty hidden></div>
</div>`;

const NEEDS_JS =
  BASE_JS +
  EMPTY_JS +
  `
let data = null;

// A chat that stopped to ask Ash something: answer it, take its suggestion, or open it.
function chatRow(c) {
  const key = "c:" + c.chatId;
  const wrap = el("div", "item k-item");
  wrap.dataset.item = key;
  wrap.appendChild(line({
    key, name: c.chatName, under: c.projectName || "A chat",
    lead: kit.avatar(c.chatName, { tone: c.redLine ? "bad" : "warn" }),
    status: status("asking", c.askedAt, c.redLine ? "Red line" : "Asked", !!c.redLine),
    buttons: [
      c.pick ? btn("Take it", (b) => tap(key, b, "agents.pick", { chatId: c.chatId })) : null,
      btn("Answer", () => { open[key] = { kind: "answer", text: "" }; focusNext = key; draw(); }, true),
      btn("Open", (b) => tap(key, b, "chats.open", { chatId: c.chatId })),
    ],
  }));
  const o = open[key];
  const boxNode = o && o.kind === "answer" ? box(key, "Your answer…", (b, text) => tap(key, b, "agents.answer", { chatId: c.chatId, text })) : null;
  const more = callout(key, c.question, c.pick ? "Suggested: " + c.pick : "", c.redLine ? "bad" : "warn", [boxNode]);
  if (more) wrap.appendChild(more);
  return wrap;
}

// Something a project wants Ash to look at; a question can be answered here too.
function needRow(n) {
  const key = "n:" + n.id;
  const wrap = el("div", "item k-item");
  wrap.dataset.item = key;
  wrap.appendChild(line({
    key, name: n.title, under: n.projectName || "Every project", doing: n.why,
    lead: kit.avatar(n.title, { icon: n.isQuestion ? "message" : "inbox", tone: "warn" }),
    status: status("asking", n.since, "Waiting", false),
    buttons: n.isQuestion ? [
      btn("Take it", (b) => tap(key, b, "agents.pick", { needId: n.id })),
      btn("Answer", () => { open[key] = { kind: "answer", text: "" }; focusNext = key; draw(); }, true),
    ] : [],
  }));
  const o = open[key];
  const boxNode = o && o.kind === "answer" ? box(key, "Your answer…", (b, text) => tap(key, b, "agents.answer", { needId: n.id, text })) : null;
  const more = callout(key, "", n.action ? "Next: " + n.action : "", null, [boxNode]);
  if (more) wrap.appendChild(more);
  return wrap;
}

function draw() {
  if (!data) return;
  const focused = takeFocus();
  const waiting = (data.waiting || []).slice().sort((a, b) => (a.askedAt || 0) - (b.askedAt || 0));
  const needs = (data.needs || []).slice().sort((a, b) => (a.since || 0) - (b.since || 0));
  fill("waiting", waiting, chatRow);
  fill("needs", needs, needRow);
  const parts = [];
  if (waiting.length) parts.push(waiting.length === 1 ? "1 chat is asking you" : waiting.length + " chats are asking you");
  if (needs.length) parts.push(needs.length === 1 ? "1 thing to do next" : needs.length + " things to do next");
  summary(parts.length ? parts.join(" · ") : "Nothing is waiting on you.", true);
  const red = waiting.filter((c) => c.redLine).length;
  stats(parts.length ? [
    { label: "Asking you", value: waiting.length, tone: red ? "bad" : waiting.length ? "warn" : null, section: "waiting" },
    { label: "To do next", value: needs.length, tone: needs.length ? "warn" : null, section: "needs" },
  ] : []);
  showEmpty("Nothing is waiting on you.", "check", !parts.length);
  restoreFocus(focused);
}

hub.watch("needs.read", (d) => { data = d; $("[data-problem]").hidden = true; $("[data-summary]").hidden = false; draw(); },
  (err) => { const p = $("[data-problem]"); p.hidden = false; $("[data-summary]").hidden = true; p.textContent = problemLine("what's waiting", err); });
`;

/** Everything waiting on Ash in one place: the chats asking him, then what his projects want him to look at. */
export const NEEDS_PAGE: BespokeSpec = {
  kind: "bespoke",
  title: "Needs you",
  html: NEEDS_HTML,
  css: BASE_CSS,
  js: NEEDS_JS,
  permissions: ["needs.read", "agents.answer", "agents.pick", "chats.open"],
};

const BUILT_HTML = `<div class="k-page">
${head("Reading what's being built…")}
${section("jobs", "Being built")}
<div data-empty hidden></div>
</div>`;

const BUILT_JS =
  BASE_JS +
  EMPTY_JS +
  `
let data = null;
const ACTIVE = ["working", "checking", "waiting", "stuck", "gave_up"];
// A job nobody is on is the one Ash must look at; a job its lead is on stays grey, as the red rule says.
const RANK = { gave_up: 0, stuck: 1, working: 2, checking: 3, waiting: 4 };
const JOB_WORD = { working: "Working", checking: "Checking", waiting: "Waiting", stuck: "With its lead", gave_up: "Needs you" };

function jobRow(j) {
  const key = "j:" + j.id;
  const wrap = el("div", "item k-item");
  wrap.dataset.item = key;
  wrap.appendChild(line({
    key, name: j.title, under: [j.projectName, j.agentName].filter(Boolean).join(" · ") || "A job",
    lead: kit.avatar(j.title, { icon: "build", tone: kit.tone(j.state, j.state === "gave_up") }),
    status: status(j.state, j.lastActiveAt || j.startedAt, JOB_WORD[j.state] || "Working", j.state === "gave_up"),
    buttons: [j.agentId ? btn("Open", (b) => tap(key, b, "chats.open", { agentId: j.agentId })) : null],
  }));
  const more = callout(key, j.reason, "", j.state === "gave_up" ? "bad" : null);
  if (more) wrap.appendChild(more);
  return wrap;
}

function draw() {
  if (!data) return;
  const focused = takeFocus();
  const jobs = (data.jobs || []).filter((j) => ACTIVE.includes(j.state));
  jobs.sort((a, b) => (RANK[a.state] - RANK[b.state]) || ((b.lastActiveAt || b.startedAt || 0) - (a.lastActiveAt || a.startedAt || 0)));
  fill("jobs", jobs, jobRow);
  const parts = [];
  if (jobs.length) parts.push(jobs.length === 1 ? "1 job being built" : jobs.length + " jobs being built");
  const stuck = jobs.filter((j) => j.state === "gave_up").length;
  if (stuck) parts.push(stuck === 1 ? "1 needs you" : stuck + " need you");
  summary(parts.length ? parts.join(" · ") : "Nothing is being built right now.", true);
  const working = jobs.filter((j) => j.state === "working").length;
  const checking = jobs.filter((j) => j.state === "checking").length;
  stats(jobs.length ? [
    { label: "Needs you", value: stuck, tone: stuck ? "bad" : null, section: "jobs" },
    { label: "Working", value: working, tone: working ? "ok" : null, section: "jobs" },
    { label: "Checking", value: checking, section: "jobs" },
    { label: "Waiting or with its lead", value: jobs.length - stuck - working - checking, section: "jobs" },
  ] : []);
  showEmpty("Nothing is being built right now.", "build", !jobs.length);
  restoreFocus(focused);
}

hub.watch("jobs.read", (d) => { data = d; $("[data-problem]").hidden = true; $("[data-summary]").hidden = false; draw(); },
  (err) => { const p = $("[data-problem]"); p.hidden = false; $("[data-summary]").hidden = true; p.textContent = problemLine("what's being built", err); });
`;

/** What is being built right now, newest first, with a job whose lead gave up on top. */
export const BUILT_PAGE: BespokeSpec = {
  kind: "bespoke",
  title: "Being built",
  html: BUILT_HTML,
  css: BASE_CSS,
  js: BUILT_JS,
  permissions: ["jobs.read", "chats.open"],
};

const PROJECTS_HTML = `<div class="k-page">
${head("Reading your projects…")}
<section class="k-section" data-section="projects" hidden><div class="k-section-head">All projects<span class="k-count" data-count="projects"></span><span class="k-spacer"></span><button class="k-btn" data-refresh type="button">Refresh</button></div><div class="k-card" data-list="projects"></div></section>
<div data-empty hidden></div>
</div>`;

const PROJECTS_JS =
  BASE_JS +
  EMPTY_JS +
  `
let data = null;
const tasks = {}; // a project's tasks once read; null while reading

const TASK_WORD = { stuck: "Held up", waiting: "Waiting on you", building: "Being built", later: "Later" };
const TASK_STATE = { stuck: "paused", waiting: "asking", building: "working", later: "idle" };

function taskLine(t) {
  const r = line({
    cls: "worker k-row", name: t.title, doing: t.why,
    lead: kit.avatar(t.title, { small: true, icon: "doc", tone: kit.tone(TASK_STATE[t.state] || "idle") }),
    status: status(TASK_STATE[t.state] || "idle", t.since, TASK_WORD[t.state] || "Later", false),
  });
  r.dataset.task = t.id;
  return r;
}

// One project: its name, its first mates, what is waiting in it, and its tasks once opened (the whole row opens them).
function projectRow(p) {
  const key = "p:" + p.id;
  const shown = tasks[p.id] !== undefined;
  const wrap = el("div", "item k-item");
  wrap.dataset.item = key;
  if (shown) wrap.dataset.open = "";
  const c = p.counts || {};
  const mates = p.monos && p.monos.length ? p.monos.join(", ") : "No first mates yet";
  const word = c.waiting ? c.waiting + " waiting on you" : c.stuck ? c.stuck + " held up" : c.building ? c.building + " being built" : "All clear";
  const r = line({
    key, name: p.name, under: p.parked ? "Parked · " + mates : mates,
    lead: kit.avatar(p.name, { icon: "folder" }),
    status: status(c.waiting ? "asking" : c.stuck ? "paused" : c.building ? "working" : "idle", 0, word, false),
    buttons: [btn(shown ? "Hide tasks" : "Tasks", () => toggle(p.id), false, p.name)],
  });
  r.classList.add("toggle", "k-click");
  r.addEventListener("click", () => toggle(p.id));
  const tags = el("div", "k-tags");
  if (c.stuck) tags.appendChild(kit.tag(c.stuck + " held up"));
  if (c.building) tags.appendChild(kit.tag(c.building + " building"));
  if (c.later) tags.appendChild(kit.tag(c.later + " later"));
  if (tags.childNodes.length) r.insertBefore(tags, r.querySelector(".status"));
  wrap.appendChild(r);
  const list = tasks[p.id];
  const nest = el("div", "k-nest");
  if (shown && list === null) nest.appendChild(el("div", "note k-note", "Reading this project…"));
  if (shown && list && !list.length) nest.appendChild(el("div", "note k-note", "Nothing in this project needs you."));
  if (shown && list) for (const t of list) nest.appendChild(taskLine(t));
  if (notes[p.id]) nest.appendChild(el("div", "note k-note", notes[p.id]));
  if (nest.childNodes.length) wrap.appendChild(nest);
  return wrap;
}

function toggle(id) {
  if (tasks[id] !== undefined) { delete tasks[id]; draw(); return; }
  tasks[id] = null;
  draw();
  hub.call("tasks.read", { projectId: id })
    .then((out) => { tasks[id] = out.tasks || []; delete notes[id]; draw(); })
    .catch((e) => { tasks[id] = []; notes[id] = e.message; draw(); });
}

function load(button) {
  if (button) button.disabled = true;
  hub.call("project.read", {})
    .then((out) => { data = out.projects || []; $("[data-problem]").hidden = true; $("[data-summary]").hidden = false; draw(); })
    .catch((e) => {
      const p = $("[data-problem]"); p.hidden = false; $("[data-summary]").hidden = true; p.textContent = problemLine("your projects", e);
    })
    .finally(() => { if (button) button.disabled = false; });
}

function draw() {
  if (!data) return;
  fill("projects", data, projectRow);
  const sum = (k) => data.reduce((n, p) => n + ((p.counts && p.counts[k]) || 0), 0);
  const waiting = sum("waiting"), stuck = sum("stuck"), building = sum("building");
  const parts = [];
  if (data.length) parts.push(data.length === 1 ? "1 project" : data.length + " projects");
  if (waiting + stuck) parts.push(waiting + stuck + " waiting");
  if (building) parts.push(building + " being built");
  summary(parts.length ? parts.join(" · ") : "No projects yet.", data.length > 0);
  stats(data.length ? [
    { label: "Projects", value: data.length, section: "projects" },
    { label: "Waiting on you", value: waiting, tone: waiting ? "warn" : null, section: "projects" },
    { label: "Held up", value: stuck, section: "projects" },
    { label: "Being built", value: building, tone: building ? "ok" : null, section: "projects" },
  ] : []);
  showEmpty("No projects yet.", "folder", !data.length);
}

$("[data-refresh]").addEventListener("click", () => load($("[data-refresh]")));
load(null);
`;

/** His projects, what each one holds and what in it is waiting on him, opened in place. */
export const PROJECTS_PAGE: BespokeSpec = {
  kind: "bespoke",
  title: "Projects",
  html: PROJECTS_HTML,
  css: BASE_CSS,
  js: PROJECTS_JS,
  permissions: ["project.read", "tasks.read"],
};

export type ReadyPage = { id: string; title: string; what: string; request: string; spec: BespokeSpec };
export const READY_PAGES: readonly ReadyPage[] = [
  { id: "agents", title: "Agents", what: "Every agent and what it's doing, with the ones that need you on top: answer, open or stop them from one place.", request: AGENTS_READY, spec: AGENTS_PAGE },
  { id: "needs-you", title: "Needs you", what: "Everything waiting on you in one place: the chats asking you something, then what your projects want you to look at. Answer or take it from here.", request: NEEDS_READY, spec: NEEDS_PAGE },
  { id: "being-built", title: "Being built", what: "What is being built right now across every project, with anything that needs you on top, and a way into the agent doing it.", request: BUILT_READY, spec: BUILT_PAGE },
  { id: "projects", title: "Projects", what: "Every project, who works on it and what in it is waiting on you.", request: PROJECTS_READY, spec: PROJECTS_PAGE },
];

/** The one line a ready-made page explains itself with (C8), by the request it was kept with; undefined for any other. */
export function readyWhat(request: string): string | undefined {
  return READY_PAGES.find((r) => r.request === request)?.what;
}

/**
 * r63: a kept ready-made page draws today's ready-made code (html, css, js), so a fix to one (the Agents page's Message
 * buttons named for their agent) reaches pages kept by an older build. Only when it asks for exactly what the kept page
 * asks for: what Ash allowed never changes under him; any other page is returned as it is. A ready-made page Ash used
 * a new version of (Rebuild, then Use this version) keeps that version (ownCode.ts).
 */
export function withReadySpec(page: Page): Page {
  if (page.by !== READY_BY || page.spec.kind !== "bespoke" || hasOwnCode(page.id)) return page;
  const ready = READY_PAGES.find((r) => r.request === page.request);
  if (!ready) return page;
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  if (!same(ready.spec.permissions, page.spec.permissions)) return page;
  const { html, css, js } = ready.spec;
  if (page.spec.html === html && page.spec.css === css && page.spec.js === js) return page;
  return { ...page, spec: { ...page.spec, html, css, js } };
}
