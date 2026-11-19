import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import {
  claimOf,
  coverageGaps,
  doneGaps,
  factSummary,
  factsFromBlocks,
  sentBackReason,
  type FactTurn,
} from "./factGaps";

function turn(partial: Partial<FactTurn> = {}): FactTurn {
  return {
    checks: partial.checks ?? [],
    edits: partial.edits ?? [],
    todos: partial.todos ?? [],
    answer: partial.answer ?? "",
  };
}

function block(partial: Partial<Block> & Pick<Block, "role">): Block {
  return { id: partial.id ?? partial.role, text: partial.text ?? "", ...partial };
}

describe("done gaps", () => {
  it("names a check that failed this turn, and a later pass of the same command clears it", () => {
    expect(doneGaps(turn({ checks: [{ command: "npm test", status: "failed", at: 1 }] }))).toEqual([
      "A check failed this turn (npm test).",
    ]);
    expect(
      doneGaps(
        turn({
          checks: [
            { command: "npm test", status: "failed", at: 1 },
            { command: "npm test", status: "passed", at: 2 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("does not treat a check that is still running as a failure or as evidence", () => {
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npm test", status: "running", at: 1 }],
          edits: [{ path: "src/features/crew/row.ts", at: 2 }],
          answer: "The tests passed.",
        }),
      ),
    ).toEqual([
      "The answer says the tests passed, but no check ran after the last edit.",
      "No test reached crew.",
    ]);
  });

  it("says tests went stale when a passing test is not rerun after a later code edit", () => {
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npx vitest run", status: "passed", at: 1 }],
          edits: [{ path: "src/features/crew/row.ts", at: 2 }],
        }),
      ),
    ).toEqual(["Tests went stale after the last edit."]);
  });

  it("does not call a later failure stale, and does not call a turn stale when nothing passed", () => {
    expect(
      doneGaps(
        turn({
          checks: [
            { command: "npx vitest run", status: "passed", at: 1 },
            { command: "npx vitest run", status: "failed", at: 3 },
          ],
          edits: [{ path: "src/a.ts", at: 2 }],
        }),
      ),
    ).toEqual(["A check failed this turn (npx vitest run)."]);
    expect(
      doneGaps(turn({ edits: [{ path: "src/features/crew/row.ts", at: 1 }] })),
    ).toEqual(["No test reached crew."]);
  });

  it("ignores a docs edit when deciding whether a passing test went stale", () => {
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npm test", status: "passed", at: 2 }],
          edits: [
            { path: "src/a.ts", at: 1 },
            { path: "docs/guide.md", at: 3 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("refuses a pass claim with no check after the last code edit", () => {
    const gaps = doneGaps(
      turn({
        checks: [{ command: "npm test", status: "passed", at: 1 }],
        edits: [{ path: "src/a.ts", at: 2 }],
        answer: "12 tests passed.\nThe build passed.",
      }),
    );
    expect(gaps).toContain("The answer says the tests passed, but no check ran after the last edit.");
    expect(gaps).toContain("The answer says the build passed, but no check ran after the last edit.");
    expect(claimOf("tests failed")).toBeUndefined();
    expect(claimOf("not all tests passed")).toBeUndefined();
    expect(claimOf("the typecheck passed")).toEqual({ build: true });
  });

  it("accepts a passing check anywhere when the turn did not edit code", () => {
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npm test", status: "passed", at: 1 }],
          edits: [{ path: "docs/guide.md", at: 4 }],
          answer: "The tests passed.",
        }),
      ),
    ).toEqual([]);
  });

  it("names one open to-do, counts several, and ignores a finished or repeated one", () => {
    expect(doneGaps(turn({ todos: [{ text: "write the note", open: true }] }))).toEqual([
      "There is still an open to-do: write the note.",
    ]);
    expect(
      doneGaps(
        turn({
          todos: [
            { text: "write the note", open: true },
            { text: "write the note", open: true },
            { text: "ship it", open: false },
            { text: "ask Ash", open: true },
          ],
        }),
      ),
    ).toEqual(["There are still 2 open to-dos."]);
  });

  it("names an edited package no test reached", () => {
    expect(
      coverageGaps(
        turn({
          checks: [{ command: "npx vitest run src/features/gates/a.test.ts", status: "passed", at: 2 }],
          edits: [{ path: "src/features/crew/row.ts", at: 1 }],
        }),
      ),
    ).toEqual(["No test reached crew."]);
    expect(
      doneGaps(
        turn({
          checks: [{ command: "cargo test -p crew", status: "passed", at: 1 }],
          edits: [{ path: "crates/crew/src/lib.rs", at: 2 }],
        }),
      ),
    ).toEqual(["Tests went stale after the last edit."]);
  });

  it("treats a project-wide test as reaching every package, without covering a later edit", () => {
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npm test", status: "passed", at: 1 }],
          edits: [{ path: "packages/web/src/app.ts", at: 2 }],
        }),
      ),
    ).toEqual(["Tests went stale after the last edit."]);
  });

  it("ignores docs-only edits for coverage, and still reports a failed check, a claim and an open to-do", () => {
    expect(
      coverageGaps(
        turn({
          edits: [
            { path: "docs/guide.md", at: 1 },
            { path: "README.md", at: 2 },
            { path: "src/features/crew/README.md", at: 3 },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npm test", status: "failed", at: 1 }],
          edits: [{ path: "docs/guide.md", at: 2 }],
          todos: [{ text: "fix the doc", open: true }],
          answer: "The tests passed.",
        }),
      ),
    ).toEqual([
      "A check failed this turn (npm test).",
      "The answer says the tests passed, but no check ran after the last edit.",
      "There is still an open to-do: fix the doc.",
    ]);
  });

  it("treats src/docs.ts as code, and a bare filename as no package", () => {
    expect(doneGaps(turn({ edits: [{ path: "src/docs.ts", at: 1 }] }))).toEqual(["No test reached src."]);
    expect(doneGaps(turn({ edits: [{ path: "row.ts", at: 1 }] }))).toEqual([]);
  });

  it("reads windows separators and drops .. segments without looking at the disk", () => {
    expect(
      coverageGaps(turn({ edits: [{ path: "src\\features\\crew\\row.ts", at: 1 }] })),
    ).toEqual(["No test reached crew."]);
    expect(
      coverageGaps(turn({ edits: [{ path: "packages/web/../other/a.ts", at: 1 }] })),
    ).toEqual(["No test reached web."]);
  });

  it("returns nothing for an empty turn, and drops a command that is not a check", () => {
    expect(doneGaps(turn())).toEqual([]);
    expect(doneGaps(turn({ checks: [{ command: "git status", status: "failed", at: 1 }] }))).toEqual([]);
    expect(doneGaps(turn({ checks: [{ command: "npm test", status: "nope" as "failed", at: 1 }] }))).toEqual([]);
  });

  it("keeps only a bounded number of checks, edits and to-dos", () => {
    const checks = Array.from({ length: 41 }, (_, at) => ({
      command: `npm test ${at}`,
      status: "failed" as const,
      at,
    }));
    expect(doneGaps(turn({ checks }))).toHaveLength(40);
    const edits = Array.from({ length: 81 }, (_, at) => ({ path: `src/pkg${at}/a.ts`, at }));
    expect(coverageGaps(turn({ edits }))).toHaveLength(80);
  });
});

