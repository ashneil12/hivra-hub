// A page reading a web source it was connected to (C4). The page posts `http.fetch` with an address; the bridge is the
// only way out (its document keeps `connect-src 'none'`), so the address is checked against the page's grants here and
// again in Rust, and the request itself is made native (page_http.rs): the same public-address checks a link preview
// gets, no redirect that leaves the grant that authorised the request, a size and time cap, and the source's token
// added by the app — a token never goes through the page or comes back to it.
//
// The page gets the status, the content type and the body as text; it can show the body or parse it as JSON itself.
// Untrusted content stays data: it arrives as a string, never as script the app runs.
import { invoke } from "@tauri-apps/api/core";
import { allowsUrl, grantedUrls } from "./pageGrants";

export type PageHttpReply = {
  status: number;
  /** The content type the source sent ("application/json"), or "". */
  type: string;
  /** The body as text. */
  body: string;
  /** The address finally read (a redirect inside the grant that authorised the first request only). */
  url: string;
};

/** What the page may ask for; everything else is left out (a page can't set the token or any header of its own). */
export type PageFetchArgs = { url: string; method?: string; body?: string; accept?: string; contentType?: string };

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const MAX_BODY = 100_000;

type Runner = (request: {
  pageId: string;
  url: string;
  /** This page's grants (origin plus path); Rust refuses an address outside them, and a redirect out of them. */
  grants: string[];
  method: string;
  body?: string;
  accept?: string;
  contentType?: string;
}) => Promise<PageHttpReply>;

const native: Runner = (request) => invoke<PageHttpReply>("page_http_fetch", request);
let runner: Runner = native;
/** Tests and proofs: make the request without the native side. */
export function setPageHttpRunner(next: Runner | undefined): void {
  runner = next ?? native;
}

/** The plain reason a page can show when it asked for an address it wasn't connected to. */
export function fetchRefusal(raw: string): string {
  const host = (() => {
    try {
      return new URL(raw).host;
    } catch {
      return "";
    }
  })();
  if (!host) return "That isn't a web address. It should start with https://";
  return `This hub isn't connected to ${host}, so it can't read it. Connect the source on the hub first (Hubs → the hub → Connected sources).`;
}

/**
 * One request for a page, through the native side. Throws in plain words: an address the page wasn't connected to, a
 * method or body that isn't a simple request, or what the source said (a network failure, a refused address).
 */
export async function pageFetch(pageId: string, args: Record<string, unknown>): Promise<PageHttpReply> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) throw new Error("A hub's web request needs an address.");
  if (!allowsUrl(pageId, url)) throw new Error(fetchRefusal(url));
  const method = (typeof args.method === "string" ? args.method : "GET").toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`A hub can't send a “${method}” request.`);
  const body = typeof args.body === "string" ? args.body : undefined;
  if (body !== undefined && body.length > MAX_BODY) throw new Error("That request's body is too long for a hub.");
  if (body !== undefined && (method === "GET" || method === "HEAD")) throw new Error(`A ${method} request can't have a body.`);
  const accept = typeof args.accept === "string" ? args.accept.slice(0, 200) : undefined;
  const contentType = typeof args.contentType === "string" ? args.contentType.slice(0, 200) : undefined;
  return runner({ pageId, url, grants: grantedUrls(pageId), method, body, accept, contentType });
}

// ---- the source's token ----------------------------------------------------------------------------------------------
// Kept in the Keychain by the app (hub_keychain.rs), named for the page and the source's origin. A page can't read it,
// write it or see whether it is there: it only ever asks for data, and the app adds the token on the way out.
type TokenStore = {
  set(pageId: string, origin: string, token: string): Promise<void>;
  has(pageId: string, origin: string): Promise<boolean>;
  clear(pageId: string, origin: string): Promise<boolean>;
};
const keychain: TokenStore = {
  set: (pageId, origin, token) => invoke<void>("page_source_token_set", { pageId, origin, token }),
  has: (pageId, origin) => invoke<boolean>("page_source_token_exists", { pageId, origin }),
  clear: (pageId, origin) => invoke<boolean>("page_source_token_clear", { pageId, origin }),
};
let tokens: TokenStore = keychain;
/** Tests and proofs: keep tokens in memory instead of the Keychain. */
export function setPageTokenStore(next: TokenStore | undefined): void {
  tokens = next ?? keychain;
}

export async function setSourceToken(pageId: string, origin: string, token: string): Promise<void> {
  const text = token.trim();
  if (!text) return;
  await tokens.set(pageId, origin, text);
}
export function hasSourceToken(pageId: string, origin: string): Promise<boolean> {
  return tokens.has(pageId, origin);
}
export function clearSourceToken(pageId: string, origin: string): Promise<boolean> {
  return tokens.clear(pageId, origin);
}

/** The bridge handler for one page (PageBridgeHost hands it the page's own address check first). */
export function pageHttpHandlers(pageId: string): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return { "http.fetch": (args) => pageFetch(pageId, args) };
}
