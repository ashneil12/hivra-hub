// Hivra runs with no outside service (WP-04): nothing in the hub's front end names Ash OS's address, holds a key or
// calls a service directly. The hub's data goes through the app's own plugin commands, and the one-time import is read
// in Rust (src-tauri/src/ash_os_import.rs).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("the hub's front end reaches no outside service", () => {
  const hub = files(join(__dirname, ".."));
  it("has no token path, no service address and no direct fetch", () => {
    expect(hub.length).toBeGreaterThan(10);
    for (const path of hub) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/exo-cc-studio/);
      expect(source, path).not.toMatch(/18767/);
      expect(source, path).not.toMatch(/Bearer/);
      expect(source, path).not.toMatch(/(?<![.\w])fetch\(/);
    }
  });

  it("keeps its data through the local store's own commands", () => {
    const transport = readFileSync(join(__dirname, "localHub", "localTransport.ts"), "utf8");
    expect([...new Set([...transport.matchAll(/plugin:hub\|(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["local_hub_read", "local_hub_write"]);
  });
});
