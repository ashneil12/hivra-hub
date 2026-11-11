// WP-210: a new module must not import a counter this package removed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const REMOVED = ["attentionCount", "useAttentionVersion", "useInboxUnseen"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name === "target") continue;
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...files(path));
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(path);
  }
  return out;
}

function namedImports(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'][^"']+["']/g)) {
    for (const part of match[1].split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      const name = piece.split(/\s+as\s+/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

it("fails when source imports a removed needs count", () => {
  const hits: string[] = [];
  for (const root of ["src", "tests/browser"]) {
    for (const path of files(root)) {
      const source = readFileSync(path, "utf8");
      for (const name of namedImports(source)) {
        if (REMOVED.includes(name)) hits.push(`${path} imports ${name}`);
      }
      const namespace = /import\s+\*\s+as\s+(\w+)\s+from\s+["'][^"']*todayCounts["']/.exec(source);
      if (namespace) {
        for (const name of REMOVED) {
          if (source.includes(`${namespace[1]}.${name}`)) hits.push(`${path} uses ${namespace[1]}.${name}`);
        }
      }
      if (path.endsWith(`${join("hub", "model", "todayCounts.ts")}`)) {
        for (const name of REMOVED) {
          if (new RegExp(`export function ${name}\\b`).test(source)) hits.push(`${path} still exports ${name}`);
        }
      }
    }
  }
  expect(hits).toEqual([]);
});
