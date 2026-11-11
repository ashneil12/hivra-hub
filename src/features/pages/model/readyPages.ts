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

// The layout all of them share: one column of sections, each a titled card of rows.
const BASE_CSS = `
.wrap{display:flex;flex-direction:column;gap:20px;padding:2px 2px 8px}
.bar{display:flex;align-items:center;gap:8px}
.bar .summary{flex:1;min-width:0}
.summary{font-size:13px;color:color-mix(in srgb,var(--color-content) 75%,transparent)}
.problem{font-size:12px;color:color-mix(in srgb,var(--color-content) 80%,transparent)}
.section-title{font-size:12px;font-weight:500;color:color-mix(in srgb,var(--color-content) 62%,transparent);padding:0 8px 6px}
.card{background:var(--color-surface);border-radius:12px;box-shadow:inset 0 0 0 1px var(--color-surface-ring);padding:4px}
.item{border-radius:8px}
.item:hover{background:color-mix(in srgb,var(--color-content) 4%,transparent)}
.item + .item{border-top:1px solid var(--color-stroke);border-top-left-radius:0;border-top-right-radius:0}
.row,.worker{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1.4fr) 124px auto;align-items:center;gap:12px;padding:8px}
.wide{grid-column:span 2}
.name{font-size:13px;color:var(--color-content);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.under{font-size:12px;color:color-mix(in srgb,var(--color-content) 62%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doing{font-size:13px;color:color-mix(in srgb,var(--color-content) 85%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{display:flex;align-items:center;gap:6px;font-size:12px;color:color-mix(in srgb,var(--color-content) 70%,transparent);white-space:nowrap}
.status-dot{width:6px;height:6px;border-radius:9px;flex:none;background:color-mix(in srgb,var(--color-content) 35%,transparent)}
.status-dot[data-state=working]{background:var(--color-status-ok)}
.status-dot[data-state=asking],.status-dot[data-state=paused]{background:var(--color-status-warn)}
.status-dot[data-tone=red]{background:var(--color-status-bad)}
.status.red{color:var(--color-status-bad)}
.acts{display:flex;gap:4px;justify-content:flex-end}
button{font:inherit;font-size:12px;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;white-space:nowrap;background:transparent;color:color-mix(in srgb,var(--color-content) 75%,transparent)}
button:hover{background:var(--color-surface-raised);color:var(--color-content)}
button.primary{background:color-mix(in srgb,var(--color-content) 12%,transparent);color:var(--color-content)}
button.primary:hover{background:color-mix(in srgb,var(--color-content) 18%,transparent)}
button:disabled{opacity:.45;cursor:default}
.more{padding:6px 8px 10px 8px;display:flex;flex-direction:column;gap:6px}
.question{font-size:13px;color:var(--color-content);line-height:1.45}
.pick{font-size:12px;color:color-mix(in srgb,var(--color-content) 70%,transparent)}
.answer{display:flex;gap:6px;align-items:center}
.answer input{flex:1;min-width:0;font:inherit;font-size:13px;color:var(--color-content);background:var(--color-surface-raised);border:0;border-radius:6px;padding:6px 8px;outline:none}
.note{font-size:12px;color:color-mix(in srgb,var(--color-content) 75%,transparent)}
.worker{padding-top:4px;padding-bottom:4px}
.worker .name{padding-left:16px;font-size:12px;color:color-mix(in srgb,var(--color-content) 85%,transparent)}
.worker .doing{font-size:12px;color:color-mix(in srgb,var(--color-content) 70%,transparent)}
.more .worker{margin:0 -8px}
.empty{font-size:13px;color:color-mix(in srgb,var(--color-content) 70%,transparent);padding:8px}
@media (max-width:659px){
.row,.worker{grid-template-columns:minmax(0,1fr) auto;row-gap:6px}
.wide{grid-column:auto}
.doing{grid-column:1 / -1;grid-row:2}
.status{grid-column:2;grid-row:1}
.acts{grid-column:1 / -1;justify-content:flex-start;flex-wrap:wrap;margin-left:-8px}
}
`;

