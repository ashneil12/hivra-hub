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

/** The helper library: hub.call(name, args) and hub.onData(fn) over postMessage, and hub.block(kind, data) for bundled blocks. */
const HELPER = `(() => {
  let n = 0; const waiting = new Map(); const dataFns = [];
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "hub:reply" && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.ok ? w.resolve(m.result) : w.reject(new Error(m.error)); }
    if (m.type === "hub:data") dataFns.forEach((f) => f(m.data));
  });
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = String(text); return x; };
  window.hub = {
    call(call, args) { const id = "c" + (++n); parent.postMessage({ type: "hub:call", id, call, args }, "*"); return new Promise((resolve, reject) => waiting.set(id, { resolve, reject })); },
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
.hub-block-title{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:color-mix(in srgb,var(--color-content) 60%,transparent);margin-bottom:10px}
.hub-bar-row{display:flex;align-items:center;gap:12px;margin:6px 0}.hub-bar{flex:1;position:relative;border-radius:6px;background:color-mix(in srgb,var(--color-theme-accent) 22%,transparent);padding:4px 8px;white-space:nowrap}
.hub-bar-value{min-width:32px;text-align:right;color:color-mix(in srgb,var(--color-content) 75%,transparent)}
.hub-status-row{display:flex;align-items:center;gap:10px}.hub-dot{width:6px;height:6px;border-radius:9px;background:var(--color-status-ok)}.hub-dot[data-state=warn]{background:var(--color-status-warn)}.hub-dot[data-state=bad]{background:var(--color-status-bad)}
`;
const escapeClose = (s: string, tag: string) => s.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

export function bespokeSrcdoc(spec: Pick<BespokeSpec, "html" | "css" | "js">, tokens: Record<string, string>, scheme: "dark" | "light" = "dark"): string {
  const vars = Object.entries(tokens).filter(([, v]) => v && !/[;{}<>]/.test(v)).map(([k, v]) => `${k}:${v}`).join(";");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="color-scheme" content="${scheme}"><style>:root{${vars};color-scheme:${scheme}}${BASE_CSS}</style><style>${escapeClose(spec.css ?? "", "style")}</style>
<script>${HELPER}</script></head><body>${spec.html}<script>${escapeClose(spec.js ?? "", "script")}</script></body></html>`;
}
