// The dev ash-os stand-in (devAshOs.ts) is a dev copy's only: the daily app never takes it, whatever the build saw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { devAshOsStandIn, parseAshOsEntry } from "./devAshOs";

const ENTRY = JSON.stringify({ command: "/usr/local/bin/node", args: ["/w/scripts/hub-stub-ash-os-mcp.mjs"], env: { HUB_STUB_URL: "http://127.0.0.1:1", HUB_STUB_TOKEN_FILE: "/t", BAD: 3 } });

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__MONOCODE_APP__;
});

const identity = (kind: "daily" | "dev") => ({
  product: "MonoCode Hub",
  version: "0.16.0",
  identifier: kind === "dev" ? "com.ash.monocode-hub.dev.hub-2-checker" : "com.ash.monocode-hub",
  kind,
  slot: kind === "dev" ? "hub-2-checker" : null,
  stamp: { sha: "abc", branch: "hub/2-checker", dirty: false, builtAt: "2026-10-20T00:00:00Z" },
  schemaVersion: 1,
  policy: {},
});

describe("the dev ash-os stand-in", () => {
  it("reads a command, its args and string env only", () => {
    expect(parseAshOsEntry(ENTRY)).toEqual({
      command: "/usr/local/bin/node",
      args: ["/w/scripts/hub-stub-ash-os-mcp.mjs"],
      env: { HUB_STUB_URL: "http://127.0.0.1:1", HUB_STUB_TOKEN_FILE: "/t" },
    });
    expect(parseAshOsEntry("")).toBeNull();
    expect(parseAshOsEntry("{nope")).toBeNull();
    expect(parseAshOsEntry(JSON.stringify({ args: [] }))).toBeNull();
  });

  it("is taken by a dev copy started with it, and never by the daily app", () => {
    vi.stubEnv("VITE_MONOCODE_DEV_ASH_OS", ENTRY);
    (globalThis as Record<string, unknown>).__MONOCODE_APP__ = identity("daily");
    expect(devAshOsStandIn()).toBeNull();
    (globalThis as Record<string, unknown>).__MONOCODE_APP__ = identity("dev");
    expect(devAshOsStandIn()?.command).toBe("/usr/local/bin/node");
    vi.stubEnv("VITE_MONOCODE_DEV_ASH_OS", "");
    expect(devAshOsStandIn()).toBeNull();
  });
});
