// PT-5: the tests waiting to be sorted at ship (src-tauri `test_debt_summary`). What these keep honest: an answer from the app is
// untrusted and is checked field by field, a bad answer shows nothing, the list is capped, and the words say singular and plural
// and "Sorting" only when the app says it is sorting.
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import {
  loadTestDebt,
  readTestDebtSummary,
  tauriTestDebt,
  testDebtLine,
  testDebtToSort,
  type TestDebtBackend,
} from "./testDebt";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

function item(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    test: "saves the draft",
    file: "src/draft.test.ts",
    since: 1_700_000_000_000,
    task: "Draft saving",
    state: "to-sort",
    ...over,
  };
}

function summary(over: Record<string, unknown> = {}) {
  return { count: 1, sorting: false, items: [item()], ...over };
}

describe("reading the app's answer", () => {
  it("reads a well-formed answer as it is", () => {
    expect(readTestDebtSummary(summary())).toEqual({
      count: 1,
      sorting: false,
      items: [
        {
          id: "t1",
          test: "saves the draft",
          file: "src/draft.test.ts",
          since: 1_700_000_000_000,
          task: "Draft saving",
          state: "to-sort",
        },
      ],
    });
  });

  it.each([null, undefined, "3", 3, true, [], [summary()]])("refuses an answer that is not an object: %j", (value) => {
    expect(readTestDebtSummary(value)).toBeNull();
  });

  it.each(["3", -1, 1.5, Number.NaN, null])("refuses a count that is not a whole number of zero or more: %j", (count) => {
    expect(readTestDebtSummary(summary({ count }))).toBeNull();
  });

  it.each(["yes", 1, null])("refuses a sorting flag that is not true or false: %j", (sorting) => {
    expect(readTestDebtSummary(summary({ sorting }))).toBeNull();
  });

  it.each(["none", 5, null, { 0: item() }])("refuses an items list that is not a list: %j", (items) => {
    expect(readTestDebtSummary(summary({ items }))).toBeNull();
  });

  it("drops an item whose state is unknown and keeps the rest", () => {
    const read = readTestDebtSummary(
      summary({
        count: 2,
        items: [item({ id: "a" }), item({ id: "b", state: "passed" }), item({ id: "c", state: "real-bug" })],
      }),
    );
    expect(read?.items.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it.each([
    ["a non-text id", { id: 7 }],
    ["an empty id", { id: "   " }],
    ["no test name", { test: undefined }],
    ["a blank test name", { test: "  " }],
    ["a since that is text", { since: "yesterday" }],
    ["a since that is negative", { since: -1 }],
    ["a since that is not finite", { since: Number.POSITIVE_INFINITY }],
    ["a since out of the calendar", { since: 9e15 }],
  ])("drops an item with %s", (_label, over) => {
    expect(readTestDebtSummary(summary({ count: 2, items: [item(), item({ id: "bad", ...over })] }))?.items).toHaveLength(1);
  });

  it("keeps only the first of two items with the same id", () => {
    const read = readTestDebtSummary(
      summary({ count: 2, items: [item({ test: "first" }), item({ test: "second" })] }),
    );
    expect(read?.items.map((row) => row.test)).toEqual(["first"]);
  });

  it("caps the list at 100 items and keeps the count the app gave", () => {
    const items = Array.from({ length: 500 }, (_, index) => item({ id: `t${index}`, test: `test ${index}` }));
    const read = readTestDebtSummary(summary({ count: 500, items }));
    expect(read?.count).toBe(500);
    expect(read?.items).toHaveLength(100);
    expect(read?.items[99]?.id).toBe("t99");
  });

  it("trims text and caps each field's length", () => {
    const read = readTestDebtSummary(
      summary({
        items: [
          item({
            id: `  ${"i".repeat(200)}  `,
            test: `  ${"n".repeat(500)}  `,
            file: `  ${"f".repeat(500)}  `,
            task: `  ${"k".repeat(500)}  `,
          }),
        ],
      }),
    );
    const row = read?.items[0];
    expect(row?.id).toHaveLength(80);
    expect(row?.test).toHaveLength(200);
    expect(row?.file).toHaveLength(300);
    expect(row?.task).toHaveLength(120);
    expect(row?.test).toBe("n".repeat(200));
  });

  it("reads a missing file or task as empty text, not as a refusal", () => {
    const row = readTestDebtSummary(summary({ items: [item({ file: undefined, task: undefined })] }))?.items[0];
    expect(row?.file).toBe("");
    expect(row?.task).toBe("");
  });

  it("accepts an empty list with a count of zero", () => {
    expect(readTestDebtSummary({ count: 0, sorting: false, items: [] })).toEqual({ count: 0, sorting: false, items: [] });
  });
});

describe("the line's words", () => {
  it("shows nothing for a count of zero or less", () => {
    expect(testDebtLine(0, false, 0)).toBeNull();
    expect(testDebtLine(-1, false, 0)).toBeNull();
    expect(testDebtLine(0, true, 0)).toBeNull();
  });

  it("says one test in the singular", () => {
    expect(testDebtLine(1, false, 1)).toBe("1 test to sort at ship");
  });

  it("says tests in the plural", () => {
    expect(testDebtLine(3, false, 3)).toBe("3 tests to sort at ship");
  });

  it("counts every test the app counts, not only the ones it lists as to sort", () => {
    expect(testDebtLine(3, false, 1)).toBe("3 tests to sort at ship");
  });

  it("reads Sorting with the number of tests to sort while the app is sorting", () => {
    expect(testDebtLine(3, true, 2)).toBe("Sorting 2 tests");
    expect(testDebtLine(3, true, 1)).toBe("Sorting 1 test");
  });

  it("reads plain Sorting tests when none of the listed tests is to sort", () => {
    expect(testDebtLine(3, true, 0)).toBe("Sorting tests");
  });

  it("counts only the items whose state is to sort", () => {
    const items = readTestDebtSummary(
      summary({
        count: 3,
        items: [item({ id: "a" }), item({ id: "b", state: "real-bug" }), item({ id: "c", state: "flaky" })],
      }),
    )?.items ?? [];
    expect(testDebtToSort(items)).toBe(1);
  });

  it("never says Stuck", () => {
    for (const line of [testDebtLine(1, false, 1), testDebtLine(3, true, 0)]) {
      expect(line).not.toMatch(/stuck/i);
    }
  });
});

describe("loading it", () => {
  function backend(over: Partial<TestDebtBackend> = {}): TestDebtBackend {
    return { summary: vi.fn(async () => summary()), ...over };
  }

  it("asks the app for the project's summary and reads the answer", async () => {
    const api = backend();
    expect(await loadTestDebt("/work/app", api)).toEqual(readTestDebtSummary(summary()));
    expect(api.summary).toHaveBeenCalledWith("/work/app");
  });

  it("shows nothing when the read fails", async () => {
    expect(await loadTestDebt("/work/app", backend({ summary: vi.fn(async () => Promise.reject("gone")) }))).toBeNull();
  });

  it("shows nothing when the answer is not one it can read", async () => {
    expect(await loadTestDebt("/work/app", backend({ summary: vi.fn(async () => ({ count: "lots" })) }))).toBeNull();
  });

  it("asks nothing for a project with no folder", async () => {
    const api = backend();
    expect(await loadTestDebt("  ", api)).toBeNull();
    expect(api.summary).not.toHaveBeenCalled();
  });

  it("sends the summary request to the app as test_debt_summary with the folder", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(summary());
    expect(await tauriTestDebt.summary("/work/app")).toEqual(summary());
    expect(invoke).toHaveBeenCalledWith("test_debt_summary", { cwd: "/work/app" });
  });
});
