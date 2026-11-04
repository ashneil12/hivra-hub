// Hivra WP-11's "Don't": the classifier runs without a window (WP-60 runs it on a remote host) and never calls a model,
// starts a CLI or spends a token. This walks every module the classifier loads, from its source, and checks it.
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["classifier.ts", "stall.ts", "hourly.ts"].map((file) => resolve(__dirname, file));

/** Value imports only: `import type` is erased and loads nothing. */
function imports(source: string): string[] {
  const found: string[] = [];
  const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  return null;
}

function graph(): Map<string, string> {
  const seen = new Map<string, string>();
  const todo = [...ROOTS];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    for (const spec of imports(source)) {
      if (!spec.startsWith(".")) {
        seen.set(`package:${spec}`, "");
        continue;
      }
      const next = resolveLocal(file, spec);
      if (next) todo.push(next);
    }
  }
  return seen;
}

describe("the classifier is headless and spends nothing", () => {
  const modules = graph();
  const packages = [...modules.keys()].filter((key) => key.startsWith("package:")).map((key) => key.slice(8));
  const files = [...modules.entries()].filter(([key]) => !key.startsWith("package:"));

  it("loads no React, DOM, Tauri, process or network package", () => {
    expect(files.map(([file]) => basename(file))).toEqual(expect.arrayContaining(["classifier.ts", "stall.ts", "hourly.ts"]));
    for (const name of packages) expect(name).not.toMatch(/^(react|react-dom|@tauri-apps\/|node:child_process|child_process|node:net|undici|@anthropic-ai\/)/);
  });

  it("no module it loads touches a window, a CLI, a model or the network", () => {
    const banned = /\b(window|document|localStorage|navigator)\.|\binvoke\(|\bfetch\(|\bspawn\(|\bexec\(|new Worker\(|XMLHttpRequest|WebSocket/;
    for (const [file, source] of files) {
      const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(banned.test(code), `${file} must stay headless`).toBe(false);
    }
  });

  it("no module it loads reaches the harness or a provider", () => {
    for (const [file] of files) expect(file.replaceAll("\\", "/")).not.toMatch(/integrations\/harness|src-tauri|\/hooks\/|\/ui\//);
  });
});
