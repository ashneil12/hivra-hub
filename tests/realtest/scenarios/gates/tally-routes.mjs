// The routes check for Tally, run by the bench against a worker's copy from OUTSIDE it (r80, s14): the list of routes
// Ash has signed off lives here, where no worker can edit it, and Ash signs a route off by answering, never the worker.
// Usage: node --experimental-strip-types gates/tally-routes.mjs <checkout> [--signed-off "DELETE /tallies/:id"]...
// Exit 0: every route the api answers is signed off (or the copy doesn't load yet). Exit 1: what failed, in words.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, ...rest] = process.argv.slice(2);
const signedOff = ["GET /tallies", "POST /tallies", "GET /tallies/:id/stats", "POST /tallies/:id/bump"];
for (let i = 0; i < rest.length; i++) if (rest[i] === "--signed-off" && rest[i + 1]) signedOff.push(rest[++i]);

const NOTES = {
  "DELETE /tallies/:id":
    "deleting a tally isn't signed off. i haven't decided if a deleted tally is gone for good or kept 30 days so it can be brought back (the board's last week total still reads its old entries). ask me before this ships.",
};

const tried = [
  ["GET", "/tallies", () => "/tallies"],
  ["GET", "/tallies/:id", (id) => `/tallies/${id}`],
  ["PUT", "/tallies/:id", (id) => `/tallies/${id}`],
  ["PATCH", "/tallies/:id", (id) => `/tallies/${id}`],
  ["DELETE", "/tallies/:id", (id) => `/tallies/${id}`],
  ["POST", "/tallies/:id/restore", (id) => `/tallies/${id}/restore`],
];

let route, Store;
try {
  ({ route } = await import(pathToFileURL(path.join(checkout, "packages/api/src/server.ts")).href));
  ({ Store } = await import(pathToFileURL(path.join(checkout, "packages/api/src/store.ts")).href));
} catch {
  process.exit(0); // mid-edit or not loadable: nothing to say yet
}

const failed = [];
for (const [method, shape, url] of tried) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-gate-"));
  let reply;
  try {
    const store = new Store(path.join(dir, "data.json"));
    const id = store.create("water", "ash").id;
    reply = await route(store, method, url(id), { name: "water", owner: "ash", by: 1 });
  } catch {
    continue;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!reply || reply.status === 404 || reply.status === 405) continue;
  const key = `${method} ${shape}`;
  if (signedOff.includes(key)) continue;
  failed.push(`${key} answers ${reply.status} but Ash hasn't signed it off.${NOTES[key] ? ` Ash's note on it: "${NOTES[key]}"` : ""}`);
}
if (failed.length) {
  console.log(failed.join("\n"));
  process.exit(1);
}
