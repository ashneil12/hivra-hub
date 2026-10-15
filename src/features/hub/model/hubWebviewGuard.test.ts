// The key never reaches the webview: nothing in the hub's front end may read Ash OS's token file, name its address,
// or call it directly. The only door is the Rust plugin (src-tauri/src/hub.rs).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("the webview never holds Ash OS's key", () => {
  const hub = files(join(__dirname, ".."));
  it("has no token path, no service address and no direct fetch in the hub's front end", () => {
    expect(hub.length).toBeGreaterThan(10);
    for (const path of hub) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/exo-cc-studio/);
      expect(source, path).not.toMatch(/18767/);
      expect(source, path).not.toMatch(/Bearer/);
      expect(source, path).not.toMatch(/\bfetch\(/);
    }
  });

  it("reaches Ash OS only through the plugin's commands", () => {
    const transport = readFileSync(join(__dirname, "hubTransport.ts"), "utf8");
    expect([...new Set([...transport.matchAll(/`\$\{PLUGIN\}(\w+)`/g)].map((m) => m[1]))].sort()).toEqual(["hub_call", "hub_events_close", "hub_events_open"]);
  });
});
