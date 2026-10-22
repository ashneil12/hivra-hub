// Ready-made pages: built with the same connected bridge a Mono's page uses (hub.watch and the taps), so Ash can see it
// working and ask a Mono for his own on the same pattern (Rebuild changes it from his words). They go through the same
// preview and Keep and allow as any page; nothing is kept or allowed by itself.
import type { BespokeSpec } from "./pageSpec";

/** The request a ready-made page is kept with: how Pages knows it is already there. */
export const AGENTS_READY = "Ready-made: Agents";
export const READY_BY = "Ready-made";

const AGENTS_CSS = `
.wrap{display:flex;flex-direction:column;gap:20px;padding:2px 2px 8px}
.summary{font-size:13px;color:color-mix(in srgb,var(--color-content) 75%,transparent)}
.problem{font-size:12px;color:color-mix(in srgb,var(--color-content) 80%,transparent)}
.section-title{font-size:12px;font-weight:500;color:color-mix(in srgb,var(--color-content) 62%,transparent);padding:0 8px 6px}
.card{background:var(--color-surface);border-radius:12px;box-shadow:inset 0 0 0 1px var(--color-surface-ring);padding:4px}
.item{border-radius:8px}
.item:hover{background:color-mix(in srgb,var(--color-content) 4%,transparent)}
.item + .item{border-top:1px solid var(--color-stroke);border-top-left-radius:0;border-top-right-radius:0}
.row,.worker{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1.4fr) 124px 260px;align-items:center;gap:12px;padding:8px}
.wide{grid-column:span 2}
.name{font-size:13px;color:var(--color-content);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.under{font-size:12px;color:color-mix(in srgb,var(--color-content) 62%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doing{font-size:13px;color:color-mix(in srgb,var(--color-content) 85%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{display:flex;align-items:center;gap:6px;font-size:12px;color:color-mix(in srgb,var(--color-content) 70%,transparent);white-space:nowrap}
.status-dot{width:6px;height:6px;border-radius:9px;flex:none;background:color-mix(in srgb,var(--color-content) 35%,transparent)}
.status-dot[data-state=working]{background:var(--color-status-ok)}
.status-dot[data-state=asking],.status-dot[data-state=stuck],.status-dot[data-state=paused]{background:var(--color-status-warn)}
.status-dot[data-state=failed]{background:var(--color-status-bad)}
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

// Plain DOM, no libraries: the page re-draws on every push and keeps what Ash is typing (and where) across a redraw.
const AGENTS_JS = `
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = String(text); return x; };
const WORD = { asking: "Asking", stuck: "Stuck", working: "Working", paused: "Paused", idle: "Idle", failed: "Failed", done: "Done", stopped: "Stopped" };
const open = {};      // which answer or message box is open, and what is typed in it
const notes = {};     // what a tap said, by row
let data = null;
let focusNext = null; // a box just opened takes the focus

