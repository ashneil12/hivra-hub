/**
 * WP-130 sandbox for one visual HTML reply.
 *
 * The behaviour (a reply that is HTML, shown in a frame) is an idea from T3
 * Code's html renders note at commit e85e0094dd4617a1eada1ad7961f2132a79e67b2.
 * No T3 source is copied. The policy below is Hivra's, and it is tighter:
 * the frame has no network until the person opts in for that reply, and opting
 * in still does not allow remote scripts, frames, forms or navigation.
 * Navigation is blocked by the shell frame's `frame-src 'none'`, not by
 * patching `location`, which the browser does not allow.
 */

export const VISUAL_REPLY_MAX_BYTES = 512 * 1024;
export const VISUAL_SANDBOX = "allow-scripts";
export const VISUAL_FRAME_MIN_HEIGHT = 80;
export const VISUAL_FRAME_MAX_HEIGHT = 2400;
export const VISUAL_FRAME_PLACEHOLDER_HEIGHT = 240;
export const VISUAL_HEIGHT_MESSAGE = "hivra:visual-height";
export const VISUAL_THEME_MESSAGE = "hivra:visual-theme";
/** Sent by the shell once it has loaded. A frame that never sends it did not load, so the reply shows its source. */
export const VISUAL_READY_MESSAGE = "hivra:visual-ready";
/**
 * The most a served frame document may be (the shell with its escaped guest). A reply at the source cap, with every
 * character a quote, escapes to about 3.0 MiB, so this leaves room for the helpers. page_frames.rs keeps the same number.
 */
export const VISUAL_FRAME_MAX_BYTES = 3_355_443;

export type VisualScheme = "dark" | "light";

export type VisualTheme = {
  scheme: VisualScheme;
  background: string;
  text: string;
  font: string;
  mono: string;
};

export const FALLBACK_THEME: VisualTheme = {
  scheme: "dark",
  background: "#111111",
  text: "#eeeeee",
  font: "sans-serif",
  mono: "ui-monospace, monospace",
};

const LOCKED_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const OPEN_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https: wss:",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/*
 * The shell carries the same policy as its guest. A srcdoc guest inherits the
 * shell's policy and the two combine, so the guest can never get more than
 * the shell allows. `frame-src 'none'` is what stops the guest navigating
 * itself: both browsers refuse that request. Srcdoc guests still load.
 * With the network on, only https and wss are allowed: never plain http or
 * ws, so a plain http server, `file:` and the app's own http schemes stay shut.
 * https still names localhost and the LAN. A content policy cannot tell them
 * apart; the WP doc records this as a known limit.
 */

/** Locked unless `network` is exactly true. Remote scripts are never added. */
export function visualCsp(network: boolean): string {
  return network === true ? OPEN_CSP : LOCKED_CSP;
}

/** The policy the app serves the shell with: the sandbox, then the same policy as the guest. */
export function visualFrameCsp(network: boolean): string {
  return `sandbox allow-scripts; ${visualCsp(network)}`;
}

/** The line shown while the network is on for a reply. Null while it is off. */
export function networkNote(network: boolean): string | null {
  if (network !== true) return null;
  return "Network on for this reply: it can reach any https site, including this machine and your local network over https.";
}

/** True for the shell's ready message and nothing else. */
export function isVisualReadyMessage(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return (data as { type?: unknown }).type === VISUAL_READY_MESSAGE;
}

export function visualBytes(source: string): number {
  return new TextEncoder().encode(source).length;
}

export function visualTooBig(source: string): boolean {
  return visualBytes(source) > VISUAL_REPLY_MAX_BYTES;
}

const VISUAL_FENCE_LANGUAGES = new Set(["visual", "visual-html", "hivra-visual"]);

/**
 * True when a fence is marked as a visual reply.
 * The language `visual`, `visual-html` or `hivra-visual` is an explicit mark.
 * The only hint is an `html` or `htm` fence whose info string is the single
 * word `visual`. A plain html fence stays ordinary Markdown.
 */
export function visualFenceMark(language: string, meta: string): boolean {
  const name = language.trim().toLowerCase();
  if (VISUAL_FENCE_LANGUAGES.has(name)) return true;
  if (name !== "html" && name !== "htm") return false;
  return meta.trim().toLowerCase() === "visual";
}

function safeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) return fallback;
  if (/[;{}<>\\"'`]/.test(trimmed)) return fallback;
  if (/url\s*\(|expression\s*\(|@import/i.test(trimmed)) return fallback;
  return trimmed;
}

function safeFont(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return fallback;
  if (/[;{}<>\\`]/.test(trimmed)) return fallback;
  if (/url\s*\(|expression\s*\(|@import/i.test(trimmed)) return fallback;
  return trimmed;
}

/** A theme safe to write into the frame. Anything odd falls back field by field. */
export function safeTheme(theme: Partial<VisualTheme> | null | undefined): VisualTheme {
  const scheme = theme?.scheme === "light" ? "light" : "dark";
  return {
    scheme,
    background: safeColor(theme?.background, FALLBACK_THEME.background),
    text: safeColor(theme?.text, FALLBACK_THEME.text),
    font: safeFont(theme?.font, FALLBACK_THEME.font),
    mono: safeFont(theme?.mono, FALLBACK_THEME.mono),
  };
}

/** Inline style the host can post later. The frame rejects anything else. */
export function visualThemeCss(theme: Partial<VisualTheme> | null | undefined): string {
  const safe = safeTheme(theme);
  return `--hivra-background:${safe.background};--hivra-text:${safe.text};--hivra-font:${safe.font};--hivra-mono:${safe.mono};color-scheme:${safe.scheme}`;
}

function themeBlock(theme: VisualTheme): string {
  return `:root{${visualThemeCss(theme)}}html{background:var(--hivra-background);color:var(--hivra-text);font-family:var(--hivra-font),sans-serif}code,pre,kbd,samp{font-family:var(--hivra-mono),ui-monospace,monospace}`;
}

/**
 * Runs in the guest, before the reply. Cancels clicks that leave the page,
 * and applies a later theme message. It never reads the reply.
 * The string must not contain a closing script tag.
 * Setting `location` is not patched: the property is not replaceable. The
 * shell's frame policy is what blocks that navigation.
 */
const HELPER = `(function () {
  ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"].forEach(function (name) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  });
  document.addEventListener("click", function (event) {
    var node = event.target;
    while (node && node.nodeType === 1 && node.tagName !== "A") node = node.parentNode;
    if (!node || node.tagName !== "A") return;
    var link = node.getAttribute("href") || "";
    if (link.slice(0, 2) === "//" || /^[a-z][a-z0-9+.-]*:/i.test(link)) event.preventDefault();
  }, true);
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.type !== "${VISUAL_THEME_MESSAGE}" || typeof message.css !== "string") return;
    if (message.css.length > 2000 || /[<>]/.test(message.css)) return;
    document.documentElement.setAttribute("style", message.css);
  });
  function sendHeight() {
    var root = document.documentElement;
    var height = root ? root.scrollHeight : 0;
    try { window.parent.postMessage({ type: "${VISUAL_HEIGHT_MESSAGE}", height: height }, "*"); } catch (e) {}
  }
  window.addEventListener("load", function () {
    sendHeight();
    if (typeof ResizeObserver === "function" && document.documentElement) {
      new ResizeObserver(sendHeight).observe(document.documentElement);
    }
  });
})();`;

/**
 * Forwards only a height from the guest out, and theme messages in. Anything else from the
 * parent is ignored. The string must not contain a closing script tag.
 */
const SHELL = `(function () {
  try { window.parent.postMessage({ type: "${VISUAL_READY_MESSAGE}" }, "*"); } catch (e) {}
  window.addEventListener("message", function (event) {
    var guest = document.getElementById("hivra-visual-guest");
    if (!guest || !guest.contentWindow) return;
    if (event.source === guest.contentWindow) {
      if (!event.data || event.data.type !== "${VISUAL_HEIGHT_MESSAGE}") return;
      try { window.parent.postMessage({ type: "${VISUAL_HEIGHT_MESSAGE}", height: Number(event.data.height) }, "*"); } catch (e) {}
      return;
    }
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.type !== "${VISUAL_THEME_MESSAGE}" || typeof message.css !== "string") return;
    if (message.css.length > 2000 || /[<>]/.test(message.css)) return;
    try { guest.contentWindow.postMessage(message, "*"); } catch (e) {}
  });
})();`;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function guestDocument(body: string, theme: VisualTheme, network: boolean): string {
  const csp = visualCsp(network);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="color-scheme" content="${theme.scheme}"><style id="hivra-theme">${themeBlock(theme)}</style><script>${HELPER}</script></head><body>${body}</body></html>`;
}

/**
 * The framed document, or null when `source` is not text or is over the size cap.
 * The reply sits in an inner frame. The outer frame's policy blocks navigation.
 * The reply is placed after its own policy, so it cannot close those tags.
 * A null byte is removed so it cannot cut the page short. Quotes in the reply
 * are escaped so they cannot close the inner frame's attribute.
 */
export function visualDocument(
  source: string,
  theme: Partial<VisualTheme> | null | undefined,
  network: boolean,
): string | null {
  if (typeof source !== "string") return null;
  if (visualTooBig(source)) return null;
  const safe = safeTheme(theme);
  // Link tags are dropped: a preconnect, prefetch or dns-prefetch would reach a host before any policy is asked.
  const body = source.replace(/\u0000/g, "").replace(/<link\b[^>]*>/gi, "");
  const guest = escapeAttr(guestDocument(body, safe, network === true));
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${visualCsp(network === true)}"><style>html,body{margin:0;height:100%;background:${safe.background}}iframe{display:block;border:0;width:100%;height:100%;background:${safe.background}}</style><script>${SHELL}</script></head><body><iframe id="hivra-visual-guest" title="Visual reply" sandbox="${VISUAL_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${guest}"></iframe></body></html>`;
  return visualBytes(shell) > VISUAL_FRAME_MAX_BYTES ? null : shell;
}

/** A height the host will apply. Anything that is not that message is ignored. */
export function visualHeightFromMessage(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { type?: unknown; height?: unknown };
  if (record.type !== VISUAL_HEIGHT_MESSAGE) return null;
  const height = record.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return Math.min(
    VISUAL_FRAME_MAX_HEIGHT,
    Math.max(VISUAL_FRAME_MIN_HEIGHT, Math.ceil(height)),
  );
}
