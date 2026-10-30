// r87 (s14 r86 run 3, +245s to +442s): a worker's turn hit "API Error: Server error mid-response", its harness retried
// ("API retry 7 of 10 · server error (503)"), and for three minutes nothing on the Lead, Today or Being built said so.
import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import type { Delegation } from "./delegations";
import { judgeStall, lookAt, providerErrorAtEnd, providerStallNote, PROVIDER_STALL_PREFIX, StallWatch, type Stall } from "./workerStall";

const b = (role: Block["role"], text: string, extra: Partial<Block> = {}) => ({ id: `${role}-${text}`, role, text, ...extra }) as Block;
const turn: Block[] = [
  b("user", "keep them 30 days"),
  b("assistant", "Ash wants a deleted tally kept for 30 days. I'll look through the store."),
  b("tool", "Read store.ts", { tool: { kind: "read", title: "Read store.ts", status: "completed" } } as Partial<Block>),
  b("assistant", "API Error: Server error mid-response. The response above may be incomplete."),
  b("system", "API retry 7 of 10 · server error (503)"),
  b("reasoning", "Ash wants items kept for 30 days."),
];

describe("a worker stuck after a provider error", () => {
  it("reads the error at the end of its turn, and not once it moves on", () => {
    expect(providerErrorAtEnd(turn)).toBe("API Error: Server error mid-response. The response above may be incomplete.");
    expect(providerErrorAtEnd([...turn, b("tool", "Edit", { tool: { kind: "edit", title: "Edit", status: "completed" } } as Partial<Block>)])).toBeUndefined();
    expect(providerErrorAtEnd(turn.slice(0, 3))).toBeUndefined();
  });

  it("is stuck after 60s of it, counted from the error, not from the retry lines", () => {
    const look = lookAt({ busy: true, blocks: turn, cwd: "/p" } as never);
    const presence = { watchedSince: 0, lastChangeAt: 50_000, lastProgressAt: 0, steps: 3, errorSince: 10_000 };
    expect(judgeStall(look, presence, 60_000)).toBeNull();
    const stall = judgeStall(look, presence, 71_000)!;
    expect(stall.kind).toBe("quiet");
    expect(stall.reason.startsWith(PROVIDER_STALL_PREFIX)).toBe(true);
    expect(stall.since).toBe(10_000);
  });

  it("tells its Lead once per error, with a retry offered", () => {
    const row = { id: "d1", title: "Delete tallies", state: "running", childSession: "w", ownerSession: "lead", stallKind: null } as unknown as Delegation;
    const told: Stall[] = [];
    let clock = 0;
    const watch = new StallWatch({
      tracker: () => ({ isLoaded: () => true, known: () => [row], setStall: async () => undefined }) as never,
      session: () => ({ busy: true, blocks: turn, cwd: "/p" }) as never,
      openOwned: () => 0,
      now: () => clock,
      providerStall: (_row, stall) => told.push(stall),
    });
    watch.tick();
    clock = 30_000;
    watch.tick();
    expect(told).toHaveLength(0);
    clock = 65_000;
    watch.tick();
    clock = 95_000;
    watch.tick();
    expect(told).toHaveLength(1);
    const note = providerStallNote(row, told[0]);
    expect(note).toContain('delegate_task redoes "d1"');
    expect(note).toContain("Today and Being built");
  });
});
