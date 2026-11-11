import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

it("home no longer says all quiet", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const hits = files(root).filter((path) => readFileSync(path, "utf8").includes("All quiet."));
  expect(hits).toEqual([]);
});
