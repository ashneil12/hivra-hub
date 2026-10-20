import http from "node:http";

import { checkBump, checkName, checkOwner } from "../../shared/src/validate.ts";
import { stats } from "./stats.ts";
import type { Store } from "./store.ts";

type Reply = { status: number; body: unknown };

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function route(store: Store, method: string, url: string, body: unknown): Promise<Reply> {
  const parts = url.split("?")[0].split("/").filter(Boolean);
  if (parts[0] !== "tallies") return { status: 404, body: { error: "not found" } };

  if (parts.length === 1 && method === "GET") return { status: 200, body: store.list() };
  if (parts.length === 1 && method === "POST") {
    const input = (body ?? {}) as Record<string, unknown>;
    const name = checkName(input.name);
    if (!name.ok) return { status: 400, body: { error: name.error } };
    const owner = checkOwner(input.owner);
    if (!owner.ok) return { status: 400, body: { error: owner.error } };
    return { status: 201, body: store.create(name.value, owner.value) };
  }

  const tally = parts[1] ? store.get(parts[1]) : undefined;
  if (!tally) return { status: 404, body: { error: "no such tally" } };
  if (parts[2] === "bump" && method === "POST") {
    const by = checkBump(((body ?? {}) as Record<string, unknown>).by);
    if (!by.ok) return { status: 400, body: { error: by.error } };
    return { status: 200, body: store.bump(tally.id, by.value) };
  }
  if (parts[2] === "stats" && method === "GET") return { status: 200, body: stats(tally.entries) };
  return { status: 405, body: { error: "method not allowed" } };
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const reply =
      body === null
        ? { status: 400, body: { error: "body must be JSON" } }
        : await route(store, req.method ?? "GET", req.url ?? "/", body);
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
}
