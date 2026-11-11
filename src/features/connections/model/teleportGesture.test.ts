import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// LOW 7: a move starts only from a person's click. The approval is the only door into moveChat, and the only code that
// may call moveChat or approvePlan lives in the connections feature (its model and its UI). App commands, agent
// commands, the host and the other features never reach a move.

const ROOT = path.resolve(__dirname, "../../../..");
const ALLOWED_PREFIX = path.join(ROOT, "src", "features", "connections");

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("WP-177 a move starts only from a person's click (LOW 7)", () => {
  it("moveChat and approvePlan are called only inside the connections feature", () => {
    const files = [...walk(path.join(ROOT, "src"), []), ...walk(path.join(ROOT, "host"), [])];
    const offenders = files
      .filter((file) => !file.startsWith(ALLOWED_PREFIX))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return /\bmoveChat\(|\bapprovePlan\(/.test(text);
      });
    expect(offenders).toEqual([]);
  });

  it("approvePlan refuses anything that is not a trusted click (an app or agent event is not one)", async () => {
    const { approvePlan } = await import("./teleport");
    const plan = { planId: "p", chatId: "c", from: "a", to: "b" } as never;
    expect(() => approvePlan(plan, { isTrusted: false, type: "click" })).toThrow();
    expect(() => approvePlan(plan, { isTrusted: true, type: "submit" })).toThrow();
  });
});
