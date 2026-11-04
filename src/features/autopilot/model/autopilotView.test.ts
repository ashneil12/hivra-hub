import { describe, expect, it } from "vitest";
import type { AutopilotStatus, LogEntry } from "./autopilot";
import { byDay, dayLabel, heldThisRun, outcomeLabel, switchLines, unseenCalls } from "./autopilotView";

const NOW = new Date(2026, 9, 17, 15, 0).getTime();
const H = 3_600_000;

function entry(patch: Partial<LogEntry>): LogEntry {
  return {
    id: crypto.randomUUID(),
    at: NOW,
    kind: "decision",
    outcome: "taken",
    project: null,
    chatId: null,
    monoId: null,
    who: null,
    what: "x",
    recommendation: null,
    red: null,
    detail: null,
    ...patch,
  };
}

function status(switches: AutopilotStatus["switches"]): AutopilotStatus {
  return {
    switches,
    awake: { supported: true, held: true, error: null },
    relaunch: { supported: false, installed: false, reason: "Dev copies don't relaunch themselves." },
    autoResume: { default: true, projects: {} },
    logSeenAt: 0,
    unseen: 0,
    relaunchedAfterCrash: false,
    now: NOW,
  };
}

describe("the Autopilot screen's words", () => {
  it("one line per switch, with who turned it on and Ash's words", () => {
    const lines = switchLines(
      status([
        { scope: "*", untilMs: new Date(2026, 9, 19, 9, 0).getTime(), setBy: "mono:ada", setAt: NOW, chatId: "c", said: "go autopilot until monday 9" },
        { scope: "hivra", untilMs: NOW + 2 * H, setBy: "ash", setAt: NOW, chatId: null, said: null },
        { scope: "vg-game", untilMs: NOW - 1, setBy: "ash", setAt: NOW, chatId: null, said: null },
      ]),
      NOW,
      (id) => ({ hivra: "Hivra" })[id] ?? id,
      (id) => (id === "ada" ? "Chief of Staff" : id),
    );
    expect(lines).toEqual([
      { scope: "*", text: "On for everything until Mon 9:00", remaining: "42h left", setBy: "Chief of Staff turned it on when you said “go autopilot until monday 9”" },
      { scope: "hivra", text: "On for Hivra until 17:00", remaining: "2h left", setBy: "You turned it on here" },
    ]);
  });

  it("names each outcome plainly", () => {
    expect(outcomeLabel({ kind: "decision", outcome: "taken", red: null })).toBe("Took its recommendation");
    expect(outcomeLabel({ kind: "approval", outcome: "taken", red: null })).toBe("Allowed");
    expect(outcomeLabel({ kind: "decision", outcome: "held", red: "money" })).toBe("Waiting for you: moving money, refunds or charges");
    expect(outcomeLabel({ kind: "approval", outcome: "held", red: null })).toBe("Waiting for you: not one autopilot allows by itself");
    expect(outcomeLabel({ kind: "question", outcome: "handed_back", red: null })).toBe("Told to decide itself");
    expect(outcomeLabel({ kind: "relaunch", outcome: "relaunched", red: null })).toBe("Reopened after a crash");
    expect(outcomeLabel({ kind: "resume", outcome: "armed", red: null })).toBe("Paused at a usage limit");
  });

  it("groups the log by day, newest first", () => {
    const groups = byDay([entry({ at: NOW - 26 * H, what: "old" }), entry({ at: NOW - H, what: "new" }), entry({ at: NOW - 3 * H, what: "mid" })], NOW);
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.what)])).toEqual([
      ["Today", ["new", "mid"]],
      ["Yesterday", ["old"]],
    ]);
    expect(dayLabel(NOW - 3 * 24 * H, NOW)).toBe("Wed 14 Oct");
  });

  it("lists the red-list calls held since autopilot last went on, and counts unseen calls", () => {
    const log = [
      entry({ at: NOW - 30 * H, outcome: "held", red: "money", what: "before" }),
      entry({ at: NOW - 20 * H, kind: "switch", outcome: "on" }),
      entry({ at: NOW - 10 * H, outcome: "held", red: "delete", what: "this run" }),
      entry({ at: NOW - 5 * H, outcome: "taken" }),
      entry({ at: NOW - 4 * H, kind: "resume", outcome: "armed" }),
    ];
    expect(heldThisRun(log).map((e) => e.what)).toEqual(["this run"]);
    expect(unseenCalls(log, NOW - 11 * H)).toBe(2);
  });
});
