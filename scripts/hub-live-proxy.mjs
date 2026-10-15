// Dev only: lets the browser dev page (hub-dev.html?live=<this proxy>) read the REAL Ash OS without the key ever
// reaching the page. In the app the Rust plugin does this; a browser can't read a file, so this tiny local server
// stands in for it.
//
//   node scripts/hub-live-proxy.mjs [--port 18869] [--allow-writes]
//
// - Binds 127.0.0.1 only; answers only the dev page's own origins (localhost / 127.0.0.1).
// - Reads the key file on every request, adds it to the forwarded request, and never prints it or sends it anywhere
//   but 127.0.0.1:18767. The page never sees it.
// - Forwards `ash-hub-*` only. By default it is READ-ONLY: calls that would change Ash's real state (activity, seen,
//   job choices, projects, owners) get a plain 403, so looking at the real data can't move his "Since" time or touch a
//   job. `--allow-writes` lifts that; don't, unless you mean to act on real data.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", 18869));
const SERVICE_PORT = Number(arg("service-port", 18767));
const TOKEN_FILE = process.env.MONOCODE_HUB_TOKEN_FILE || path.join(os.homedir(), ".local/share/exo-cc-studio/token");
const WRITES = process.argv.includes("--allow-writes");

const READS = new Set(["projects", "needs", "since", "events", "mono-projects", "mono-acts", "jobs", "job-options", "question"]);
const ACTION = /^ash-hub-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

function cors(req) {
  const origin = req.headers.origin;
  return origin && LOCAL_ORIGIN.test(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" }
    : {};
}
const reply = (req, res, code, body) => {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) });
  res.end(data);
};
const key = () => fs.readFileSync(TOKEN_FILE, "utf8").trim();

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) return reply(req, res, 403, { ok: false, error: "Origin refused" });
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(req));
    return res.end();
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const match = ACTION.exec(url.pathname.replace(/^\/api\//, ""));
  if (!url.pathname.startsWith("/api/") || !match) return reply(req, res, 403, { ok: false, error: "Only ash-hub calls go through." });
  const name = match[1];
  if (!WRITES && !READS.has(name)) return reply(req, res, 403, { ok: false, error: "The dev proxy is read-only." });

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
      { host: "127.0.0.1", port: SERVICE_PORT, path: url.pathname + url.search, method: req.method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: req.headers.accept || "application/json" } },
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
server.listen(PORT, "127.0.0.1", () => console.log(`hub live proxy on http://127.0.0.1:${PORT} -> 127.0.0.1:${SERVICE_PORT} (${WRITES ? "writes allowed" : "read-only"})`));