// Plain DOM, no libraries: a page re-draws on every push and keeps what Ash is typing (and where) across a redraw.
const BASE_JS = `
const $ = (sel) => document.querySelector(sel);
// r67 (Critiquito): a hub still waiting for Allow says what to tap, not "Can't read …: This hub is waiting for you…".
const problemLine = (what, err) => /waiting for you to allow/i.test(String((err && err.message) || "")) ? "Tap Allow to show " + what : "Can't read " + what + ": " + ((err && err.message) || err);
const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = String(text); return x; };
const WORD = { asking: "Asking", stuck: "With its lead", working: "Working", paused: "Paused", idle: "Idle", failed: "Failed", done: "Done", stopped: "Stopped" };
const open = {};      // which answer or message box is open, and what is typed in it
const notes = {};     // what a tap said, by row
let focusNext = null; // a box just opened takes the focus

function ago(ms) {
  if (!ms) return "";
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : Math.floor(m / 1440) + "d";
}
// The red rule (r30c): red "Needs you" only when Ash must act; a stall or failure its lead or a retry has is grey.
function status(state, since, word, red) {
  const s = el("span", red ? "status red" : "status");
  const dot = el("span", "status-dot"); dot.dataset.state = state; if (red) dot.dataset.tone = "red"; s.appendChild(dot);
  s.appendChild(el("span", "", (word || WORD[state]) + (since && state !== "idle" ? " · " + ago(since) : "")));
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
  const b = el("button", primary ? "primary" : "", label);
  if (name) b.setAttribute("aria-label", label + " " + name);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
  return b;
}
function box(key, placeholder, send) {
  const wrap = el("div", "answer");
  const input = el("input");
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
// A row's first cells: a name and what sits under it, then (when there is one) what it is doing in its own column.
// With nothing doing, the name spans both columns. "Doing" is a cell of the row, never inside the name's cell: inside
// it, the state slid into the doing column and the buttons into the state's 124px, over the state (WP-01).
function who(name, under, doing) {
  const cell = el("div", doing ? "" : "wide");
  cell.appendChild(el("div", "name", name));
  if (under) cell.appendChild(el("div", "under", under));
  if (!doing) return cell;
  const cells = document.createDocumentFragment();
  cells.appendChild(cell);
  cells.appendChild(el("div", "doing", doing));
  return cells;
}
function fill(name, items, build) {
  const list = $('[data-list="' + name + '"]');
  list.textContent = "";
  for (const item of items) list.appendChild(build(item));
  $('[data-section="' + name + '"]').hidden = !items.length;
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

const AGENTS_CSS =
  BASE_CSS +
  `
@media (min-width:660px){
.row{grid-template-columns:minmax(0,1.3fr) minmax(0,1.4fr) 124px 260px}
}
@media (max-width:659px){
.worker .doing{padding-left:16px}
.worker .acts{margin-left:4px}
}
`;

const AGENTS_HTML = `<div class="wrap">
<div class="summary" data-summary>Reading your agents…</div>
<div class="problem" data-problem hidden></div>
<section data-section="attention" hidden><div class="section-title">Needs you</div><div class="card" data-list="attention"></div></section>
<section data-section="working" hidden><div class="section-title">Working</div><div class="card" data-list="working"></div></section>
<section data-section="idle" hidden><div class="section-title">Idle</div><div class="card" data-list="idle"></div></section>
</div>`;

const AGENTS_JS =
  BASE_JS +
  `
let data = null;

