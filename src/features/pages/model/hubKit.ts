/**
 * The hub kit: the parts every hub is drawn from (Ash, 12 Nov: "a reusable parts and asset list, a proper setup for
 * designing hubs"). Every bespoke hub gets the CSS (before its own, so a hub can still adjust a part) and a `kit` global
 * of small builders, so a first mate building a hub picks parts instead of drawing rows by hand. The four ready-made
 * hubs are built from the same parts. The list a first mate reads is docs/hivra/HUB-KIT.md and the make-a-hub skill.
 *
 * Theme tokens only (docs/hivra/DESIGN.md section 4.9): the only colours are the status colours, and they mean a real
 * state. Small text stays at 60% or more; 13px body, 12px hints, 11px tags; one primary button per surface.
 */

/** The part a status word is drawn in. `bad` is the one Needs you red: only when the owner must act. */
export const HUB_TONES = ["ok", "warn", "bad", "idle"] as const;

/** The kit's icons, by name (24-unit stroke paths, drawn at 14px with stroke 1.75 like the app's own). */
export const HUB_ICONS: Record<string, string> = {
  open: '<path d="M8 16 16 8"/><path d="M9.5 8H16v6.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  message: '<path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V16h0a1 1 0 0 1-1-1z"/>',
  reply: '<path d="M10 8 5 12.5 10 17"/><path d="M5.5 12.5H14a5 5 0 0 1 5 5V19"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5"/><path d="M12 15.8v.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  chevron: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  folder: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2h7A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3.5 18.5a5.5 5.5 0 0 1 11 0"/><path d="M15 6.2a3 3 0 0 1 0 5.6"/><path d="M17 13.5a5.5 5.5 0 0 1 3.5 5"/>',
  bot: '<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 5v3"/><path d="M9.5 12.5v1"/><path d="M14.5 12.5v1"/>',
  spark: '<path d="M12 4.5 13.6 10.4 19.5 12 13.6 13.6 12 19.5 10.4 13.6 4.5 12 10.4 10.4z"/>',
  build: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4.5 15.5a1.5 1.5 0 0 0 0 2l2 2a1.5 1.5 0 0 0 2 0l5-5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  inbox: '<path d="M4.5 13.5 6.5 6h11l2 7.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18z"/><path d="M4.5 13.5H9l1 2h4l1-2h4.5"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 5v4h-4"/>',
  plus: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m19.5 19.5-4-4"/>',
  calendar: '<rect x="4.5" y="6" width="15" height="13.5" rx="2"/><path d="M4.5 10h15"/><path d="M9 4v4"/><path d="M15 4v4"/>',
  chart: '<path d="M5 19.5V5"/><path d="M5 19.5h14.5"/><path d="M9 16v-4"/><path d="M13 16V9"/><path d="M17 16v-6"/>',
  doc: '<path d="M7 4.5h7l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M14 4.5v4h4"/><path d="M9 13h6"/><path d="M9 16.5h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1-1"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M9 6v12"/><path d="M15 6v12"/>',
  hand: '<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10V5a1.5 1.5 0 0 1 3 0v5"/><path d="M14 10V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-5-2.7L4 14.5a1.5 1.5 0 0 1 2.5-1.6L8 15"/>',
  moon: '<path d="M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9z"/>',
};