describe("sent back", () => {
  it("lowers the first gap into one sentence, and counts the rest", () => {
    expect(sentBackReason(["Tests went stale after the last edit."])).toBe(
      "Sent back: tests went stale after the last edit.",
    );
    expect(sentBackReason(["Tests went stale after the last edit.", "No test reached crew."])).toBe(
      "Sent back: tests went stale after the last edit. Also 1 more.",
    );
    expect(factSummary(["Tests went stale after the last edit."])).toBe(
      "Sent back: tests went stale after the last edit.",
    );
    expect(factSummary(["A check failed this turn (npm test).", "No test reached crew."])).toBe(
      [
        "Sent back: a check failed this turn (npm test). Also 1 more.",
        "A check failed this turn (npm test).",
        "No test reached crew.",
      ].join("\n"),
    );
    expect(sentBackReason([])).toBe("");
  });
});

describe("facts from blocks", () => {
  it("uses this turn only, the latest to-do list, and a write's path", () => {
    const blocks: Block[] = [
      block({ role: "user", text: "earlier" }),
      block({
        role: "tool",
        tool: { title: "npm test", status: "error", preview: { kind: "shell", title: "npm test" } },
      }),
      block({ role: "user", text: "finish it" }),
      block({
        role: "tool",
        tool: { command: "npm test", status: "completed", preview: { kind: "shell", title: "npm test" } },
      }),
      block({
        role: "tool",
        tool: {
          kind: "write",
          title: "Write",
          paths: ["src/features/crew/row.ts"],
          preview: { kind: "write", path: "src/features/crew/row.ts" },
        },
      }),
      block({ role: "tasks", taskList: { items: [{ text: "old", status: "pending" }] } }),
      block({
        role: "tasks",
        taskList: {
          items: [
            { text: "ship it", status: "completed" },
            { text: "write the note", status: "in_progress" },
          ],
        },
      }),
    ];
    const facts = factsFromBlocks(blocks, "The tests passed.");
    expect(facts.checks).toEqual([{ command: "npm test", status: "passed", at: 0 }]);
    expect(facts.edits).toEqual([{ path: "src/features/crew/row.ts", at: 1 }]);
    expect(facts.todos).toEqual([
      { text: "ship it", open: false },
      { text: "write the note", open: true },
    ]);
    expect(doneGaps(facts)).toEqual([
      "Tests went stale after the last edit.",
      "The answer says the tests passed, but no check ran after the last edit.",
      "There is still an open to-do: write the note.",
    ]);
  });

  it("does not start a new turn at an internal note, and keeps a check that is still running", () => {
    const blocks: Block[] = [
      block({ role: "user", text: "do it" }),
      block({
        role: "tool",
        tool: { command: "npm test", status: "pending", preview: { kind: "shell" } },
      }),
      block({ role: "user", text: "nudge", internal: true }),
    ];
    expect(factsFromBlocks(blocks, "").checks).toEqual([{ command: "npm test", status: "running", at: 0 }]);
  });
});

