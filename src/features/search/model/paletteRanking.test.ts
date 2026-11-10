// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PALETTE_PICKS_MAX,
  PALETTE_STORAGE_KEY,
  PALETTE_USES_MAX,
  activePick,
  loadPaletteState,
  paletteList,
  recordPalettePick,
  recordPaletteUse,
  savePaletteState,
  stepRunnable,
  type PaletteState,
  type RankedCommandInput,
} from "./paletteRanking";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const commands: RankedCommandInput[] = [
  { id: "tab.new", label: "New", group: "Tab" },
  { id: "tab.close", label: "Close", group: "Tab" },
  { id: "tab.next", label: "Next", group: "Tab" },
  { id: "terminal.new", label: "New", group: "Terminal" },
  { id: "terminal.dock", label: "Toggle Dock", group: "Terminal" },
  { id: "app.settings", label: "Settings", group: "App" },
  { id: "app.search", label: "Search", group: "App" },
  { id: "app.home", label: "Home", group: "App" },
  { id: "git.commit", label: "Commit", group: "Git" },
  { id: "git.push", label: "Push", group: "Git" },
];

function empty(): PaletteState {
  return { uses: [], picks: [] };
}

function commandIds(items: ReturnType<typeof paletteList>): string[] {
  return items.flatMap((item) => (item.kind === "command" ? [item.command.id] : []));
}

function headings(items: ReturnType<typeof paletteList>): string[] {
  return items.flatMap((item) => (item.kind === "heading" ? [item.label] : []));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an empty query", () => {
  it("lists the commands in their groups, alphabetically, with no recents yet", () => {
    const items = paletteList(commands, "", empty(), NOW);
    expect(headings(items)).toEqual(["Tab", "Terminal", "App", "Git"]);
    expect(commandIds(items)).toEqual([
      "tab.close",
      "tab.new",
      "tab.next",
      "terminal.new",
      "terminal.dock",
      "app.home",
      "app.search",
      "app.settings",
      "git.commit",
      "git.push",
    ]);
    expect(items.every((item) => item.kind !== "heading" || item.label !== "Recent")).toBe(true);
  });

  it("shows the last 8 commands used first, newest first, then the rest grouped", () => {
    let state = empty();
    state = recordPaletteUse(state, "app.settings", NOW - 9 * DAY);
    state = recordPaletteUse(state, "tab.new", NOW - 1 * DAY);
    state = recordPaletteUse(state, "terminal.dock", NOW - 2 * DAY);
    state = recordPaletteUse(state, "git.push", NOW - 3 * DAY);
    state = recordPaletteUse(state, "apple", NOW - 4 * DAY);

    const items = paletteList(commands, "", state, NOW);
    expect(items[0]).toMatchObject({ kind: "heading", label: "Recent" });
    expect(commandIds(items).slice(0, 4)).toEqual([
      "tab.new",
      "terminal.dock",
      "git.push",
      "app.settings",
    ]);
    // A command that has since gone is not shown, and nothing appears twice.
    expect(commandIds(items)).not.toContain("apple");
    const ids = commandIds(items);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(commands.length);
  });

  it("keeps the recent list to 8", () => {
    let state = empty();
    for (const [index, command] of commands.entries()) {
      state = recordPaletteUse(state, command.id, NOW - index * 1000);
    }
    const items = paletteList(commands, "", state, NOW);
    const firstHeading = items.findIndex(
      (item) => item.kind === "heading" && item.label !== "Recent",
    );
    expect(firstHeading).toBe(9);
    expect(commandIds(items).slice(0, 8)).toHaveLength(8);
    expect(commandIds(items)).toHaveLength(commands.length);
  });

  it("ignores a use of a command that no longer exists", () => {
    const state = recordPaletteUse(empty(), "gone", NOW);
    expect(commandIds(paletteList(commands, "", state, NOW))).toEqual(
      commandIds(paletteList(commands, "", empty(), NOW)),
    );
  });
});

describe("a typed query", () => {
  it("ranks by how often and how recently used, then the alphabet", () => {
    let state = empty();
    state = recordPaletteUse(state, "terminal.new", NOW - 1000);
    state = recordPaletteUse(state, "terminal.new", NOW - 2000);
    state = recordPaletteUse(state, "tab.new", NOW - 3000);
    expect(commandIds(paletteList(commands, "new", state, NOW))).toEqual([
      "terminal.new",
      "tab.new",
    ]);

    // Same use count: the more recent one first.
    let tie = empty();
    tie = recordPaletteUse(tie, "terminal.new", NOW - 5000);
    tie = recordPaletteUse(tie, "tab.new", NOW - 1000);
    expect(commandIds(paletteList(commands, "new", tie, NOW))).toEqual([
      "tab.new",
      "terminal.new",
    ]);

    // No history at all: the alphabet.
    expect(commandIds(paletteList(commands, "new", empty(), NOW))).toEqual([
      "tab.new",
      "terminal.new",
    ]);
  });

  it("puts a closer match above a command used more often", () => {
    const pairs: RankedCommandInput[] = [
      { id: "a.new", label: "New", group: "Tab" },
      { id: "b.renew", label: "Renew window", group: "Tab" },
    ];
    let state = empty();
    for (let index = 0; index < 10; index++) {
      state = recordPaletteUse(state, "b.renew", NOW - index);
    }
    expect(commandIds(paletteList(pairs, "new", state, NOW))).toEqual([
      "a.new",
      "b.renew",
    ]);
  });

  it("matches a group name too, so tab new finds Tab: New", () => {
    expect(commandIds(paletteList(commands, "tab new", empty(), NOW))).toEqual([
      "tab.new",
    ]);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(paletteList(commands, "zzzz", empty(), NOW)).toEqual([]);
  });
});

