import { afterEach, describe, expect, it, vi } from "vitest";

const headless = vi.hoisted(() => ({ on: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "ticket") }));
vi.mock("../../../integrations/harness/core/child", () => ({
  hasHeadlessChildBackend: () => headless.on,
}));

import { judgeV2Session } from "./host";

afterEach(() => {
  vi.unstubAllGlobals();
  headless.on = false;
});

// WP-141 round 8 (LOW): the judgment is skipped only where a headless child backend runs; anywhere else with no window
// the gate is unavailable, so the start is refused.
describe("judgeV2Session without a window", () => {
  it("refuses the start when there is no window and no headless child backend", async () => {
    vi.stubGlobal("window", undefined);
    await expect(judgeV2Session({ sessionId: "s", folder: "/f" })).rejects.toThrow(
      "The crew gate is unavailable",
    );
  });

  it("skips the judgment for the headless host, which has no gate", async () => {
    vi.stubGlobal("window", undefined);
    headless.on = true;
    await expect(judgeV2Session({ sessionId: "s", folder: "/f" })).resolves.toBeUndefined();
  });
});