export const HUB_KIT_CSS = `
:root{--k-soft:color-mix(in srgb,var(--color-content) 78%,transparent);--k-faint:color-mix(in srgb,var(--color-content) 62%,transparent);--k-wash:color-mix(in srgb,var(--color-content) 7%,transparent);--k-hover:color-mix(in srgb,var(--color-content) 4%,transparent);--k-line:var(--color-stroke);--k-radius:12px}
[hidden]{display:none!important}
.k-page{display:flex;flex-direction:column;gap:22px;padding:2px 2px 12px}
.k-head{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-height:28px}
.k-head > .k-lede{flex:1;min-width:0}
.k-lede{font-size:13px;color:var(--k-soft)}
.k-problem{font-size:12px;color:var(--k-soft)}
.k-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.k-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}
.k-stat{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px 14px;border:0;border-radius:var(--k-radius);background:var(--color-surface);box-shadow:inset 0 0 0 1px var(--color-surface-ring);font:inherit;color:inherit;text-align:left;min-width:0}
.k-stat.k-click{cursor:pointer;transition:background .15s}
.k-stat.k-click:hover{background:var(--color-surface-raised)}
.k-stat[aria-pressed=true]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-content) 35%,transparent)}
.k-stat-label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--k-faint);white-space:nowrap}
.k-stat-value{font-size:22px;font-weight:600;line-height:1.15;letter-spacing:-.01em;color:var(--color-content);font-variant-numeric:tabular-nums}
.k-stat[data-tone=bad] .k-stat-value{color:var(--color-status-bad)}
.k-stat[data-zero] .k-stat-value{color:var(--k-faint)}
.k-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.k-section-head{display:flex;align-items:center;gap:8px;padding:0 4px;font-size:12px;font-weight:500;color:var(--k-faint)}
.k-section-head .k-spacer{flex:1}
.k-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;border-radius:9px;font-size:11px;font-weight:500;background:var(--k-wash);color:var(--k-soft);font-variant-numeric:tabular-nums}
.k-count[data-tone=bad]{background:color-mix(in srgb,var(--color-status-bad) 16%,transparent);color:var(--color-status-bad)}
.k-card{background:var(--color-surface);border-radius:var(--k-radius);box-shadow:inset 0 0 0 1px var(--color-surface-ring);padding:4px;min-width:0}
.k-card.k-pad{padding:14px}
.k-card[data-tone=bad]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-status-bad) 40%,var(--color-surface-ring))}
.k-card[data-tone=warn]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-status-warn) 35%,var(--color-surface-ring))}
.k-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.k-item{border-radius:8px;min-width:0}
.k-item + .k-item{border-top:1px solid var(--k-line);border-top-left-radius:0;border-top-right-radius:0}
.k-row{display:flex;align-items:center;gap:12px;padding:10px;border-radius:8px;min-width:0}
.k-row.k-click{cursor:pointer}
.k-row.k-click:hover,.k-tile.k-click:hover{background:var(--k-hover)}
.k-main{flex:1 1 160px;min-width:0;display:flex;flex-direction:column;gap:1px}
.k-title{font-size:13px;font-weight:500;color:var(--color-content);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-sub{font-size:12px;color:var(--k-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-text{font-size:13px;color:var(--k-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.k-aside{flex:none;display:flex;align-items:center;gap:8px}
.k-actions{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:2px}
.k-tile{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:var(--k-radius);background:var(--color-surface);box-shadow:inset 0 0 0 1px var(--color-surface-ring);min-width:0}
.k-tile-top{display:flex;align-items:center;gap:10px;min-width:0}
.k-tile .k-actions{justify-content:flex-start;margin-left:-6px}
.k-avatar{position:relative;flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:10px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--color-content);background:var(--k-wash);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-content) 9%,transparent)}
.k-avatar.k-sm{width:22px;height:22px;border-radius:7px;font-size:10px}
.k-avatar .k-icon{width:16px;height:16px}
.k-avatar[data-tone]::after{content:"";position:absolute;right:-2px;bottom:-2px;width:9px;height:9px;border-radius:50%;background:var(--k-tone);box-shadow:0 0 0 2px var(--color-surface)}
.k-avatar.k-sm[data-tone]::after{width:7px;height:7px;right:-1px;bottom:-1px}
:is(.k-pill,.k-avatar,.k-dot,.k-meter,.k-stat,.k-callout)[data-tone=ok]{--k-tone:var(--color-status-ok)}
:is(.k-pill,.k-avatar,.k-dot,.k-meter,.k-stat,.k-callout)[data-tone=warn]{--k-tone:var(--color-status-warn)}
:is(.k-pill,.k-avatar,.k-dot,.k-meter,.k-stat,.k-callout)[data-tone=bad]{--k-tone:var(--color-status-bad)}
:is(.k-pill,.k-avatar,.k-dot,.k-meter,.k-stat,.k-callout)[data-tone=idle]{--k-tone:color-mix(in srgb,var(--color-content) 38%,transparent)}
.k-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--k-tone,currentColor)}
.k-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:11px;font-size:12px;white-space:nowrap;color:var(--k-soft);background:color-mix(in srgb,var(--k-tone,var(--color-content)) 13%,transparent)}
.k-pill::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--k-tone,currentColor)}
.k-pill[data-tone=idle]{background:var(--k-wash)}
.k-pill[data-tone=bad]{color:var(--color-status-bad);font-weight:500}
.k-pill[data-live]::before{animation:k-pulse 2.2s ease-in-out infinite}
@keyframes k-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--k-tone) 55%,transparent)}50%{box-shadow:0 0 0 4px transparent}}
@media (prefers-reduced-motion:reduce){.k-pill[data-live]::before{animation:none}}
.k-tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:6px;font-size:11px;white-space:nowrap;background:var(--k-wash);color:var(--k-soft)}
.k-tags{display:flex;flex-wrap:wrap;gap:4px}
.k-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;border-radius:7px;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer;background:transparent;color:var(--k-soft);transition:background .15s,color .15s}
.k-btn:hover{background:var(--color-surface-raised);color:var(--color-content)}
.k-btn.k-quiet{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-content) 18%,transparent)}
.k-btn.k-primary{background:var(--color-content);color:var(--color-background-base);font-weight:500}
.k-btn.k-primary:hover{background:color-mix(in srgb,var(--color-content) 88%,transparent);color:var(--color-background-base)}
.k-btn:disabled{opacity:.45;cursor:default}
.k-btn.k-icon-only{width:28px;padding:0;justify-content:center}
.k-icon{flex:none;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.k-callout{display:flex;flex-direction:column;gap:8px;margin:0 10px 10px 54px;padding:10px 12px;border-radius:10px;background:var(--color-surface-raised);box-shadow:inset 2px 0 0 var(--k-tone,var(--k-line))}
.k-callout-text{font-size:13px;line-height:1.45;color:var(--color-content)}
.k-callout-hint{font-size:12px;color:var(--k-faint)}
.k-nest{display:flex;flex-direction:column;margin:-4px 10px 8px 25px;padding-left:16px;border-left:1px solid var(--k-line)}
.k-nest .k-row{gap:10px;padding:5px 8px}
.k-field{display:flex;align-items:center;gap:6px}
.k-input{flex:1;min-width:0;height:30px;padding:0 10px;border:0;border-radius:7px;outline:none;font:inherit;font-size:13px;color:var(--color-content);background:var(--color-surface);box-shadow:inset 0 0 0 1px var(--color-surface-ring)}
.k-input:focus{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-content) 35%,transparent)}
.k-input::placeholder{color:var(--k-faint)}
.k-meter{height:6px;border-radius:3px;background:var(--k-wash);overflow:hidden}
.k-meter > span{display:block;height:100%;border-radius:3px;background:var(--k-tone,var(--color-theme-accent))}
.k-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:32px 16px;text-align:center;font-size:13px;color:var(--k-faint)}
.k-empty .k-avatar{width:40px;height:40px;border-radius:12px;color:var(--k-soft)}
.k-empty .k-avatar .k-icon{width:18px;height:18px}
.k-note{font-size:12px;color:var(--k-soft)}
@media (max-width:659px){
.k-row{flex-wrap:wrap;row-gap:6px}
.k-row > .k-actions{flex-basis:100%;justify-content:flex-start;padding-left:38px}
.k-nest .k-row > .k-actions{padding-left:0}
.k-callout{margin-left:10px}
}
`;

