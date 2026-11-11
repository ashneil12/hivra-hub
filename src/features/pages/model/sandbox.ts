import type { BespokeSpec } from "./pageSpec";

/**
 * How a bespoke page is framed: an iframe with sandbox="allow-scripts" only (no same-origin, so no storage, cookies,
 * parent DOM, IPC or Tauri), a strict content security policy (no network, no forms, no outside scripts), the theme
 * tokens injected as CSS variables, and a small helper library whose only way out is postMessage to the host.
 */
export const SANDBOX = "allow-scripts";
export const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
/** The tokens a page can use; copied from the host's computed values so the page follows the active theme and scheme. */
export const PAGE_TOKENS = ["--color-background-base", "--color-content", "--color-surface", "--color-surface-raised", "--color-surface-ring", "--color-stroke", "--color-theme-accent", "--color-status-ok", "--color-status-warn", "--color-status-bad", "--font-sans", "--space-card"] as const;

export function readTokens(root: Element = document.documentElement): Record<string, string> {
  const style = getComputedStyle(root);
  return Object.fromEntries(PAGE_TOKENS.map((t) => [t, style.getPropertyValue(t).trim()]));
}

/**
 * The helper library over postMessage: hub.call(name, args) (a read, or a tap: taps work only inside Ash's click),
 * hub.watch(name, [args], onData, [onError]) for live data (returns a stop function), hub.onData(fn) for every push, and
 * hub.block(kind, data) for bundled blocks. It also tells the host how tall the page is, so the frame fits it.
 */
const HELPER = `(() => {
  const NONCE = "__NONCE__";
  // Hidden from the hub's own code, which must not learn the nonce: the host trusts only a document that knows it.
  if (document.currentScript) document.currentScript.remove();
  const hello = () => parent.postMessage({ type: "hub:hello", nonce: NONCE }, "*");
  hello();
  let n = 0; const waiting = new Map(); const dataFns = []; const watches = new Map();
  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.type === "hub:ping") hello();
    if (m.type === "hub:reply" && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.ok ? w.resolve(m.result) : w.reject(new Error(m.error)); }
    if (m.type === "hub:data") { const w = watches.get(m.watch); if (w) w.onData(m.data); dataFns.forEach((f) => f(m.data, m.call)); }
    if (m.type === "hub:watch-error") { const w = watches.get(m.watch); if (w && w.onError) w.onError(new Error(m.error)); }
    if (m.type === "hub:watch-ended") { const w = watches.get(m.watch); watches.delete(m.watch); if (w && w.onError) w.onError(new Error(m.error)); }
  });
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = String(text); return x; };
  const ask = (type, call, args) => { const id = "c" + (++n); parent.postMessage({ type, id, call, args: args || {} }, "*"); return { id, done: new Promise((resolve, reject) => waiting.set(id, { resolve, reject })) }; };
  let lastHeight = 0;
  const size = () => { const h = Math.ceil(document.body ? document.body.getBoundingClientRect().height : 0); if (h && Math.abs(h - lastHeight) > 1) { lastHeight = h; parent.postMessage({ type: "hub:size", height: h }, "*"); } };
  window.addEventListener("load", () => { size(); if (window.ResizeObserver && document.body) new ResizeObserver(size).observe(document.body); });
  // The hub kit, for every built hub (Critiquito 22 Oct): the app's header already shows the hub's title, so the
  // hub's own first h1 is not shown twice; and a section with only its heading gets one grey line instead of a bare
  // heading. A section can name its line with data-empty="..."; the line goes once real content arrives.
  const HEAD = "h2,h3,h4,h5,h6,.section-title,.hub-block-title,[class*=title],[class*=heading]";
  const emptyLine = (section, head) => {
    if (section.dataset.empty) return section.dataset.empty;
    const t = (head ? head.textContent : "").trim().toLowerCase();
    if (/needs? you|waiting on you|for you|to answer|asking/.test(t)) return "Nothing waiting on you";
    if (/stuck|failed|blocked/.test(t)) return "Nothing stuck right now";
    if (/working|busy|running|in progress/.test(t)) return "Nobody working right now";
    if (/everyone else|everybody else|others|idle|the rest/.test(t)) return "No one else right now";
    return "Nothing here right now";
  };
  const hasContent = (section, head, note) => {
    for (const child of section.children) {
      if (child === head || child === note) continue;
      if ((child.textContent || "").trim() || child.querySelector("img,svg,canvas,button,input,select,textarea,iframe,video")) return true;
      if (/^(IMG|SVG|CANVAS|BUTTON|INPUT|SELECT|TEXTAREA|VIDEO)$/i.test(child.tagName)) return true;
    }
    return false;
  };
  let titleHidden = false;
  const kit = () => {
    if (!titleHidden) { const h1 = document.querySelector("body h1"); if (h1) { h1.style.display = "none"; h1.dataset.hubTitleShown = "header"; titleHidden = true; } }
    document.querySelectorAll("section,[data-section]").forEach((section) => {
      if (section.classList.contains("hub-block") && section.querySelector(".hub-note,.hub-bar-row,.hub-status-row")) return;
      const head = Array.from(section.children).find((c) => c.matches(HEAD)) || null;
      if (!head) return;
      let note = Array.from(section.children).find((c) => c.classList.contains("hub-empty")) || null;
      const full = hasContent(section, head, note);
      if (full && note) note.remove();
      if (!full && !note) { note = el("p", "hub-empty", emptyLine(section, head)); section.appendChild(note); }
    });
  };
  let queued = false;
  const queueKit = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; kit(); size(); }, 0); };
  document.addEventListener("DOMContentLoaded", () => {
    kit();
    if (window.MutationObserver) new MutationObserver((records) => { if (records.some((r) => !(r.target.classList && r.target.classList.contains("hub-empty")))) queueKit(); }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  window.hub = {
    call(call, args) { return ask("hub:call", call, args).done; },
    watch(call, args, onData, onError) {
      if (typeof args === "function") { onError = onData; onData = args; args = {}; }
      const req = ask("hub:watch", call, args);
      watches.set(req.id, { onData, onError });
      req.done.catch((err) => { watches.delete(req.id); if (onError) onError(err); else console.warn(err.message); });
      return () => { if (watches.delete(req.id)) parent.postMessage({ type: "hub:unwatch", id: req.id }, "*"); };
    },
    onData(fn) { dataFns.push(fn); },
    block(kind, data) {
      const card = el("section", "hub-block"); card.appendChild(el("div", "hub-block-title", data.title || kind));
      if (kind === "note") card.appendChild(el("p", "hub-note", data.text));
      if (kind === "barlist") { const max = Math.max(1, ...data.rows.map((r) => r.value)); data.rows.forEach((r) => { const row = el("div", "hub-bar-row"); const bar = el("div", "hub-bar"); bar.style.width = (r.value / max * 100) + "%"; bar.appendChild(el("span", "", r.label)); row.appendChild(bar); row.appendChild(el("span", "hub-bar-value", r.value)); card.appendChild(row); }); }
      if (kind === "status") { const row = el("div", "hub-status-row"); row.appendChild(el("span", "hub-dot", "")); row.lastChild.dataset.state = data.state; row.appendChild(el("span", "", data.line)); card.appendChild(row); }
      return card;
    },
  };
})();`;
const BASE_CSS = `
html,body{margin:0;background:transparent;color:var(--color-content);font-family:var(--font-sans);font-size:13px;line-height:1.5}
.hub-block{background:var(--color-surface);border-radius:12px;box-shadow:inset 0 0 0 1px var(--color-surface-ring);padding:var(--space-card,12px)}
.hub-block-title{font-size:12px;font-weight:500;color:color-mix(in srgb,var(--color-content) 60%,transparent);margin-bottom:10px}
.hub-empty{margin:4px 0 0;font-size:13px;font-weight:400;text-transform:none;letter-spacing:normal;color:color-mix(in srgb,var(--color-content) 60%,transparent)}
.hub-bar-row{display:flex;align-items:center;gap:12px;margin:6px 0}.hub-bar{flex:1;position:relative;border-radius:6px;background:color-mix(in srgb,var(--color-theme-accent) 22%,transparent);padding:4px 8px;white-space:nowrap}
.hub-bar-value{min-width:32px;text-align:right;color:color-mix(in srgb,var(--color-content) 75%,transparent)}
.hub-status-row{display:flex;align-items:center;gap:10px}.hub-dot{width:6px;height:6px;border-radius:9px;background:var(--color-status-ok)}.hub-dot[data-state=warn]{background:var(--color-status-warn)}.hub-dot[data-state=bad]{background:var(--color-status-bad)}
`;
/**
 * After the page's own CSS, so every built page gets it: section headings read in sentence case at a medium weight,
 * not bold caps (Critiquito 22 Oct). It changes only the case, spacing and weight, never colour or size.
 */
