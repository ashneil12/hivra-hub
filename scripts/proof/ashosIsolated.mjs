// Proof only: start scripts/proof/ashos-isolated.py (the real Ash OS hub backend on a throwaway ledger) and talk to it.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function startIsolatedAshOs({ port, dev = false, studio } = {}) {
  const args = [path.join(here, "ashos-isolated.py"), "--port", String(port)];
  if (dev) args.push("--dev");
  if (studio) args.push("--studio", studio);
  const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const ready = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Ash OS proof service did not start:\n${out}`)), 30_000);
    const on = (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.startsWith('{"ready"'));
      if (line) { clearTimeout(t); resolve(JSON.parse(line)); }
    };
    child.stdout.on("data", on);
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => reject(new Error(`exited ${code}:\n${out}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const token = await (async () => {
    if (!dev) return null;
    return (await (await fetch(`${base}/__stub/token`)).json()).token;
  })();
  return {
    base, token, ready,
    state: async () => (await fetch(`${base}/__proof/state`)).json(),
    stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGINT"); }),
  };
}