// One row: a name and what is under it, what it is doing, its state and time, its buttons; then its question.
function row(item) {
  const wrap = el("div", "item");
  wrap.dataset.item = item.key;
  const r = el("div", "row");
  r.dataset.row = item.key;
  r.appendChild(who(item.name, item.under, item.doing));
  r.appendChild(status(item.state, item.since, item.word, item.needsYou));
  const acts = el("div", "acts");
  const q = item.question;
  if (q && q.canAnswer && q.pick) acts.appendChild(btn("Take it", (b) => tap(item.key, b, "agents.pick", { chatId: q.chatId }), false, item.name));
  if (q && q.canAnswer) acts.appendChild(btn("Answer", () => { open[item.key] = { kind: "answer", text: "" }; focusNext = item.key; draw(); }, true, item.name));
  if (item.canMessage) acts.appendChild(btn("Message", () => { open[item.key] = { kind: "message", text: "" }; focusNext = item.key; draw(); }, false, item.name));
  acts.appendChild(btn("Open", (b) => tap(item.key, b, "chats.open", item.openArgs), false, item.name));
  if (item.stopArgs) acts.appendChild(btn("Stop", (b) => tap(item.key, b, "agents.stop", item.stopArgs), false, item.name));
  r.appendChild(acts);
  wrap.appendChild(r);
  const more = el("div", "more");
  if (q) {
    more.appendChild(el("div", "question", q.text));
    if (q.pick) more.appendChild(el("div", "pick", "Suggested: " + q.pick));
  } else if (item.reason) {
    more.appendChild(el("div", "pick", item.reason));
  }
  const o = open[item.key];
  if (o && o.kind === "answer" && q) more.appendChild(box(item.key, "Your answer…", (b, text) => tap(item.key, b, "agents.answer", { chatId: q.chatId, text })));
  if (o && o.kind === "message") more.appendChild(box(item.key, "Message " + item.name + "…", (b, text) => tap(item.key, b, "agents.message", { agentId: item.agentId, text })));
  if (notes[item.key]) more.appendChild(el("div", "note", notes[item.key]));
  if (item.workers) for (const w of item.workers) more.appendChild(workerLine(w));
  if (more.childNodes.length) wrap.appendChild(more);
  return wrap;
}
function workerLine(w) {
  const line = el("div", "worker");
  line.dataset.worker = w.id;
  const doing = w.state === "working" ? w.doing : w.reason || "";
  line.appendChild(el("div", doing ? "name" : "name wide", w.title));
  if (doing) line.appendChild(el("div", "doing", doing));
  line.appendChild(status(w.state, w.state === "done" || w.state === "failed" || w.state === "stopped" ? 0 : w.since, w.word, w.needsYou));
  const acts = el("div", "acts");
  acts.appendChild(btn("Open", (b) => tap("w:" + w.id, b, "chats.open", { workerId: w.id })));
  if (w.state === "working") acts.appendChild(btn("Stop", (b) => tap("w:" + w.id, b, "agents.stop", { workerId: w.id })));
  line.appendChild(acts);
  return line;
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

function draw() {
  if (!data) return;
  const focused = takeFocus();
  const agents = data.agents || [];
  const need = attention(agents);
  const busy = agents.filter((a) => (a.state === "working" || a.state === "paused" || a.state === "stuck") && !need.some((n) => n.key === "a:" + a.id));
  const idle = agents.filter((a) => a.state === "idle");
  fill("attention", need, row);
  fill("working", busy.map((a) => ({ key: "a:" + a.id, name: a.name, doing: a.doing, state: a.state, since: a.since, reason: a.reason, word: a.word, agentId: a.id, canMessage: !!a.chatId,
    openArgs: { agentId: a.id }, stopArgs: a.chatId ? { agentId: a.id } : null, workers: recent(a.workers || []) })), row);
  fill("idle", idle.map((a) => ({ key: "a:" + a.id, name: a.name, doing: "", state: "idle", agentId: a.id, canMessage: !!a.chatId,
    openArgs: { agentId: a.id }, workers: recent(a.workers || []) })), row);
  const parts = [];
  if (need.length) parts.push(need.length + (need.length === 1 ? " needs you" : " need you"));
  const working = agents.filter((a) => a.state === "working").length;
  if (working) parts.push(working + " working");
  if (idle.length) parts.push(idle.length + " idle");
  $("[data-summary]").textContent = agents.length ? parts.join(" · ") : "No agents yet. Your Monos show here once they're on the team.";
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

const NEEDS_HTML = `<div class="wrap">
<div class="summary" data-summary>Reading what's waiting on you…</div>
<div class="problem" data-problem hidden></div>
<section data-section="waiting" hidden><div class="section-title">Asking you</div><div class="card" data-list="waiting"></div></section>
<section data-section="needs" hidden><div class="section-title">Waiting on you</div><div class="card" data-list="needs"></div></section>
</div>`;

const NEEDS_JS =
  BASE_JS +
  `
let data = null;

// A chat that stopped to ask Ash something: answer it, take its suggestion, or open it.
function chatRow(c) {
  const key = "c:" + c.chatId;
  const wrap = el("div", "item");
  wrap.dataset.item = key;
  const r = el("div", "row");
  r.dataset.row = key;
  r.appendChild(who(c.chatName, c.projectName || "A chat"));
  r.appendChild(status("asking", c.askedAt, c.redLine ? "Red line" : "Asked", !!c.redLine));
  const acts = el("div", "acts");
  if (c.pick) acts.appendChild(btn("Take it", (b) => tap(key, b, "agents.pick", { chatId: c.chatId })));
  acts.appendChild(btn("Answer", () => { open[key] = { kind: "answer", text: "" }; focusNext = key; draw(); }, true));
  acts.appendChild(btn("Open", (b) => tap(key, b, "chats.open", { chatId: c.chatId })));
  r.appendChild(acts);
  wrap.appendChild(r);
  const more = el("div", "more");
  if (c.question) more.appendChild(el("div", "question", c.question));
  if (c.pick) more.appendChild(el("div", "pick", "Suggested: " + c.pick));
  const o = open[key];
  if (o && o.kind === "answer") more.appendChild(box(key, "Your answer…", (b, text) => tap(key, b, "agents.answer", { chatId: c.chatId, text })));
  if (notes[key]) more.appendChild(el("div", "note", notes[key]));
  if (more.childNodes.length) wrap.appendChild(more);
  return wrap;
}

// Something a project wants Ash to look at; a question from Ash OS can be answered here too.
function needRow(n) {
  const key = "n:" + n.id;
  const wrap = el("div", "item");
  wrap.dataset.item = key;
  const r = el("div", "row");
  r.dataset.row = key;
  r.appendChild(who(n.title, n.projectName || "Every project", n.why));
  r.appendChild(status("asking", n.since, "Waiting", false));
  const acts = el("div", "acts");
  if (n.isQuestion) {
    acts.appendChild(btn("Take it", (b) => tap(key, b, "agents.pick", { needId: n.id })));
    acts.appendChild(btn("Answer", () => { open[key] = { kind: "answer", text: "" }; focusNext = key; draw(); }, true));
  }
  r.appendChild(acts);
  wrap.appendChild(r);
  const more = el("div", "more");
  if (n.action) more.appendChild(el("div", "pick", "Next: " + n.action));
  const o = open[key];
  if (o && o.kind === "answer") more.appendChild(box(key, "Your answer…", (b, text) => tap(key, b, "agents.answer", { needId: n.id, text })));
  if (notes[key]) more.appendChild(el("div", "note", notes[key]));
  if (more.childNodes.length) wrap.appendChild(more);
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
  $("[data-summary]").textContent = parts.length ? parts.join(" · ") : "Nothing is waiting on you.";
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

const BUILT_HTML = `<div class="wrap">
<div class="summary" data-summary>Reading what's being built…</div>
<div class="problem" data-problem hidden></div>
<section data-section="jobs" hidden><div class="section-title">Being built</div><div class="card" data-list="jobs"></div></section>
</div>`;

const BUILT_JS =
  BASE_JS +
  `
let data = null;
const ACTIVE = ["working", "checking", "waiting", "stuck", "gave_up"];
// A job nobody is on is the one Ash must look at; a job its lead is on stays grey, as the red rule says.
const RANK = { gave_up: 0, stuck: 1, working: 2, checking: 3, waiting: 4 };
const JOB_WORD = { working: "Working", checking: "Checking", waiting: "Waiting", stuck: "With its lead", gave_up: "Needs you" };

function jobRow(j) {
  const key = "j:" + j.id;
  const wrap = el("div", "item");
  wrap.dataset.item = key;
  const r = el("div", "row");
  r.dataset.row = key;
  r.appendChild(who(j.title, [j.projectName, j.agentName].filter(Boolean).join(" · ") || "A job"));
  r.appendChild(status(j.state, j.lastActiveAt || j.startedAt, JOB_WORD[j.state] || "Working", j.state === "gave_up"));
  const acts = el("div", "acts");
  if (j.agentId) acts.appendChild(btn("Open", (b) => tap(key, b, "chats.open", { agentId: j.agentId })));
  r.appendChild(acts);
  wrap.appendChild(r);
  const more = el("div", "more");
  if (j.reason) more.appendChild(el("div", "question", j.reason));
  if (notes[key]) more.appendChild(el("div", "note", notes[key]));
  if (more.childNodes.length) wrap.appendChild(more);
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
  $("[data-summary]").textContent = parts.length ? parts.join(" · ") : "Nothing is being built right now.";
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

const PROJECTS_HTML = `<div class="wrap">
<div class="bar"><div class="summary" data-summary>Reading your projects…</div><button data-refresh type="button">Refresh</button></div>
<div class="problem" data-problem hidden></div>
<section data-section="projects" hidden><div class="section-title">Your projects</div><div class="card" data-list="projects"></div></section>
</div>`;

const PROJECTS_JS =
  BASE_JS +
  `
let data = null;
const tasks = {}; // a project's tasks once read; null while reading

const TASK_WORD = { stuck: "Stuck", waiting: "Waiting", building: "Building", later: "Later" };
const TASK_STATE = { stuck: "stuck", waiting: "asking", building: "working", later: "idle" };

function counts(p) {
  const c = p.counts || {};
  const parts = [];
  if (c.stuck) parts.push(c.stuck + " stuck");
  if (c.waiting) parts.push(c.waiting + " waiting");
  if (c.building) parts.push(c.building + " building");
  if (c.later) parts.push(c.later + " later");
  return parts;
}

function taskLine(t) {
  const line = el("div", "worker");
  line.dataset.task = t.id;
  line.appendChild(el("div", t.why ? "" : "name wide", t.title));
  if (t.why) line.appendChild(el("div", "doing", t.why));
  line.appendChild(status(TASK_STATE[t.state] || "idle", t.since, TASK_WORD[t.state] || "Later", false));
  line.appendChild(el("div", "acts"));
  return line;
}

// One project: its name, what its Monos are called, what is waiting in it, and what it holds once opened.
function projectRow(p) {
  const key = "p:" + p.id;
  const wrap = el("div", "item");
  wrap.dataset.item = key;
  const r = el("div", "row");
  r.dataset.row = key;
  const under = p.parked ? "Parked" : p.folder || "No folder";
  r.appendChild(who(p.name, under, (p.monos && p.monos.length ? p.monos.join(", ") : "No agents yet")));
  const c = p.counts || {};
  const word = c.stuck ? c.stuck + " stuck" : c.waiting ? c.waiting + " waiting" : c.building ? c.building + " building" : "All clear";
  r.appendChild(status(c.stuck ? "stuck" : c.waiting ? "asking" : c.building ? "working" : "idle", 0, word, false));
  const acts = el("div", "acts");
  const shown = tasks[p.id] !== undefined;
  acts.appendChild(btn(shown ? "Hide" : "Show", () => toggle(p.id), false));
  r.appendChild(acts);
  wrap.appendChild(r);
  const more = el("div", "more");
  const all = counts(p);
  if (all.length) more.appendChild(el("div", "pick", all.join(" · ")));
  const list = tasks[p.id];
  if (shown && list === null) more.appendChild(el("div", "note", "Reading this project…"));
  if (shown && list && !list.length) more.appendChild(el("div", "note", "Nothing in this project needs you."));
  if (shown && list) for (const t of list) more.appendChild(taskLine(t));
  if (notes[p.id]) more.appendChild(el("div", "note", notes[p.id]));
  if (more.childNodes.length) wrap.appendChild(more);
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
  const waiting = data.reduce((n, p) => n + (((p.counts && p.counts.waiting) || 0) + ((p.counts && p.counts.stuck) || 0)), 0);
  const building = data.reduce((n, p) => n + ((p.counts && p.counts.building) || 0), 0);
  const parts = [];
  if (data.length) parts.push(data.length === 1 ? "1 project" : data.length + " projects");
  if (waiting) parts.push(waiting + " waiting");
  if (building) parts.push(building + " being built");
  $("[data-summary]").textContent = parts.length ? parts.join(" · ") : "No projects yet.";
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
  { id: "projects", title: "Projects", what: "Your projects with what each one holds and what in it is waiting on you, opened in place without leaving the hub.", request: PROJECTS_READY, spec: PROJECTS_PAGE },
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
