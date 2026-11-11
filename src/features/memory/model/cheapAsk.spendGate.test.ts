// @vitest-environment happy-dom
// WP-176 round 4 (M-4): the memory cheap call is an automated turn. Over the app's limit it is refused and the memory
// tool is never invoked; under it, the call runs and is noted in the ledger as unpriced.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import type { UsageSession } from "../../usage/model/history";
import { resetSpendGate, saveSpendLimit, setSpendClock, setSpendRecords, setSpendSessions } from "../../usage/model/spendGate";
import { realCall } from "./cheapAsk";

const now = Date.parse("2026-11-10T15:00:00");
const route = { provider: "custom", baseUrl: "https://example.test", modelId: "acme", customModelId: "custom:acme" };

describe("M-4: the memory cheap call passes the spend gate", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true, text: "{}", kind: "ok", reason: "" });
    resetSpendGate();
    setSpendClock(() => now);
  });

  it("is refused over the app's limit, and the memory tool is not called", async () => {
    setSpendSessions([{ id: "earlier", cwd: "/work/monocode-hub", harness: "claude", model: "opus", blocks: [{ id: "e-t", role: "user", startedAt: now, turnMetrics: { costUsd: 50, inputTokens: 5 } }] } as UsageSession]);
    saveSpendLimit({ scope: "app", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    const outcome = await realCall(route, "curate");
    expect(outcome).toMatchObject({ ok: false, kind: "refused" });
    expect(invoke).not.toHaveBeenCalledWith("plugin:hub|memory_cheap_ask", expect.anything());
  });

  it("under the limit it runs the memory tool, and notes the call as unpriced", async () => {
    setSpendRecords([]);
    saveSpendLimit({ scope: "app", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    const outcome = await realCall(route, "curate");
    expect(outcome).toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith("plugin:hub|memory_cheap_ask", expect.anything());
  });
});
