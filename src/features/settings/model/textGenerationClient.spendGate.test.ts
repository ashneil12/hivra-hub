// @vitest-environment happy-dom
// WP-176 round 6: the saved text model is a billed call. An automated one over the spend limit is refused before the
// model runs; a commit message Ash asked for is his turn (warned, not refused).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSpendGate, saveSpendLimit, setSpendClock, setSpendRecords } from "../../usage/model/spendGate";
import { askShortText, type TextGenerationPort } from "./textGenerationClient";

const now = Date.parse("2026-11-10T15:00:00");
const setting = { provider: "custom", model: "acme-1", baseUrl: "https://example.test" } as never;
const models = [{ id: "acme", provider: "custom", baseUrl: "https://example.test", modelId: "acme-1" }];

describe("round 6: the text model passes the spend gate", () => {
  beforeEach(() => {
    resetSpendGate();
    setSpendClock(() => now);
    setSpendRecords([{ projectKey: "/work/monocode-hub", sessionId: "chat", day: "2026-11-10", micros: 50_000_000, priced: 1, unpriced: 0, source: "claude" }]);
    saveSpendLimit({ scope: "app", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
  });

  it("an automated text-model call over the limit is refused before the model runs", async () => {
    const complete = vi.fn(async () => "feat: change");
    const port = { complete } as unknown as TextGenerationPort;
    await expect(
      askShortText({ setting, prompt: "write a commit message", models, port, origin: "automated" }),
    ).rejects.toThrow(/limit/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("a commit message Ash asked for goes through over the limit", async () => {
    const complete = vi.fn(async () => "feat: change");
    const port = { complete } as unknown as TextGenerationPort;
    await expect(
      askShortText({ setting, prompt: "write a commit message", models, port, origin: "person" }),
    ).resolves.toBe("feat: change");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