// Review round 1 (PR #232): failing repros. Each test states what the gate should do.
describe("review r1", () => {
  // MED: Claude's edit preview path is absolute, so the docs/ rule never matches it.
  it("r1: a docs/ edit recorded with an absolute path is still docs", () => {
    const blocks: Block[] = [
      block({ role: "user", text: "do it" }),
      block({
        role: "tool",
        tool: { command: "npm test", status: "completed", preview: { kind: "shell", title: "npm test" } },
      }),
      block({
        role: "tool",
        tool: {
          kind: "edit",
          title: "Edit",
          preview: { kind: "write", path: "/Users/ash/Worktrees/hub-x/docs/hivra/credits.json" },
        },
      }),
    ];
    expect(doneGaps(factsFromBlocks(blocks, ""))).toEqual([]);
  });

  // HIGH: the caps keep the first 40 checks, so a test after the last edit in a long turn is never sent to Rust.
  it("r1: a long turn still sends its latest test run", () => {
    const blocks: Block[] = [block({ role: "user", text: "do it" })];
    for (let i = 0; i < 40; i++) {
      blocks.push(block({ id: `tsc-${i}`, role: "tool", tool: { command: "npx tsc --noEmit", status: "completed" } }));
    }
    blocks.push(
      block({
        id: "edit",
        role: "tool",
        tool: { kind: "edit", title: "Edit", preview: { kind: "write", path: "src/features/crew/row.ts" } },
      }),
    );
    blocks.push(block({ id: "vitest", role: "tool", tool: { command: "npx vitest run", status: "completed" } }));
    const facts = factsFromBlocks(blocks, "");
    expect(facts.checks.at(-1)?.command).toBe("npx vitest run");
    expect(doneGaps(facts)).toEqual([]);
  });

  // LOW (parity): Rust's claim_of splits a lone \r; the TS one does not.
  it("r1: claimOf splits a lone carriage return like Rust", () => {
    expect(claimOf("Not run yet.\rAll tests passed.")).toEqual({ tests: true });
  });
});

describe("review r1: edits the facts miss", () => {
  // LOW: an edit made through the shell after the last test is not an edit, so the test never goes stale.
  it("r1: a sed -i edit after the last test makes it stale", () => {
    const blocks: Block[] = [
      block({ role: "user", text: "do it" }),
      block({ id: "t", role: "tool", tool: { command: "npx vitest run", status: "completed" } }),
      block({
        id: "sed",
        role: "tool",
        tool: { kind: "execute", command: "sed -i 's/a/b/' src/features/crew/row.ts", status: "completed" },
      }),
    ];
    expect(doneGaps(factsFromBlocks(blocks, ""))).toEqual(["Tests went stale after the last edit."]);
  });
});

