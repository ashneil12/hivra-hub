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

it("the only all quiet line is the chief's empty line", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const hits = files(root).filter((path) => readFileSync(path, "utf8").includes("All quiet."));
  expect(hits.map((path) => path.slice(root.length))).toEqual(["ui/HomeScreen.tsx"]);
  const text = readFileSync(hits[0], "utf8");
  expect(text.split("All quiet.").length - 1).toBe(1);
  expect(text).toContain("All quiet. Ask me anything, or hand work to any project.");
});