describe("the last pick for a query", () => {
  it("ranks that command first for the query for 3 weeks", () => {
    let state = empty();
    state = recordPalettePick(state, "new", "terminal.new", NOW - 20 * DAY);
    expect(commandIds(paletteList(commands, "new", state, NOW))[0]).toBe(
      "terminal.new",
    );
    expect(activePick(state, "new", NOW)?.id).toBe("terminal.new");
  });

  it("stops applying after 3 weeks", () => {
    let state = empty();
    state = recordPalettePick(state, "new", "terminal.new", NOW - 22 * DAY);
    expect(activePick(state, "new", NOW)).toBeNull();
    expect(commandIds(paletteList(commands, "new", state, NOW))[0]).toBe(
      "tab.new",
    );
  });

  it("applies a longer query's pick to words it starts with", () => {
    let state = empty();
    state = recordPalettePick(state, "toggle dock", "terminal.dock", NOW - DAY);
    expect(activePick(state, "toggle dock terminal", NOW)?.id).toBe(
      "terminal.dock",
    );
    expect(activePick(state, "to", NOW)).toBeNull();
  });

  it("folds case and spacing in the query", () => {
    let state = empty();
    state = recordPalettePick(state, "  NEW ", "terminal.new", NOW - DAY);
    expect(activePick(state, "new", NOW)?.id).toBe("terminal.new");
    expect(activePick(state, "New", NOW)?.id).toBe("terminal.new");
  });

  it("keeps one pick per query, the newest wins, and bounds the list", () => {
    let state = empty();
    state = recordPalettePick(state, "new", "tab.new", NOW - 2 * DAY);
    state = recordPalettePick(state, "new", "terminal.new", NOW - DAY);
    expect(state.picks.filter((pick) => pick.query === "new")).toHaveLength(1);
    for (let index = 0; index < 200; index++) {
      state = recordPalettePick(state, `query ${index}`, "tab.new", NOW - index);
    }
    expect(state.picks.length).toBeLessThanOrEqual(PALETTE_PICKS_MAX);
  });

  it("ignores a blank query", () => {
    expect(recordPalettePick(empty(), "   ", "tab.new", NOW).picks).toEqual([]);
  });

  it("cuts a long query to 32 characters so one typo cannot split it", () => {
    const long = `  ${"a".repeat(40)}  `;
    const state = recordPalettePick(empty(), long, "tab.new", NOW);
    expect(state.picks[0]?.query).toBe("a".repeat(32));
  });
});

describe("stepping over greyed commands", () => {
  const rows = [
    { blockedReason: null },
    { blockedReason: "Open a project first" },
    { blockedReason: null },
    { blockedReason: "Open a project first" },
  ];

  it("lands only on a command that can run", () => {
    expect(stepRunnable(rows, 0, 1)).toBe(2);
    expect(stepRunnable(rows, 2, 1)).toBe(0);
    expect(stepRunnable(rows, 0, -1)).toBe(2);
    // Starting on a greyed row still moves on to a runnable one.
    expect(stepRunnable(rows, 1, 1)).toBe(2);
  });

  it("answers -1 when nothing can run, and never loops", () => {
    expect(stepRunnable([{ blockedReason: "No" }], 0, 1)).toBe(-1);
    expect(stepRunnable([], 0, 1)).toBe(-1);
    expect(stepRunnable([{ blockedReason: null }], 5, -1)).toBe(0);
  });
});

describe("stored palette history", () => {
  it("round trips through localStorage", () => {
    let state = empty();
    state = recordPaletteUse(state, "tab.new", NOW);
    state = recordPalettePick(state, "new", "tab.new", NOW);
    savePaletteState(state);
    expect(loadPaletteState()).toEqual(state);
  });

  it("ignores a corrupt value and a wrongly typed one", () => {
    localStorage.setItem(PALETTE_STORAGE_KEY, "{not json");
    expect(loadPaletteState()).toEqual(empty());
    localStorage.setItem(
      PALETTE_STORAGE_KEY,
      JSON.stringify({ uses: "nope", picks: [{ query: 1, id: null, at: "x" }] }),
    );
    expect(loadPaletteState()).toEqual(empty());
  });

  it("drops rows that do not parse, and keeps the good ones", () => {
    localStorage.setItem(
      PALETTE_STORAGE_KEY,
      JSON.stringify({
        uses: [
          { id: "tab.new", at: NOW, count: 2 },
          { id: "", at: NOW, count: 1 },
          { id: "tab.next", at: Number.NaN, count: 1 },
          "junk",
        ],
        picks: [
          { query: "new", id: "tab.new", at: NOW },
          { query: "", id: "tab.new", at: NOW },
          { query: "x", id: 7, at: NOW },
        ],
      }),
    );
    expect(loadPaletteState()).toEqual({
      uses: [{ id: "tab.new", at: NOW, count: 2 }],
      picks: [{ query: "new", id: "tab.new", at: NOW }],
    });
  });

  it("bounds the number of commands remembered", () => {
    let state = empty();
    for (let index = 0; index < 400; index++) {
      state = recordPaletteUse(state, `command-${index}`, NOW - index);
    }
    expect(state.uses.length).toBeLessThanOrEqual(PALETTE_USES_MAX);
  });

  it("survives a storage that refuses to write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => savePaletteState(empty())).not.toThrow();
  });

  it("starts empty when there is no storage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadPaletteState()).toEqual(empty());
    expect(() => savePaletteState(empty())).not.toThrow();
    vi.unstubAllGlobals();
  });
});
