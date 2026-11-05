// A bench refuses a worker routed off its own Claude wrapper, in the same words as verify_live.rs's
// provider_start_allowed. Outside a bench nothing changes.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { benchCliRefusal } from "./benchCli";

const TEMPLATE = "This bench only starts the run's own Claude wrapper. It won't start {}.";

const global = globalThis as Record<string, unknown>;

function identity(kind: "daily" | "dev", verify?: { runId: string }) {
  return {
    product: "MonoCode Hub",
    version: "0.16.0",
    identifier: kind === "dev" ? "com.ash.monocode-hub.dev.verify" : "com.ash.monocode-hub",
    kind,
    slot: kind === "dev" ? "verify" : null,
    stamp: { sha: "09141d88a1b2c3d4e5f60718293a4b5c6d7e8f90", branch: "bench", dirty: false, builtAt: "" },
    schemaVersion: 19,
    policy: {},
    ...(verify ? { verify } : {}),
  };
}

afterEach(() => {
  delete global.__MONOCODE_APP__;
});

describe("a bench's refusal of another CLI", () => {
  it("refuses every CLI but Claude on a bench, in verify_live.rs's words", () => {
    global.__MONOCODE_APP__ = identity("dev", { runId: "bench-1" });
    for (const cli of ["codex", "grok", "hermes", "cursor", "opencode", "pi", "fx", "devin", "antigravity"]) {
      expect(benchCliRefusal(cli)).toBe(
        `This bench only starts the run's own Claude wrapper. It won't start ${cli}.`,
      );
    }
    expect(benchCliRefusal("claude")).toBeUndefined();
  });

  it("is the sentence verify_live.rs refuses with, not a second wording that could drift", () => {
    global.__MONOCODE_APP__ = identity("dev", { runId: "bench-1" });
    const rust = readFileSync(
      new URL("../../../../src-tauri/src/verify_live.rs", import.meta.url),
      "utf8",
    );
    expect(rust).toContain(TEMPLATE);
    expect(benchCliRefusal("codex")).toBe(TEMPLATE.replace("{}", "codex"));
  });

  it("says nothing outside a bench: the daily app, a plain dev copy, or no identity at all", () => {
    expect(benchCliRefusal("codex")).toBeUndefined();
    global.__MONOCODE_APP__ = identity("dev");
    expect(benchCliRefusal("codex")).toBeUndefined();
    global.__MONOCODE_APP__ = identity("daily");
    expect(benchCliRefusal("codex")).toBeUndefined();
  });
});
