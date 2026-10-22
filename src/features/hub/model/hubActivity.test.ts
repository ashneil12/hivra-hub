import { describe, expect, it } from "vitest";
import { IDLE_MS, REPORT_GAP_MS, startActivityTracking, type ActivityEnv } from "./hubActivity";

/** A fake window and clock: nothing happens unless a test moves time or sends an event. */
function fakeEnv() {
  let now = 1_000_000;
  let visible = true;
  const listeners = new Map<string, Set<() => void>>();
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const env: ActivityEnv = {
    target: {
      addEventListener: (t, fn) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn as () => void),
      removeEventListener: (t, fn) => void listeners.get(t)?.delete(fn as () => void),
    },
    visible: () => visible,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    env,
    input: (type = "keydown") => listeners.get(type)?.forEach((fn) => fn()),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = Math.max(now, next.at);
        next.fn();
      }
      now = end;
    },
    hide: () => (visible = false),
    show: () => (visible = true),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    pendingTimers: () => timers.length,
    now: () => now,
  };
}

describe("activity tracking", () => {
  it("reports nothing while nobody is using the app, however long the window sits open", () => {
    const f = fakeEnv();
    const reports: Date[] = [];
    startActivityTracking((at) => reports.push(at), f.env);
    f.advance(3 * 3600_000);
    expect(reports).toEqual([]);
    expect(f.pendingTimers()).toBe(0);
  });

  it("reports the first input at once, with the time of the input", () => {
    const f = fakeEnv();
    const reports: Date[] = [];
    startActivityTracking((at) => reports.push(at), f.env);
    const t = f.now();
    f.input("keydown");
    f.advance(0);
    expect(reports.map((d) => d.getTime())).toEqual([t]);
  });

  it("reports at most once a minute while Ash keeps working, carrying the latest input", () => {
    const f = fakeEnv();
    const reports: Date[] = [];
    startActivityTracking((at) => reports.push(at), f.env);
    f.input();
    f.advance(0);
    for (let i = 0; i < 100; i++) {
      f.advance(1000);
      f.input("keydown");
    }
    // 100 seconds of steady use: one report at the start, one a minute later
    expect(reports.length).toBe(2);
    expect(reports[1].getTime()).toBeGreaterThan(reports[0].getTime());
    // the input still waiting goes out when the minute is up, carrying the time it happened
    f.advance(REPORT_GAP_MS);
    expect(reports.length).toBe(3);
    expect(reports[2].getTime()).toBeGreaterThan(reports[1].getTime());
    f.advance(10 * REPORT_GAP_MS);
    expect(reports.length).toBe(3); // no input since: no more reports
  });

  it("reports the first input after a 30-minute gap straight away, so Ash OS sees him come back", () => {
    const f = fakeEnv();
    const reports: Date[] = [];
    startActivityTracking((at) => reports.push(at), f.env);
    f.input();
    f.advance(0);
    f.advance(IDLE_MS + 5 * 60_000);
    const back = f.now();
    f.input("keydown");
    f.advance(0);
    expect(reports.length).toBe(2);
    expect(reports[1].getTime()).toBe(back);
  });

  it("counts only typing or a click as use (C9: the app merely being open is not), and ignores input while hidden", () => {
    const f = fakeEnv();
    const reports: Date[] = [];
    startActivityTracking((at) => reports.push(at), f.env);
    for (const type of ["pointermove", "wheel", "scroll", "touchstart", "focus", "visibilitychange", "mouseover"]) f.input(type);
    f.advance(REPORT_GAP_MS);
    expect(reports).toEqual([]);
    f.hide();
    f.input("keydown");
    f.advance(REPORT_GAP_MS);
    expect(reports).toEqual([]);
    f.show();
    f.input("keydown");
    f.advance(0);
    expect(reports.length).toBe(1);
    f.advance(REPORT_GAP_MS);
    f.input("click");
    f.advance(0);
    expect(reports.length).toBe(2);
  });

  it("stops listening when asked, and a report still waiting is dropped", () => {
    const f = fakeEnv();
    const reports: Date[] = [];
    const stop = startActivityTracking((at) => reports.push(at), f.env);
    f.input();
    stop();
    f.advance(REPORT_GAP_MS);
    expect(reports).toEqual([]);
    expect(f.listenerCount()).toBe(0);
  });

  it("does nothing without a window", () => {
    expect(() => startActivityTracking(() => undefined, undefined)()).not.toThrow();
  });
});
