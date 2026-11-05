// WP-85. Claude Code entry. Any failure exits 0, so a terminal session works when Hivra is not there.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { kindFromEnv, resolveDataDir } from "../src/config.ts";
import { onHook, toWire } from "../src/hook.ts";
import { RUNNING_FILE, isDevConfigDir, targetFile } from "../src/paths.ts";
import { permissionHookOutput } from "../src/steer.ts";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function ancestors(pid: number): number[] {
  const found: number[] = [];
  let current = pid;
  for (let i = 0; i < 20; i += 1) {
    let text = "";
    try {
      text = execFileSync("ps", ["-o", "ppid=", "-p", String(current)], {
        encoding: "utf8",
        timeout: 500,
        env: { PATH: process.env.PATH ?? "" },
      }).trim();
    } catch {
      break;
    }
    const next = Number(text);
    if (!Number.isInteger(next) || next <= 1 || found.includes(next)) break;
    found.push(next);
    current = next;
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function send(port: number, frames: unknown[]): Promise<{ ok: boolean; steers: unknown[] }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, steers: [] });
    }, 800);
    let buf = "";
    const finish = (result: { ok: boolean; steers: unknown[] }) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.on("error", () => finish({ ok: false, steers: [] }));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { ok?: unknown; steers?: unknown };
        finish({ ok: msg.ok === true, steers: Array.isArray(msg.steers) ? msg.steers : [] });
      } catch {
        finish({ ok: false, steers: [] });
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "events", events: frames })}\n`);
    });
  });
}

function permissionAnswer(steers: unknown[]): { allow: boolean } | null {
  for (const steer of steers) {
    if (!steer || typeof steer !== "object") continue;
    const row = steer as { kind?: unknown; allow?: unknown };
    if (row.kind === "permission" && typeof row.allow === "boolean") return { allow: row.allow };
  }
  return null;
}

async function main(): Promise<number> {
  const env = process.env;
  const home = env.HOME || env.USERPROFILE || "";
  const platform = process.platform;
  const kind = kindFromEnv(env, home, platform);
  let target: unknown = null;
  if (kind === "dev" && env.CLAUDE_CONFIG_DIR && isDevConfigDir(home, env.CLAUDE_CONFIG_DIR, platform)) {
    try {
      target = JSON.parse(readFileSync(targetFile(env.CLAUDE_CONFIG_DIR, platform), "utf8")) as unknown;
    } catch {
      target = null;
    }
  }
  const data = resolveDataDir({ home, platform, kind, configDir: env.CLAUDE_CONFIG_DIR, target });
  let running: unknown = null;
  if (data.ok) {
    try {
      running = JSON.parse(readFileSync(path.join(data.dir, RUNNING_FILE), "utf8")) as unknown;
    } catch {
      running = null;
    }
  }
  let event: unknown = {};
  const raw = readStdin().trim();
  if (raw) {
    try {
      event = JSON.parse(raw) as unknown;
    } catch {
      event = {};
    }
  }
  const pid =
    running && typeof running === "object" && !Array.isArray(running) && typeof (running as { pid?: unknown }).pid === "number"
      ? (running as { pid: number }).pid
      : 0;
  const result = onHook({
    env,
    ancestors: ancestors(process.ppid),
    running,
    alive: pid > 0 ? alive(pid) : false,
    event,
    readFile: (file) => readFileSync(file, "utf8"),
    send: () => ({ ok: true, steers: [] }),
  });
  if (result.silent) return 0;
  const port =
    running && typeof running === "object" && !Array.isArray(running)
      ? (running as { mirrorPort?: unknown }).mirrorPort
      : null;
  if (typeof port !== "number") return 0;
  const live = await send(port, result.frames.flatMap(toWire));
  if (!live.ok) return 0;
  const name =
    event && typeof event === "object"
      ? String((event as { hook_event_name?: unknown }).hook_event_name ?? "")
      : "";
  if (name.toLowerCase().includes("permission")) {
    const output = permissionHookOutput(permissionAnswer(live.steers));
    if (output) process.stdout.write(output);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
