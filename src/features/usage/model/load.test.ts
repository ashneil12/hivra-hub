import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { loadUsageHistory, USAGE_LOOKBACK_MS } from "./load";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

const NOW = new Date(2026, 10, 6, 15).getTime();

describe("loadUsageHistory", () => {
  it("asks for rows since one day before the window and counts them", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        id: "s1",
        cwd: "/work/app",
        harness: "claude",
        model: "sonnet-5",
        title: "not counted",
        blocks: [
          {
            id: "b1",
            role: "user",
            text: "not counted",
            startedAt: NOW,
            turnMetrics: { inputTokens: 10, costUsd: 0.25 },
          },
        ],
      },
    ]);

    const history = await loadUsageHistory(NOW);

    expect(invoke).toHaveBeenCalledWith("session_usage_rows", {
      since: Math.trunc(NOW - USAGE_LOOKBACK_MS),
    });
    expect(history.last30.inputTokens).toBe(10);
    expect(history.last30.costUsd).toBe(0.25);
    expect(JSON.stringify(history)).not.toContain("not counted");
  });

  it("rejects a reply that is not a list, and a timeout, instead of reporting no usage", async () => {
    vi.mocked(invoke).mockResolvedValue({ rows: [] });
    await expect(loadUsageHistory(NOW)).rejects.toThrow(/not a list/);

    vi.mocked(invoke).mockRejectedValue(new Error("timed out"));
    await expect(loadUsageHistory(NOW)).rejects.toThrow(/timed out/);
  });
});
