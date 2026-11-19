// The loopback relay that holds the OpenRouter key for a sandboxed bench (scripts/hub-realtest.mjs, docs/REALTEST.md).
//
// A bench agent runs under a macOS seatbelt profile that closes the real home (so there is no Keychain) and denies
// every outbound connection except the loopback ports the run names (scripts/bench-sandbox.mjs). Ash's launcher
// ~/.local/bin/claude-openrouter dials https://openrouter.ai directly and reads its key from the Keychain, so inside
// that fence it cannot work at all. The run therefore starts this relay OUTSIDE the sandbox: the relay holds the key
// and the launcher is handed only the relay's loopback URL and a one-run token (CLAUDE_OPENROUTER_RELAY_URL,
// CLAUDE_OPENROUTER_RELAY_TOKEN), which is the launcher's own documented path. The profile then opens exactly that one
// port: the gateway ports the other bridges need stay shut for an OpenRouter run.
//
// The key lives in one closure variable and nowhere else: never in process.env, a child's environment, a file, a log
// line, an error message, a response or a thrown value. Every path that could echo it replaces it with "[key]" first.
//
// Only two calls are forwarded: POST /v1/messages and POST /v1/messages/count_tokens. Every JSON object is sent with
// the pinned model, and a `models` field is dropped, so the caller cannot choose a different one.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

/** What the wrapper script hands the launcher instead of the Keychain: the relay's loopback address, and this run's token. */
export const RELAY_URL_ENV = "CLAUDE_OPENROUTER_RELAY_URL";
export const RELAY_TOKEN_ENV = "CLAUDE_OPENROUTER_RELAY_TOKEN";
/** The two names a launcher run must not strip from a child: they are the run's route, not one of the caller's credentials. */
export const RELAY_ENV = [RELAY_URL_ENV, RELAY_TOKEN_ENV];

/** OpenRouter's Anthropic-compatible base, the same one ~/.local/bin/claude-openrouter dials. */
export const OPENROUTER_UPSTREAM = "https://openrouter.ai/api";
/** The one model the relay asks for, the same default the launcher holds every call to. */
export const OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash";
/** The Keychain item Ash keeps the OpenRouter key in. */
export const OPENROUTER_KEYCHAIN = "hivra-openrouter";

/** The whole refusal when the key isn't there: plain words, the item's name, and how to add it. */
export const RELAY_NO_KEY =
  '--agents openrouter-sub needs the Keychain item "hivra-openrouter" (add it with: security add-generic-password -U -a "$USER" -s hivra-openrouter -w)';

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Headers a caller signs in with. Every one is dropped; the relay's own Authorization replaces them. */
const INBOUND_AUTH = ["authorization", "x-api-key", "api-key"];

/**
 * The Keychain read the launcher makes, exactly as `~/.local/bin/claude-openrouter` makes it: the account is the real
 * user, the service is the item's name, and the keychain is the REAL login keychain (a bench's throwaway HOME never
 * sees this one). Returns "" when the item isn't there. The value is never printed.
 */