// Review round 2 (PR #232): failing repros. Each test states what the gate should do.
describe("review r2", () => {
  // MED: a second line runs after the test, so the command's status is the second line's. The facts sent to Rust join
  // the lines with `&&`, which reads as if the test's failure would still show, and a failing suite counts as a pass.
  it("r2: a multi-line test command is not sent as if its lines were joined by &&", () => {
    const blocks: Block[] = [
      block({ role: "user", text: "do it" }),
      block({
        id: "edit",
        role: "tool",
        tool: { kind: "edit", title: "Edit", preview: { kind: "write", path: "src/features/crew/row.ts" } },
      }),
      block({ id: "t", role: "tool", tool: { kind: "execute", command: "npm test\necho done", status: "completed" } }),
    ];
    const facts = factsFromBlocks(blocks, "All tests passed.");
    expect(facts.checks.filter((check) => check.command.includes("&& echo done"))).toEqual([]);
    expect(doneGaps(facts)).not.toEqual([]);
  });

  // LOW: a `sed -i` and the test in one command (`sed -i ... && npx vitest run`) is an edit and then a run of it. Both
  // get the same place, so the run never counts as after the edit and correct work is sent back as stale.
  it("r2: a sed -i edit followed by the test in the same command is not stale", () => {
    const blocks: Block[] = [
      block({ role: "user", text: "do it" }),
      block({ id: "t1", role: "tool", tool: { kind: "execute", command: "npx vitest run", status: "completed" } }),
      block({
        id: "t2",
        role: "tool",
        tool: {
          kind: "execute",
          command: "sed -i 's/a/b/' src/features/crew/row.ts && npx vitest run",
          status: "completed",
        },
      }),
    ];
    expect(doneGaps(factsFromBlocks(blocks, ""))).toEqual([]);
  });
});

describe("whole class", () => {
  it("turning pipefail off does not make a pipe a pass", () => {
    const gaps = doneGaps(
      turn({
        checks: [
          {
            command: "set -o pipefail && set +o pipefail && npm test | tail -20",
            status: "passed",
            at: 2,
          },
        ],
        edits: [{ path: "src/features/crew/row.ts", at: 1 }],
      }),
    );
    expect(gaps).toContain("A piped or masked run does not count.");
  });

  it("a pipe with pipefail counts as a pass, and && still counts", () => {
    for (const command of ["set -o pipefail && npm test | tail -20", "set -euo pipefail && npm test | tail -20", "npm test && echo done"]) {
      expect(
        doneGaps(
          turn({
            checks: [{ command, status: "passed", at: 2 }],
            edits: [{ path: "src/features/crew/row.ts", at: 1 }],
          }),
        ),
        command,
      ).toEqual([]);
    }
  });

  it("a crlf line break masks the test", () => {
    const gaps = doneGaps(
      turn({
        checks: [{ command: "npm test\r\necho done", status: "passed", at: 2 }],
        edits: [{ path: "src/features/crew/row.ts", at: 1 }],
        answer: "All tests passed.",
      }),
    );
    expect(gaps).toContain("A piped or masked run does not count.");
  });

  it("check:rust, check:web and check:scripts reach the edited package", () => {
    for (const command of ["npm run check:rust", "npm run check:web", "npm run check:scripts"]) {
      expect(
        doneGaps(
          turn({
            checks: [{ command, status: "passed", at: 2 }],
            edits: [{ path: "src/features/crew/row.ts", at: 1 }],
          }),
        ),
        command,
      ).toEqual([]);
    }
  });

  it("native:check is not a test run", () => {
    expect(
      doneGaps(
        turn({
          checks: [
            { command: "npx vitest run", status: "passed", at: 1 },
            { command: "npm run native:check", status: "passed", at: 3 },
          ],
          edits: [{ path: "src/features/crew/row.ts", at: 2 }],
        }),
      ),
    ).toEqual(["Tests went stale after the last edit."]);
  });
});