/**
 * `kit`: builders for the parts above, each returning a DOM node. Plain DOM, no libraries; text always goes in as text,
 * never as HTML. A tap that changes something still goes through `hub.call` inside the click, as before.
 */
export const HUB_KIT_JS = `window.kit = (() => {
  const ICONS = ${JSON.stringify(HUB_ICONS)};
  const SVG = "http://www.w3.org/2000/svg";
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = String(text); return x; };
  const add = (parent, kids) => { for (const k of [].concat(kids)) if (k != null && k !== false) parent.appendChild(typeof k === "string" ? document.createTextNode(k) : k); return parent; };
  // A state word's tone: working is green, asking or paused amber, failed red only with needsYou (the red rule).
  const TONE = { working: "ok", running: "ok", checking: "ok", building: "ok", done: "idle", asking: "warn", waiting: "warn", paused: "warn", stuck: "idle", gave_up: "bad", failed: "idle", stopped: "idle", idle: "idle", later: "idle" };
  const tone = (state, needsYou) => needsYou ? "bad" : TONE[state] || "idle";
  function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "k-icon");
    svg.innerHTML = ICONS[name] || "";
    return svg;
  }
  function initials(name) {
    const words = String(name || "?").replace(/[^\\p{L}\\p{N} ]/gu, " ").trim().split(/\\s+/).filter(Boolean);
    if (!words.length) return "?";
    return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  function avatar(name, opts) {
    const o = opts || {};
    const a = el("span", "k-avatar" + (o.small ? " k-sm" : ""));
    if (o.icon) a.appendChild(icon(o.icon)); else a.textContent = initials(name);
    if (o.tone) a.dataset.tone = o.tone;
    a.setAttribute("aria-hidden", "true");
    return a;
  }
  function pill(t, text, opts) {
    const p = el("span", "k-pill", text);
    p.dataset.tone = t || "idle";
    if (opts && opts.live) p.dataset.live = "";
    return p;
  }
  function ago(ms) {
    if (!ms) return "";
    const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : Math.floor(m / 1440) + "d";
  }
  function button(label, onClick, opts) {
    const o = opts || {};
    const b = el("button", "k-btn" + (o.primary ? " k-primary" : "") + (o.quiet ? " k-quiet" : "") + (o.iconOnly ? " k-icon-only" : ""));
    b.type = "button";
    if (o.icon) b.appendChild(icon(o.icon));
    if (!o.iconOnly) b.appendChild(document.createTextNode(label));
    if (o.iconOnly || o.name) b.setAttribute("aria-label", o.name ? label + " " + o.name : label);
    if (o.hook) b.setAttribute("data-" + o.hook, "");
    b.addEventListener("click", (e) => { e.stopPropagation(); if (onClick) onClick(b, e); });
    return b;
  }
  function stat(o) {
    // A div, not a button: its number and its label sit on two lines, and a button's words stay on one.
    const s = el("div", "k-stat" + (o.onClick ? " k-click" : ""));
    if (o.onClick) {
      s.setAttribute("role", "button"); s.tabIndex = 0;
      s.addEventListener("click", () => o.onClick(s));
      s.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); o.onClick(s); } });
      if (o.active != null) s.setAttribute("aria-pressed", o.active ? "true" : "false");
    }
    if (o.tone) s.dataset.tone = o.tone;
    if (!o.value) s.dataset.zero = "";
    const label = el("span", "k-stat-label");
    if (o.tone) { const d = el("span", "k-dot"); d.dataset.tone = o.tone; label.appendChild(d); }
    label.appendChild(document.createTextNode(o.label));
    s.appendChild(el("span", "k-stat-value", o.value == null ? "–" : o.value));
    s.appendChild(label);
    return s;
  }
  function row(o) {
    const r = el("div", "k-row" + (o.onClick ? " k-click" : "") + (o.className ? " " + o.className : ""));
    if (o.onClick) { r.addEventListener("click", o.onClick); r.tabIndex = 0; r.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === r) o.onClick(e); }); }
    if (o.lead) r.appendChild(o.lead);
    const main = el("div", "k-main");
    main.appendChild(el("div", "k-title", o.title));
    if (o.sub) main.appendChild(el("div", "k-sub", o.sub));
    r.appendChild(main);
    if (o.aside && [].concat(o.aside).length) r.appendChild(add(el("div", "k-aside"), o.aside));
    if (o.actions && [].concat(o.actions).length) r.appendChild(add(el("div", "k-actions"), o.actions));
    return r;
  }
  function tile(o) {
    const t = el("div", "k-tile" + (o.onClick ? " k-click" : ""));
    if (o.onClick) t.addEventListener("click", o.onClick);
    const top = el("div", "k-tile-top");
    if (o.lead) top.appendChild(o.lead);
    const main = el("div", "k-main");
    main.appendChild(el("div", "k-title", o.title));
    if (o.sub) main.appendChild(el("div", "k-sub", o.sub));
    top.appendChild(main);
    if (o.aside) add(top, o.aside);
    t.appendChild(top);
    if (o.body) add(t, o.body);
    if (o.actions && [].concat(o.actions).length) t.appendChild(add(el("div", "k-actions"), o.actions));
    return t;
  }
  function section(title, opts) {
    const o = opts || {};
    const s = el("section", "k-section");
    const head = el("div", "k-section-head", title);
    if (o.count != null) { const c = el("span", "k-count", o.count); if (o.tone) c.dataset.tone = o.tone; head.appendChild(c); }
    if (o.actions) { head.appendChild(el("span", "k-spacer")); add(head, o.actions); }
    s.appendChild(head);
    if (o.body) add(s, o.body);
    return s;
  }
  function callout(text, opts) {
    const o = opts || {};
    const c = el("div", "k-callout");
    if (o.tone) c.dataset.tone = o.tone;
    if (text) c.appendChild(el("div", "k-callout-text", text));
    if (o.hint) c.appendChild(el("div", "k-callout-hint", o.hint));
    if (o.body) add(c, o.body);
    return c;
  }
  function empty(text, iconName) {
    const e = el("div", "k-empty");
    e.appendChild(avatar("", { icon: iconName || "check" }));
    e.appendChild(el("div", "", text));
    return e;
  }
  function meter(value, max, t) {
    const m = el("div", "k-meter"); if (t) m.dataset.tone = t;
    const bar = el("span"); bar.style.width = Math.max(0, Math.min(100, (value / (max || 1)) * 100)) + "%";
    m.appendChild(bar); m.setAttribute("role", "img"); m.setAttribute("aria-label", value + " of " + max);
    return m;
  }
  const tag = (text) => el("span", "k-tag", text);
  return { el, add, icon, ICONS: Object.keys(ICONS), initials, avatar, pill, tone, ago, button, stat, row, tile, section, callout, empty, meter, tag };
})();`;
