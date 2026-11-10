import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_COMPACT_CLAIM_MS,
  claimIdleCompaction,
  confirmIdleCompactionClaim,
  recallPromptCache,
  releaseIdleCompactionClaim,
  rememberPromptCache,
} from "./claudePromptCache";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

const KEY = "monocode.claudePromptCache";

beforeEach(() => storage.clear());

function seed() {
  rememberPromptCache("lead", {
    providerSessionId: "sess_1",
    lastTurnAt: 10,
    cacheTtlMs: 60_000,
    contextUsed: 200_000,
  });
}

describe("idle compact claim", () => {
  it("lets one window hold the claim and keeps a second window out", () => {
    seed();
    expect(claimIdleCompaction("lead", "A", 1_000)).toBe(true);
    expect(claimIdleCompaction("lead", "B", 1_000)).toBe(false);
    expect(confirmIdleCompactionClaim("lead", "A", 1_000)).toBe(true);
    expect(confirmIdleCompactionClaim("lead", "B", 1_000)).toBe(false);
  });

  it("drops the claim when the other window's write lands before confirm", () => {
    seed();
    expect(claimIdleCompaction("lead", "A", 1_000)).toBe(true);
    const store = JSON.parse(storage.get(KEY) ?? "{}") as {
      lead: { idleClaim?: { id: string; at: number } };
    };
    store.lead.idleClaim = { id: "B", at: 1_000 };
    storage.set(KEY, JSON.stringify(store));
    expect(confirmIdleCompactionClaim("lead", "A", 1_000)).toBe(false);
    expect(confirmIdleCompactionClaim("lead", "B", 1_000)).toBe(true);
    releaseIdleCompactionClaim("lead", "A");
    expect(confirmIdleCompactionClaim("lead", "B", 1_000)).toBe(true);
    releaseIdleCompactionClaim("lead", "B");
    expect(confirmIdleCompactionClaim("lead", "B", 1_000)).toBe(false);
  });

  it("lets a new claim take over once the old one has aged out", () => {
    seed();
    expect(claimIdleCompaction("lead", "A", 1_000)).toBe(true);
    expect(claimIdleCompaction("lead", "B", 1_000 + IDLE_COMPACT_CLAIM_MS)).toBe(true);
    expect(confirmIdleCompactionClaim("lead", "B", 1_000 + IDLE_COMPACT_CLAIM_MS)).toBe(true);
  });

  it("drops the claim when a turn is remembered, and ignores a broken store", () => {
    seed();
    expect(claimIdleCompaction("lead", "A", 1_000)).toBe(true);
    rememberPromptCache("lead", { providerSessionId: "sess_1", lastTurnAt: 50, contextUsed: 10 });
    expect(recallPromptCache("lead")).not.toHaveProperty("idleClaim");
    expect(claimIdleCompaction("lead", "C", 2_000)).toBe(true);

    storage.set(KEY, "{");
    expect(claimIdleCompaction("lead", "D", 2_000)).toBe(false);
    expect(confirmIdleCompactionClaim("lead", "D", 2_000)).toBe(false);
    expect(recallPromptCache("lead")).toBeUndefined();
    releaseIdleCompactionClaim("lead", "D");
  });

  it("refuses a claim when there is no chat, or the clock is not a number", () => {
    expect(claimIdleCompaction("missing", "A", 1_000)).toBe(false);
    seed();
    expect(claimIdleCompaction("lead", "", 1_000)).toBe(false);
    expect(claimIdleCompaction("lead", "A", Number.NaN)).toBe(false);
    const store = JSON.parse(storage.get(KEY) ?? "{}") as { lead: { idleClaim: unknown } };
    store.lead.idleClaim = "nope";
    storage.set(KEY, JSON.stringify(store));
    expect(claimIdleCompaction("lead", "A", 1_000)).toBe(true);
  });
});