describe("a flood of checks in the webview", () => {
  // The facts the gate gets are cut to 40 here before Rust sees them, so repeats collapse here too.
  it("forty type checks after a failing test do not drop the failure before it is sent", () => {
    const blocks: Block[] = [
      block({ role: "user", text: "do it" }),
      block({
        id: "edit",
        role: "tool",
        tool: { kind: "edit", title: "Edit", preview: { kind: "write", path: "src/features/crew/row.ts" } },
      }),
      block({ id: "test", role: "tool", tool: { command: "npm test", status: "failed" } }),
    ];
    for (let i = 0; i < 40; i++) {
      blocks.push(block({ id: `tsc-${i}`, role: "tool", tool: { command: "npx tsc --noEmit", status: "completed" } }));
    }
    blocks.push(
      block({
        id: "other",
        role: "tool",
        tool: { command: "npx vitest run src/features/crew/other.test.ts", status: "completed" },
      }),
    );
    const facts = factsFromBlocks(blocks, "");
    expect(facts.checks.some((check) => check.command === "npm test" && check.status === "failed")).toBe(true);
    expect(doneGaps(facts)).toContain("A check failed this turn (npm test).");
  });
});

describe("leftover: coverage and stale follow the package", () => {
  it("leftover: a test before the package's last edit does not cover it", () => {
    expect(
      coverageGaps(
        turn({
          checks: [{ command: "npm test", status: "passed", at: 1 }],
          edits: [{ path: "packages/web/src/app.ts", at: 2 }],
        }),
      ),
    ).toEqual(["No test reached web."]);
    expect(
      coverageGaps(
        turn({
          checks: [{ command: "npm test", status: "failed", at: 1 }],
          edits: [{ path: "packages/web/src/app.ts", at: 2 }],
        }),
      ),
    ).toEqual(["No test reached web."]);
    expect(
      coverageGaps(
        turn({
          checks: [{ command: "npm test", status: "passed", at: 2 }],
          edits: [
            { path: "packages/web/src/app.ts", at: 1 },
            { path: "packages/web/src/later.ts", at: 3 },
          ],
        }),
      ),
    ).toEqual(["No test reached web."]);
    expect(
      coverageGaps(
        turn({
          checks: [{ command: "npm test", status: "passed", at: 4 }],
          edits: [
            { path: "packages/web/src/app.ts", at: 1 },
            { path: "packages/web/src/later.ts", at: 3 },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npm test", status: "passed", at: 1 }],
          edits: [{ path: "packages/web/src/app.ts", at: 2 }],
        }),
      ),
    ).toEqual(["Tests went stale after the last edit."]);
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npm test", status: "failed", at: 1 }],
          edits: [{ path: "packages/web/src/app.ts", at: 2 }],
        }),
      ),
    ).toEqual(["A check failed this turn (npm test).", "No test reached web."]);
  });

  it("leftover: a later test of another package does not clear stale", () => {
    expect(
      doneGaps(
        turn({
          checks: [
            { command: "npm test", status: "passed", at: 1 },
            { command: "npx vitest run src/features/crew/row.test.ts", status: "passed", at: 3 },
          ],
          edits: [{ path: "packages/web/src/app.ts", at: 2 }],
        }),
      ),
    ).toEqual(["Tests went stale after the last edit."]);
    expect(
      doneGaps(
        turn({
          checks: [
            { command: "cargo test -p web", status: "passed", at: 1 },
            { command: "cargo test -p crew", status: "failed", at: 3 },
          ],
          edits: [{ path: "crates/web/src/lib.rs", at: 2 }],
        }),
      ),
    ).toEqual([
      "A check failed this turn (cargo test -p crew).",
      "Tests went stale after the last edit.",
    ]);
    expect(
      doneGaps(
        turn({
          checks: [
            { command: "npm test", status: "passed", at: 1 },
            { command: "npx vitest run src/features/crew/row.test.ts", status: "passed", at: 4 },
          ],
          edits: [
            { path: "packages/web/src/app.ts", at: 2 },
            { path: "src/features/crew/row.ts", at: 3 },
          ],
        }),
      ),
    ).toEqual(["Tests went stale after the last edit."]);
    expect(
      doneGaps(
        turn({
          checks: [
            { command: "npm test", status: "passed", at: 1 },
            { command: "npx vitest run src/features/crew/row.test.ts", status: "passed", at: 3 },
          ],
          edits: [{ path: "src/features/crew/row.ts", at: 2 }],
        }),
      ),
    ).toEqual([]);
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npx vitest run src/features/crew/row.test.ts", status: "passed", at: 2 }],
          edits: [
            { path: "src/features/crew/row.ts", at: 1 },
            { path: "docs/guide.md", at: 3 },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      doneGaps(
        turn({
          checks: [{ command: "npm test", status: "passed", at: 1 }],
          edits: [{ path: "row.ts", at: 2 }],
        }),
      ),
    ).toEqual(["Tests went stale after the last edit."]);
    expect(
      doneGaps(
        turn({
          checks: [
            { command: "npm test", status: "passed", at: 1 },
            { command: "npx vitest run src/features/crew/row.test.ts", status: "passed", at: 3 },
          ],
          edits: [{ path: "row.ts", at: 2 }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("leftover: sed then a check", () => {
  function sedThen(command: string, answer: string) {
    const blocks: Block[] = [
      block({ role: "user", text: "do it" }),
      block({
        id: "run",
        role: "tool",
        tool: { kind: "execute", command, status: "completed" },
      }),
    ];
    return factsFromBlocks(blocks, answer);
  }

  it("leftover: sed -i followed by a typecheck in the same command is after the edit", () => {
    const commands = [
      "sed -i 's/a/b/' src/features/crew/row.ts && npx tsc --noEmit",
      "sed -i 's/a/b/' src/features/crew/row.ts && npm run typecheck",
      "sed -i 's/a/b/' src/features/crew/row.ts && cargo check",
      "sed -i 's/a/b/' src/features/crew/row.ts && cargo clippy",
      "sed -i 's/a/b/' src/features/crew/row.ts && cargo build",
      "sed -i 's/a/b/' src/features/crew/row.ts && npx eslint src/features/crew/row.ts",
      "sed -i 's/a/b/' src/features/crew/row.ts\nnpx tsc --noEmit",
    ];
    for (const command of commands) {
      const facts = sedThen(command, "The typecheck passed.");
      const edit = facts.edits.find((row) => row.path.endsWith("row.ts"));
      const check = facts.checks[0];
      expect(edit, command).toBeDefined();
      expect(check, command).toBeDefined();
      expect(edit && check && edit.at < check.at, command).toBe(true);
      expect(doneGaps(facts), command).toEqual(["No test reached crew."]);
    }
  });

  it("leftover: a typecheck after sed does not stand in for the test", () => {
    const blocks: Block[] = [
      block({ role: "user", text: "do it" }),
      block({ id: "t", role: "tool", tool: { kind: "execute", command: "npx vitest run", status: "completed" } }),
      block({
        id: "run",
        role: "tool",
        tool: {
          kind: "execute",
          command: "sed -i 's/a/b/' src/features/crew/row.ts && npx tsc --noEmit",
          status: "completed",
        },
      }),
    ];
    const facts = factsFromBlocks(blocks, "The typecheck passed.");
    expect(doneGaps(facts)).toEqual(["Tests went stale after the last edit."]);
  });

  it("leftover: a typecheck before sed, or a piped typecheck, is not after the edit", () => {
    for (const command of [
      "npx tsc --noEmit && sed -i 's/a/b/' src/features/crew/row.ts",
      "sed -i 's/a/b/' src/features/crew/row.ts && npx tsc --noEmit | tail",
    ]) {
      const facts = sedThen(command, "The typecheck passed.");
      expect(doneGaps(facts), command).toContain(
        "The answer says the build passed, but no check ran after the last edit.",
      );
    }
  });
});

// SC-7: the facts also carry each test run with the end of its output, and the first edit to a source file, for the
// "no red before the fix" gap in Rust (src-tauri/src/firstmate/fact_gaps.rs). The order against the edits is the turn's.
describe("SC-7: test runs and the first source edit", () => {
  const edit = (path: string, id = path): Block =>
    block({
      id,
      role: "tool",
      tool: { kind: "write", title: "Write", paths: [path], preview: { kind: "write", path } },
    });
  const run = (command: string, detail: string | undefined, status = "completed", id = command): Block =>
    block({ id, role: "tool", tool: { command, status, ...(detail === undefined ? {} : { detail }) } });
  const user = block({ role: "user", text: "fix the sort" });

  it("sends every finished test run with its command, place in the turn and output", () => {
    const facts = factsFromBlocks(
      [
        user,
        edit("src/sort.test.ts"),
        run("npx vitest run src/sort.test.ts", "Tests  1 failed (1)\n"),
        edit("src/sort.ts"),
        run("npx vitest run src/sort.test.ts", "Tests  1 passed (1)\n"),
      ],
      "",
    );
    expect(facts.runs).toEqual([
      { command: "npx vitest run src/sort.test.ts", at: 1, output: "Tests  1 failed (1)\n" },
      { command: "npx vitest run src/sort.test.ts", at: 3, output: "Tests  1 passed (1)\n" },
    ]);
    // The checks list keeps only the latest run of a command; the runs list keeps both, so the earlier red is not lost.
    expect(facts.checks).toHaveLength(1);
  });

  it("keeps a run that failed, and skips a run still going, a lint, a type check and a piped test", () => {
    const facts = factsFromBlocks(
      [
        user,
        run("npm test", "Tests  1 failed (1)\n", "failed", "a"),
        run("npm test", undefined, "pending", "b"),
        run("npx tsc --noEmit", "ok", "completed", "c"),
        run("npx eslint .", "ok", "completed", "d"),
        run("npm test | tail -n 5", "Tests  1 passed (1)\n", "completed", "e"),
      ],
      "",
    );
    expect(facts.runs?.map((r) => r.command)).toEqual(["npm test"]);
    expect(facts.runs?.[0]?.at).toBe(0);
  });

  it("keeps the end of a long output, where the summary is, and reads a block with no detail as empty", () => {
    const long = `${"x".repeat(20_000)}\nTests  1 failed (1)\n`;
    const facts = factsFromBlocks([user, run("npm test", long), run("cargo test", undefined, "completed", "b")], "");
    const first = facts.runs?.[0]?.output ?? "";
    expect(first.length).toBeLessThanOrEqual(8_000);
    expect(first.endsWith("Tests  1 failed (1)\n")).toBe(true);
    expect(facts.runs?.[1]).toEqual({ command: "cargo test", at: 1, output: "" });
  });

  it("falls back to the block's text when the tool left no detail", () => {
    const facts = factsFromBlocks(
      [user, block({ id: "t", role: "tool", text: "Tests  1 failed (1)\n", tool: { command: "npm test", status: "completed" } })],
      "",
    );
    expect(facts.runs?.[0]?.output).toBe("Tests  1 failed (1)\n");
  });

  it("names the first edit to a file that is neither a test nor a document", () => {
    const facts = factsFromBlocks(
      [user, edit("docs/notes.md"), edit("src/sort.test.ts"), edit("tests/helpers.ts"), edit("src/sort.ts"), edit("src/other.ts")],
      "",
    );
    // The user's message starts the turn and is not in it: the blocks after it are numbered from 0.
    expect(facts.firstCodeEditAt).toBe(3);
  });

  it("has no first source edit when only tests and documents changed", () => {
    const facts = factsFromBlocks([user, edit("src/sort.test.ts"), edit("README.md"), edit("src\\a.spec.ts")], "");
    expect(facts.firstCodeEditAt).toBeUndefined();
    expect("firstCodeEditAt" in facts).toBe(false);
  });

  it("finds the first source edit even when the list of edits was cut at its cap", () => {
    const blocks: Block[] = [user, edit("src/first.ts")];
    for (let n = 0; n < 100; n++) blocks.push(edit(`src/more${n}.test.ts`));
    const facts = factsFromBlocks(blocks, "");
    expect(facts.edits.length).toBeLessThan(100);
    expect(facts.firstCodeEditAt).toBe(0);
  });

  it("counts a shell edit placed before its own test run", () => {
    const facts = factsFromBlocks(
      [user, run("sed -i 's/a/b/' src/sort.ts && npx vitest run src/sort.test.ts", "Tests  1 passed (1)\n")],
      "",
    );
    expect(facts.firstCodeEditAt).toBe(-0.5);
    expect(facts.runs?.[0]?.at).toBe(0);
  });

  it("keeps the facts the other gaps read exactly as they were", () => {
    const facts = factsFromBlocks([user, run("npm test", "Tests  1 passed (1)\n")], "done");
    expect(facts.checks).toEqual([{ command: "npm test", status: "passed", at: 0 }]);
    expect(facts.edits).toEqual([]);
    expect(facts.answer).toBe("done");
  });
});
