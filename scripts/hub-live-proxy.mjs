// Dev only: lets a dev copy (npm run hub:dev -- --hub live) or the browser dev page (hub-dev.html?live=<this proxy>)
// read the REAL Ash OS without the key ever reaching either. In the daily app the Rust plugin does this itself; a dev
// copy is never allowed the live key or port 18767 (src-tauri/src/hub.rs), and a browser can't read a file, so this
// tiny local server stands in for both.
//
//   node scripts/hub-live-proxy.mjs [--port 18869] [--key-file <live key>] [--client-token-file <file>] [--allow-writes]
//
// - Binds 127.0.0.1 only and forwards only to 127.0.0.1:18767.
// - Reads the live key on every request (`--key-file`, default ~/.local/share/exo-cc-studio/token), adds it to the
//   forwarded request, and never prints it or sends it anywhere else. Not MONOCODE_HUB_TOKEN_FILE: inside a dev copy
//   that variable names the dev copy's own throwaway token for this proxy.
// - Two kinds of caller:
//   * with `--client-token-file` (hub:dev starts it this way, in-process, through `startLiveProxy`): it writes a fresh
//     random token there and answers only requests carrying it as a bearer token, with no Origin header. That is how
//     the dev copy's Rust plugin calls (MONOCODE_HUB_TOKEN_FILE points at the file);
//   * without it: the browser dev page's own origins (localhost / 127.0.0.1), as before.
// - Forwards `ash-hub-*` only. By default it is READ-ONLY: calls that would change Ash's real state (activity, seen,
//   job choices, projects, owners) get a plain 403, so looking at the real data can't move his "Since" time or touch a
//   job. `--allow-writes` lifts that; don't, unless you mean to act on real data.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_KEY_FILE = path.join(os.homedir(), ".local/share/exo-cc-studio/token");
export const READS = new Set(["projects", "needs", "since", "events", "mono-projects", "mono-acts", "jobs", "job-options", "question", "pages", "changes", "layout"]);
const ACTION = /^ash-hub-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Start the proxy. Returns {port, url, close()}.
 *
 * `clientTokenFile`: write a fresh token there (0600) and require it from every caller (a dev copy). Without it the
 * proxy answers the browser dev page's local origins instead.
 */
export async function startLiveProxy({
  port = 18869,
  servicePort = 18767,
  keyFile = LIVE_KEY_FILE,
  clientTokenFile,
  writes = false,
} = {}) {
  let clientToken = null;
  if (clientTokenFile) {
    if (path.resolve(clientTokenFile) === path.resolve(keyFile))
      throw new Error("the client token file can't be the live key file");
    clientToken = crypto.randomBytes(24).toString("hex");
    fs.mkdirSync(path.dirname(clientTokenFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(clientTokenFile, clientToken, { mode: 0o600 });
  }

  const cors = (req) => {
    const origin = req.headers.origin;
    return !clientToken && origin && LOCAL_ORIGIN.test(origin)
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" }
      : {};
  };
  const reply = (req, res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) });
    res.end(data);
  };
  const key = () => fs.readFileSync(keyFile, "utf8").trim();

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (clientToken) {
      // A dev copy's Rust plugin: no Origin, its own bearer token. Nothing else gets through.
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
      if (origin || !bearer || !sameSecret(bearer, clientToken)) return reply(req, res, 401, { ok: false, error: "Not this proxy's caller." });
    } else if (origin && !LOCAL_ORIGIN.test(origin)) {
      return reply(req, res, 403, { ok: false, error: "Origin refused" });
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      return res.end();
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const match = ACTION.exec(url.pathname.replace(/^\/api\//, ""));
    if (!url.pathname.startsWith("/api/") || !match) return reply(req, res, 403, { ok: false, error: "Only ash-hub calls go through." });
    const name = match[1];
    if (!writes && !READS.has(name)) return reply(req, res, 403, { ok: false, error: "The dev proxy is read-only." });

    let token;
    try {
      token = key();
    } catch {
      return reply(req, res, 502, { ok: false, error: "Ash OS isn't set up on this Mac." });
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const forward = http.request(
        { host: "127.0.0.1", port: servicePort, path: url.pathname + url.search, method: req.method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: req.headers.accept || "application/json" } },
        (up) => {
          res.writeHead(up.statusCode || 502, { "Content-Type": up.headers["content-type"] || "application/json", "Cache-Control": "no-store", ...cors(req) });
          up.pipe(res);
          res.on("close", () => up.destroy());
        },
      );
      forward.on("error", () => !res.headersSent && reply(req, res, 502, { ok: false, error: "Ash OS isn't running." }));
      res.on("close", () => forward.destroy());
      forward.end(Buffer.concat(chunks));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = server.address().port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const writes = process.argv.includes("--allow-writes");
  const servicePort = Number(arg("service-port", 18767));
  const proxy = await startLiveProxy({
    port: Number(arg("port", 18869)),
    servicePort,
    keyFile: arg("key-file", LIVE_KEY_FILE),
    clientTokenFile: arg("client-token-file"),
    writes,
  });
  console.log(`hub live proxy on ${proxy.url} -> 127.0.0.1:${servicePort} (${writes ? "writes allowed" : "read-only"})`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => proxy.close().then(() => process.exit(0)));
}