export function keychainOpenRouterKey({ home = os.homedir(), user = os.userInfo().username, exec = execFileSync } = {}) {
  try {
    const out = exec(
      "/usr/bin/security",
      ["find-generic-password", "-a", String(user), "-s", OPENROUTER_KEYCHAIN, "-w", path.join(String(home), "Library/Keychains/login.keychain-db")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
    );
    return String(out ?? "").trim();
  } catch {
    return "";
  }
}

/** The token this request presented, or null: `Authorization: Bearer <token>` or `x-api-key: <token>`. */
function presentedToken(req) {
  const auth = String(req.headers?.authorization ?? "").trim();
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  if (bearer) return bearer[1];
  if (auth && !auth.includes(" ")) return auth;
  const x = req.headers?.["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

/** A constant-time compare, so a wrong token can't be guessed one byte at a time. */
function sameToken(given, expected) {
  if (typeof given !== "string" || !given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The two paths a run may ask the relay to forward. Matched after the request line is resolved, so `..` cannot widen it. */
const RELAY_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const RELAY_POST_ONLY = "this relay only forwards POST";
const RELAY_PATHS_ONLY = "this relay only forwards /v1/messages and /v1/messages/count_tokens";

/**
 * A JSON object goes out with the pinned model, and its `models` field removed. That field is how a caller would
 * still choose a model once `model` is pinned. Anything that isn't a JSON object is passed through.
 */
export function rewriteRelayBody(body, model) {
  let json;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return body;
  json.model = model;
  delete json.models;
  return Buffer.from(JSON.stringify(json), "utf8");
}

/**
 * The path this call may take, or a refusal. The request line is untrusted: an absolute URL, a foreign host and `..`
 * are resolved first, and only POST /v1/messages and POST /v1/messages/count_tokens pass.
 */
function allowedRelayTarget(req) {
  if (String(req.method ?? "") !== "POST") return { status: 405, text: RELAY_POST_ONLY };
  let parsed;
  try {
    parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return { status: 403, text: RELAY_PATHS_ONLY };
  }
  const foreign = parsed.hostname !== "127.0.0.1" || parsed.username !== "" || parsed.password !== "";
  if (foreign || !RELAY_PATHS.has(parsed.pathname)) return { status: 403, text: RELAY_PATHS_ONLY };
  return { path: parsed.pathname, search: parsed.search };
}

/**
 * The relay: 127.0.0.1 only, an OS-chosen port, one fixed model, the key in a closure variable, and this run's token.
 *
 * `readKey` is injected (its default is the Keychain read above) and called once, at start. `upstream` is the
 * Anthropic-compatible base the two allowed paths are appended to, `model` is what every JSON body's `model` becomes,
 * and `token` is minted when none is passed.
 *
 * Returns `{ host, port, url, token, server, close() }`. `server` is the Node server, so a caller can prove the address
 * it bound. `close()` stops listening and ends open sockets; the port is free after it resolves.
 */
export async function startOpenRouterRelay({ readKey = keychainOpenRouterKey, upstream = OPENROUTER_UPSTREAM, model = OPENROUTER_MODEL, token } = {}) {
  const runToken = token ? String(token) : crypto.randomBytes(24).toString("hex");
  // Read once, at start. A throwing reader is an empty key: its message is never surfaced, so it can't leak one either.
  let key = "";
  try {
    key = String((await readKey()) ?? "").trim();
  } catch {
    key = "";
  }
  if (!key) throw new Error(RELAY_NO_KEY);
  // One place that touches the key on the way out, so no error text can carry it.
  const scrub = (text) => String(text ?? "").split(key).join("[key]");
  const base = String(upstream ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("the relay needs OpenRouter's address");
  let transport;
  try {
    transport = new URL(base).protocol === "http:" ? http : https;
  } catch {
    throw new Error("the relay needs OpenRouter's address");
  }

  const sockets = new Set();
  const answer = (res, status, text, extra = {}) => {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...(status === 401 ? { "www-authenticate": "Bearer" } : {}), ...extra });
    res.end(`${text}\n`);
  };

  /** Forward an allowed call to OpenRouter, replacing its sign-in with the relay's own. The path is the resolved one. */
  const forward = (req, res, body, target) => {
    let url;
    try {
      url = new URL(base);
      // Append the allowed path under the base's own path. Concatenating the raw request line would let `..` climb out
      // of it (the real base ends in `/api`).
      const prefix = url.pathname.replace(/\/+$/, "");
      url.pathname = `${prefix}${target.path}`;
      url.search = target.search;
      url.hash = "";
    } catch {
      answer(res, 502, "the relay could not read the address this call asked for");
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || INBOUND_AUTH.includes(lower) || lower === "host" || lower === "content-length") continue;
      headers[lower] = value;
    }
    headers.authorization = `Bearer ${key}`;
    const payload = rewriteRelayBody(body, model);
    headers["content-length"] = String(payload.length);

    const sent = transport.request(url, { method: req.method ?? "POST", headers }, (upstreamRes) => {
      const out = {};
      for (const [name, value] of Object.entries(upstreamRes.headers ?? {})) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        // The key never goes back to a caller: an upstream that echoes what it was sent has its own answer scrubbed.
        // The BODY is streamed through byte for byte instead (an SSE answer must not be buffered), which is the one
        // place the relay hands back bytes it cannot inspect.
        out[name] = Array.isArray(value) ? value.map((item) => scrub(item)) : typeof value === "string" ? scrub(value) : value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      // Headers go out now: a streamed answer can be silent for seconds before its first token.
      res.flushHeaders?.();
      // An answer that breaks halfway is committed to the caller: end the answer rather than leave it hanging. `pipe`
      // does not carry the source's error to the destination.
      upstreamRes.on("error", () => res.destroy());
      // Chunk by chunk, never buffered: an SSE answer must reach the caller as it is written.
      upstreamRes.pipe(res);
    });
    sent.on("error", () => {
      // A network error, never an upstream status: answer in plain words rather than crash the run. Once an answer has
      // started there is no place left to say it, so that caller's answer just ends.
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      answer(res, 502, "the relay could not reach OpenRouter (the network may be down); nothing was sent");
    });
    res.on("error", () => {
      try {
        sent.destroy();
      } catch {
        // the answer stopped; the request is closed with it
      }
    });
    sent.end(payload);
  };

  const handle = (req, res) => {
    if (!sameToken(presentedToken(req), runToken)) {
      // Read the body off the socket so the caller isn't left writing into a half-closed connection, then refuse.
      req.resume();
      answer(res, 401, "this relay answers only the run that started it: the token is missing or wrong");
      return;
    }
    const target = allowedRelayTarget(req);
    if (target.status) {
      req.resume();
      answer(res, target.status, target.text, target.status === 405 ? { allow: "POST" } : {});
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", () => {
      // a caller that went away: the answer is closed, there is nothing to forward
    });
    req.on("end", () => forward(req, res, Buffer.concat(chunks), target));
  };

  const server = http.createServer(handle);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // Long, quiet model calls are normal here: no socket or request timeout may cut a stream in half.
  server.setTimeout(0);
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(scrub(error?.message))));
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const close = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      server.once("close", finish);
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      }
      sockets.clear();
      try {
        server.close(finish);
        server.closeAllConnections?.();
      } catch {
        finish();
      }
      // A backstop: a socket the kernel still holds must not keep a bench hanging at its end.
      setTimeout(finish, 2000).unref?.();
    });

  return { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, token: runToken, server, close };
}
