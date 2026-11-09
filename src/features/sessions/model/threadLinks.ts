// WP-125: local chat and prompt links. The shape is hivra://local/... because the
// app does not register another scheme. Nothing here builds a public or guest URL.

/** Shown when a link cannot be used. Plain sentences, no viewer address. */
export const THREAD_LINK_MESSAGE = {
  empty: "This link is empty.",
  offMachine: "This link is not for this computer.",
  public: "This app does not open public links.",
  unknown: "This link is not a chat or a prompt.",
  tooLong: "This prompt is too long to open here.",
  missingChat: "This chat is not on this computer.",
  missingProject: "This project is not on this computer.",
  noFolder: "This project has no folder to open a chat in.",
  unavailable: "This link could not be checked yet. Try it again.",
  notInProject: "This chat is not in a saved project.",
  copyFailed: "Could not copy the link.",
} as const;

const SCHEME = "hivra:";
const HOST = "local";
const MAX_ID = 128;
const MAX_PROMPT = 8_000;

const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u;

/** Path words that would be a public or signed share, never a local chat. */
const PUBLIC_PATHS = new Set(["guest", "share", "public", "signed", "sign"]);

/** Query keys that would turn a local link into a public or signed one. */
const PUBLIC_KEYS = new Set([
  "guest",
  "token",
  "sig",
  "signature",
  "share",
  "public",
  "signed",
  "sign",
  "url",
  "host",
  "redirect",
  "callback",
]);

export type ChatLink = { kind: "chat"; sessionId: string };
export type PromptLink = { kind: "prompt"; projectId: string; text: string };
export type LocalThreadLink = ChatLink | PromptLink;

export type ThreadLinkRejection =
  | "empty"
  | "off-machine"
  | "public"
  | "unknown"
  | "too-long";

export type ParsedThreadLink =
  | { ok: true; link: LocalThreadLink }
  | { ok: false; reason: ThreadLinkRejection; message: string };

function reject(reason: ThreadLinkRejection): ParsedThreadLink {
  const message =
    reason === "empty"
      ? THREAD_LINK_MESSAGE.empty
      : reason === "off-machine"
        ? THREAD_LINK_MESSAGE.offMachine
        : reason === "public"
          ? THREAD_LINK_MESSAGE.public
          : reason === "too-long"
            ? THREAD_LINK_MESSAGE.tooLong
            : THREAD_LINK_MESSAGE.unknown;
  return { ok: false, reason, message };
}

/** One local id: a session id or a project id. Not a path, not ".." . */
export function isLocalThreadId(id: string): boolean {
  if (id === "." || id === "..") return false;
  if (id.length > MAX_ID) return false;
  return ID_PATTERN.test(id);
}

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/** Prompt text may be long and include line breaks. It may not carry hidden controls. */
export function isLocalPromptText(text: string): boolean {
  if (text.length > MAX_PROMPT) return false;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === 10 || code === 13 || code === 9) continue;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export function chatLink(sessionId: string): string | null {
  if (!isLocalThreadId(sessionId)) return null;
  return `hivra://local/chat/${encodeURIComponent(sessionId)}`;
}

export function promptLink(projectId: string, text: string): string | null {
  if (!isLocalThreadId(projectId) || !isLocalPromptText(text)) return null;
  return `hivra://local/prompt/${encodeURIComponent(projectId)}?text=${encodeURIComponent(text)}`;
}

type QueryPair = { key: string; value: string };

function queryPairs(search: string): QueryPair[] | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return [];
  const pairs: QueryPair[] = [];
  for (const part of raw.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeOnce(eq === -1 ? part : part.slice(0, eq));
    const value = decodeOnce(eq === -1 ? "" : part.slice(eq + 1));
    if (key == null || value == null) return null;
    pairs.push({ key, value });
  }
  return pairs;
}

/**
 * Read a copied link. Unknown shapes and anything that is not this computer
 * come back as a rejection. There is no web address to fall back to.
 */
export function parseThreadLink(raw: string): ParsedThreadLink {
  if (typeof raw !== "string") return reject("unknown");
  if (/[\u0000-\u001f\u007f]/.test(raw)) return reject("unknown");
  const trimmed = raw.trim();
  if (!trimmed) return reject("empty");
  if (/\s/.test(trimmed)) return reject("unknown");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject("unknown");
  }

  if (url.protocol !== SCHEME) return reject("off-machine");
  if (url.username || url.password || url.port) return reject("off-machine");
  // A custom scheme does not force the host to lower case the way https does.
  if (url.hostname.toLowerCase() !== HOST) return reject("off-machine");
  if (url.hash) return reject("unknown");

  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  if (segments.length === 0) return reject("unknown");
  const head = decodeOnce(segments[0]);
  if (head == null) return reject("unknown");
  if (PUBLIC_PATHS.has(head.toLowerCase())) return reject("public");

  const pairs = queryPairs(url.search);
  if (!pairs) return reject("unknown");
  if (pairs.some((pair) => PUBLIC_KEYS.has(pair.key.toLowerCase()))) return reject("public");

  if (head !== "chat" && head !== "prompt") return reject("unknown");
  if (segments.length !== 2) return reject("unknown");
  const id = decodeOnce(segments[1]);
  if (id == null || !isLocalThreadId(id)) return reject("unknown");

  if (head === "chat") {
    if (pairs.length > 0) return reject("unknown");
    return { ok: true, link: { kind: "chat", sessionId: id } };
  }

  const textPairs = pairs.filter((pair) => pair.key === "text");
  if (textPairs.length !== 1 || pairs.length !== 1) return reject("unknown");
  const text = textPairs[0].value;
  if (text.length > MAX_PROMPT) return reject("too-long");
  if (!isLocalPromptText(text)) return reject("unknown");
  return { ok: true, link: { kind: "prompt", projectId: id, text } };
}
