// `npm run hub:dev -- --engine <folder>`: the dev copy's chats run on Dropwave's new engine (the T3 Code fork checked
// out in <folder>) instead of the CLIs the app starts itself. This file starts that engine for the slot and stops it
// with the dev copy.
//
// - Port: the slot's vite port + 5. Slots are 10 apart, so no slot's vite or engine port is another's.
// - Data: ~/.monocode-hub-dev/engine/<slot>, kept between runs so a chat finds its conversation again. Never ~/.t3,
//   the folder a T3 Code Ash installed for himself uses; nothing is copied from it either (--no-seed).
// - Sign-in: a session token issued for that data folder, handed to the page through vite (hub-dev.mjs `slotConfig`).
// - The engine's server lets the dev copy's page in by its origin and sends no telemetry.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const ENGINE_PORT_OFFSET = 5;
const DEV_HOME = ".monocode-hub-dev";
/** A token goes into a shell command (the slot's beforeDevCommand): only what a token is made of may. */
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,4096}$/;

export function enginePort(slotPort) {
  return slotPort + ENGINE_PORT_OFFSET;
}

export function engineHome(slot, home = os.homedir()) {
  return path.join(home, DEV_HOME, "engine", slot);
}

export function engineOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

/** What the dev copy's page must be allowed to connect to (hub-dev.mjs `devCsp`). */
export function engineSources(port) {
  return [`http://127.0.0.1:${port}`, `ws://127.0.0.1:${port}`];
}

/** The engine's server alone (no web app of its own), on the slot's port and data folder. */
export function engineArgs({ port, home }) {
  return ["scripts/dev-runner.ts", "dev:server", "--no-seed", "--port", String(port), "--home-dir", home];
}

export function tokenArgs(home) {
  return ["apps/server/src/bin.ts", "auth", "session", "issue", "--token-only", "--base-dir", home];
}

/** The environment the engine runs with: its own tools first on PATH, nothing of an enclosing engine or vite. */
export function engineEnvironment({ dir, pageOrigin, env = process.env }) {
  const next = { ...env };
  for (const key of Object.keys(next)) if (key.startsWith("T3CODE_") || key.startsWith("VITE_")) delete next[key];
  next.PATH = [path.join(dir, "node_modules/.bin"), env.PATH].filter(Boolean).join(path.delimiter);
  next.T3CODE_TELEMETRY_ENABLED = "false";
  next.T3CODE_NO_BROWSER = "1";
  next.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = "0";
  next.T3CODE_DEV_ALLOWED_ORIGINS = pageOrigin;
  return next;
}

/** The major Node version the engine's own package.json asks for, or null when it does not say. */
export function wantedNodeMajor(dir) {
  try {
    const wanted = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).engines?.node;
    const major = /\d+/.exec(String(wanted ?? ""))?.[0];
    return major ? Number(major) : null;
  } catch {
    return null;
  }
}

/** Why this folder can't be started as the engine, or null when it can. */
export function engineProblem(dir, nodeVersion) {
  if (!fs.existsSync(path.join(dir, "scripts/dev-runner.ts")) || !fs.existsSync(path.join(dir, "apps/server/src/bin.ts")))
    return `${dir} is not a checkout of the engine (github.com/ashneil12/dropwave).`;
  if (!fs.existsSync(path.join(dir, "node_modules")))
    return `${dir} has no node_modules yet. Install it there first (vp i).`;
  const wanted = wantedNodeMajor(dir);
  const have = Number(/\d+/.exec(String(nodeVersion ?? ""))?.[0]);
  if (wanted && have !== wanted)
    return `The engine needs Node ${wanted} and this is ${nodeVersion || "unknown"}. Set DROPWAVE_ENGINE_NODE to a Node ${wanted} binary.`;
  return null;
}

const answers = (origin) =>
  new Promise((resolve) => {
    const request = http.get(origin, { timeout: 1000 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });

/**
 * Starts the engine for a slot and waits until it answers. Gives back where it is, the token for the page, and the
 * process, which the caller stops with the dev copy (by this pid's tree, never by name).
 */
export async function startEngine({ dir, slot, slotPort, home = os.homedir(), env = process.env, wait = 180_000, log = () => {} }) {
  const folder = path.resolve(dir);
  const node = env.DROPWAVE_ENGINE_NODE || "node";
  let nodeVersion = "";
  try {
    nodeVersion = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    nodeVersion = "";
  }
  const problem = engineProblem(folder, nodeVersion);
  if (problem) throw new Error(problem);

  const port = enginePort(slotPort);
  const origin = engineOrigin(port);
  if (await answers(origin)) throw new Error(`Something already answers on ${origin}. Is another copy of this slot's engine running?`);
  const data = engineHome(slot, home);
  fs.mkdirSync(data, { recursive: true });
  const logFile = path.join(data, "engine.log");
  const out = fs.openSync(logFile, "a");
  const engineEnv = engineEnvironment({ dir: folder, pageOrigin: `http://localhost:${slotPort}`, env });
  const child = spawn(node, engineArgs({ port, home: data }), { cwd: folder, env: engineEnv, stdio: ["ignore", out, out] });
  let exited = null;
  child.on("exit", (code, signal) => (exited = code ?? signal ?? 1));
  child.on("error", (error) => (exited = error.message));

  const deadline = Date.now() + wait;
  while (!(await answers(origin))) {
    if (exited !== null) throw new Error(`The engine stopped while starting (${exited}). See ${logFile}.`);
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`The engine did not answer on ${origin} within ${Math.round(wait / 1000)} s. See ${logFile}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log(`engine up on ${origin}`);

  const token = await new Promise((resolve, reject) =>
    execFile(node, tokenArgs(data), { cwd: folder, env: engineEnv, encoding: "utf8" }, (error, stdout) =>
      error ? reject(new Error(`The engine would not issue a token: ${error.message.split("\n")[0]}`)) : resolve(stdout.trim()),
    ),
  ).catch((error) => {
    child.kill("SIGTERM");
    throw error;
  });
  if (!TOKEN.test(token)) {
    child.kill("SIGTERM");
    throw new Error("The engine's token is not in a form this launcher can pass on.");
  }
  return { origin, port, token, data, logFile, child };
}