function ago(ms) {
  if (!ms) return "";
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : Math.floor(m / 1440) + "d";
}
function status(state, since) {
  const s = el("span", "status");
  const dot = el("span", "status-dot"); dot.dataset.state = state; s.appendChild(dot);
  s.appendChild(el("span", "", WORD[state] + (since && state !== "idle" ? " · " + ago(since) : "")));
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
function btn(label, onClick, primary) {
  const b = el("button", primary ? "primary" : "", label);
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

// One row: a name and what is under it, what it is doing, its state and time, its buttons; then its question.
function row(item) {
  const wrap = el("div", "item");
  wrap.dataset.item = item.key;
  const r = el("div", "row");
  r.dataset.row = item.key;
  const who = el("div", item.doing ? "" : "wide");
  who.appendChild(el("div", "name", item.name));
  if (item.under) who.appendChild(el("div", "under", item.under));
  r.appendChild(who);
  if (item.doing) r.appendChild(el("div", "doing", item.doing));
  r.appendChild(status(item.state, item.since));
  const acts = el("div", "acts");
  const q = item.question;
  if (q && q.canAnswer && q.pick) acts.appendChild(btn("Take it", (b) => tap(item.key, b, "agents.pick", { chatId: q.chatId }), false));
  if (q && q.canAnswer) acts.appendChild(btn("Answer", () => { open[item.key] = { kind: "answer", text: "" }; focusNext = item.key; draw(); }, true));
  if (item.canMessage) acts.appendChild(btn("Message", () => { open[item.key] = { kind: "message", text: "" }; focusNext = item.key; draw(); }));
  acts.appendChild(btn("Open", (b) => tap(item.key, b, "chats.open", item.openArgs)));
  if (item.stopArgs) acts.appendChild(btn("Stop", (b) => tap(item.key, b, "agents.stop", item.stopArgs)));
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
  line.appendChild(status(w.state, w.state === "done" || w.state === "failed" || w.state === "stopped" ? 0 : w.since));
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
      if (w.state === "asking" || w.state === "stuck")
        out.push({ key: "w:" + w.id, name: w.title, under: "From " + path, doing: "", state: w.state, since: w.since, reason: w.reason,
          question: w.question, openArgs: { workerId: w.id }, stopArgs: { workerId: w.id } });
      walk(agent, w.workers || [], path);
    }
  };
  for (const a of agents) {
    if (a.state === "asking" || a.state === "stuck")
      out.push({ key: "a:" + a.id, name: a.name, doing: a.state === "stuck" ? a.doing : "", state: a.state, since: a.since, reason: a.reason, question: a.question,
        agentId: a.id, openArgs: { agentId: a.id }, stopArgs: a.state === "stuck" && a.chatId ? { agentId: a.id } : null });
    walk(a, a.workers || [], a.name);
  }
  const rank = { asking: 0, stuck: 1 };
  return out.sort((x, y) => rank[x.state] - rank[y.state] || (x.since || 0) - (y.since || 0));
}
const recent = (workers) => workers.filter((w) => w.state === "working" || w.state === "done" || w.state === "failed" || w.state === "stopped").slice(-5);

function fill(name, items) {
  const list = $('[data-list="' + name + '"]');
  list.textContent = "";
  for (const item of items) list.appendChild(row(item));
  $('[data-section="' + name + '"]').hidden = !items.length;
}

function draw() {
  if (!data) return;
  const focused = focusNext || (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.box : null);
  focusNext = null;
  const agents = data.agents || [];
  const need = attention(agents);
  const busy = agents.filter((a) => (a.state === "working" || a.state === "paused") && !need.some((n) => n.key === "a:" + a.id));
  const idle = agents.filter((a) => a.state === "idle");
  fill("attention", need);
  fill("working", busy.map((a) => ({ key: "a:" + a.id, name: a.name, doing: a.doing, state: a.state, since: a.since, agentId: a.id, canMessage: !!a.chatId,
    openArgs: { agentId: a.id }, stopArgs: a.chatId ? { agentId: a.id } : null, workers: recent(a.workers || []) })));
  fill("idle", idle.map((a) => ({ key: "a:" + a.id, name: a.name, doing: "", state: "idle", agentId: a.id, canMessage: !!a.chatId,
    openArgs: { agentId: a.id }, workers: recent(a.workers || []) })));
  const parts = [];
  if (need.length) parts.push(need.length + (need.length === 1 ? " needs you" : " need you"));
  const working = agents.filter((a) => a.state === "working").length;
  if (working) parts.push(working + " working");
  if (idle.length) parts.push(idle.length + " idle");
  $("[data-summary]").textContent = agents.length ? parts.join(" · ") : "No agents yet. Your Monos show here once they're on the team.";
  if (focused) { const box = document.querySelector('[data-box="' + focused + '"]'); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }
}

hub.watch("agents.read", (d) => { data = d; $("[data-problem]").hidden = true; draw(); },
  (err) => { const p = $("[data-problem]"); p.hidden = false; p.textContent = "Can't read your agents: " + err.message; });
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

export type ReadyPage = { id: string; title: string; what: string; request: string; spec: BespokeSpec };
export const READY_PAGES: readonly ReadyPage[] = [
  { id: "agents", title: "Agents", what: "Every agent and what it's doing, with the stuck and asking ones on top: answer, open or stop them from one place.", request: AGENTS_READY, spec: AGENTS_PAGE },
];