const KIT_CSS = `
:is(h2,h3,h4,h5,h6,.section-title,.hub-block-title,[class*=section-title],[class*=heading]){text-transform:none!important;letter-spacing:normal!important;font-variant-caps:normal!important}
section > :is(h2,h3,h4,h5,h6,.section-title,[class*=title],[class*=heading]):first-child{font-weight:500!important}
`;
/** A short fingerprint of a page's code: a new version of the page is a new frame (and a new bridge). */
export function specKey(spec: Pick<BespokeSpec, "html" | "css" | "js">): string {
  let h = 5381;
  for (const part of [spec.html, spec.css ?? "", spec.js ?? ""]) for (let i = 0; i < part.length; i++) h = ((h << 5) + h + part.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const escapeClose = (s: string, tag: string) => s.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

/** A fresh unguessable id for one frame's document (see PageBridgeOptions.nonce). */
export function newFrameNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function bespokeSrcdoc(spec: Pick<BespokeSpec, "html" | "css" | "js">, tokens: Record<string, string>, scheme: "dark" | "light" = "dark", nonce = ""): string {
  const vars = Object.entries(tokens).filter(([, v]) => v && !/[;{}<>]/.test(v)).map(([k, v]) => `${k}:${v}`).join(";");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="color-scheme" content="${scheme}"><style>:root{${vars};color-scheme:${scheme}}${BASE_CSS}</style><style>${escapeClose(spec.css ?? "", "style")}</style><style>${KIT_CSS}</style>
<script>${HELPER.replace("__NONCE__", () => nonce.replace(/[^A-Za-z0-9-]/g, ""))}</script></head><body>${spec.html}<script>${escapeClose(spec.js ?? "", "script")}</script></body></html>`;
}
