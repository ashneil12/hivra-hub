// Port map idea 4: Alan's Workspace thresholds (activity.cjs): a signal counts for 6000 ms, the feed is trusted for
// 8000 ms, and what the app can't know is never idle.
import { describe, expect, it } from "vitest";
import { FEED_TTL_MS, MonoLiveness, SIGNAL_TTL_MS, liveState } from "./monoLiveness";

describe("liveState thresholds", () => {
  it("are 6000 ms and 8000 ms", () => {
    expect(SIGNAL_TTL_MS).toBe(6000);
    expect(FEED_TTL_MS).toBe(8000);
  });

  it("working while the signal is under 6000 ms old; idle at 6000 ms", () => {
    const seen = { feedAt: 10_000, signalAt: 10_000 };
    expect(liveState(seen, true, 10_000 + 5999)).toBe("working");
    // The feed is fresh again (seen at 16000) but the signal is 6000 ms old.
    expect(liveState({ feedAt: 16_000, signalAt: 10_000 }, true, 16_000)).toBe("idle");
  });

  it("can't tell once the feed has been silent 8000 ms; not at 7999", () => {
    expect(liveState({ feedAt: 0 }, true, 7999)).toBe("idle");
    expect(liveState({ feedAt: 0 }, true, 8000)).toBe("unknown");
    // Unknown wins over a signal that would still be live.
    expect(liveState({ feedAt: 0, signalAt: 7000 }, true, 8000)).toBe("unknown");
  });

  it("a chat never seen is can't tell, never idle; a Mono with no chat yet is idle", () => {
    expect(liveState(undefined, true, 0)).toBe("unknown");
    expect(liveState(undefined, false, 0)).toBe("idle");
  });
});

describe("MonoLiveness", () => {
  it("a turn seen stopped ends working at once", () => {
    const live = new MonoLiveness();
    live.note("cos", { present: true, busy: true }, 1000);
    expect(live.state("cos", true, 1000)).toBe("working");
    live.note("cos", { present: true, busy: false }, 2000);
    expect(live.state("cos", true, 2000)).toBe("idle");
  });

  it("a chat seen running that leaves the window: working under 6 s, idle to 8 s, then can't tell", () => {
    const live = new MonoLiveness();
    live.note("cos", { present: true, busy: true }, 0);
    for (const at of [1000, 5999, 6000, 7999, 8000, 60_000]) live.note("cos", { present: false, busy: false }, at);
    expect(live.state("cos", true, 5999)).toBe("working");
    expect(live.state("cos", true, 6000)).toBe("idle");
    expect(live.state("cos", true, 7999)).toBe("idle");
    expect(live.state("cos", true, 8000)).toBe("unknown");
    expect(live.state("cos", true, 60_000)).toBe("unknown");
    // Seen again: known at once.
    live.note("cos", { present: true, busy: false }, 61_000);
    expect(live.state("cos", true, 61_000)).toBe("idle");
  });

  it("a Mono chat not loaded (they load when opened) and not seen running is known idle, however long", () => {
    const live = new MonoLiveness();
    live.note("lead", { present: false, busy: false }, 0);
    live.note("lead", { present: false, busy: false }, 60_000);
    expect(live.state("lead", true, 60_000)).toBe("idle");
    live.note("cos", { present: true, busy: false }, 0);
    // The rail notes every chat each second (App.tsx monoRailState, useClock(1000)).
    for (let at = 1000; at <= 30_000; at += 1000) live.note("cos", { present: false, busy: false }, at);
    expect(live.state("cos", true, 30_000)).toBe("idle");
  });

  it("the rail re-reads only when a state can change on its own: at 6 s and 8 s after a running chat left", () => {
    const live = new MonoLiveness();
    live.note("cos", { present: true, busy: true }, 1000);
    expect(live.nextChange(1000)).toBeUndefined();
    live.note("cos", { present: false, busy: false }, 2000);
    expect(live.nextChange(2000)).toBe(1000 + SIGNAL_TTL_MS);
    expect(live.nextChange(7000)).toBe(1000 + FEED_TTL_MS);
    expect(live.nextChange(9000)).toBeUndefined();
    live.note("idle", { present: false, busy: false }, 2000);
    expect(live.nextChange(9000)).toBeUndefined();
  });
});
