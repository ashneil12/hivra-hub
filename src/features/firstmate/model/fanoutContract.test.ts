import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FANOUT_MAX_TASKS,
  describeProvide,
  parseFanout,
  renderContractBlock,
  renderContractForTask,
  requiresCycle,
  type FanoutInput,
} from "./fanoutContract";

const INTENT = "Ash asked for a score board with an API behind it.";

/** Two parts: the API provides a route and a file, the board relies on the route. */
function plan(patch: Partial<FanoutInput> = {}): FanoutInput {
  return {
    intent: INTENT,
    tasks: [
      {
        name: "api",
        brief: "Add GET /api/score in src/api/score.ts returning { score: number }.",
        goal: "GET /api/score answers 200 with a number",
        owns: ["src/api/"],
        provides: [
          { kind: "endpoint", name: "/api/score", in: "src/api/score.ts", shape: "GET, returns { score: number }" },
          { kind: "file", name: "src/api/score.ts" },
        ],
        checks: ["api-tests"],
      },
      {
        name: "board",
        brief: "Show the score from /api/score in src/ui/Board.tsx.",
        goal: "The board shows the number the API returns",
        owns: ["src/ui/Board.tsx"],
        requires: ["/api/score"],
      },
    ],
    ...patch,
  };
}

function refusal(input: unknown): string {
  try {
    parseFanout(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

describe("a fan-out's contract (WP-171)", () => {
  it("reads owners, provides, requires and checks into one contract", () => {
    const parsed = parseFanout(plan());
    expect(parsed.tasks.map((task) => task.name)).toEqual(["api", "board"]);
    expect(parsed.contract.owners).toEqual({ "src/api": "api", "src/ui/Board.tsx": "board" });
    expect(parsed.contract.provides).toEqual([
      { task: "api", kind: "endpoint", name: "/api/score", in: "src/api/score.ts", shape: "GET, returns { score: number }" },
      { task: "api", kind: "file", name: "src/api/score.ts" },
    ]);
    expect(parsed.contract.requires).toEqual([{ task: "board", name: "/api/score" }]);
    expect(parsed.contract.checks).toEqual([{ task: "api", id: "api-tests" }]);
    expect(parsed.warnings).toEqual([]);
  });

  it("gives each task the shared intent unless it brings its own", () => {
    const input = plan();
    input.tasks[1] = { ...input.tasks[1], intent: "Ash: the board must show the live score." };
    const parsed = parseFanout(input);
    expect(parsed.tasks[0].intent).toBe(INTENT);
    expect(parsed.tasks[1].intent).toBe("Ash: the board must show the live score.");
  });

  it("a declared check becomes that task's checks gate, so an unrun check is never a pass", () => {
    const parsed = parseFanout(plan());
    expect(parsed.tasks[0].gates).toEqual({ gates: ["checks"], checks: ["api-tests"] });
    // No check named: the task keeps the gates it asked for, or none.
    expect(parsed.tasks[1].gates).toBeUndefined();
  });

  describe("a task's own check lines and do-not-touch list (SC-4)", () => {
    const line = { what: "the route answers", command: "curl -s localhost:3000/api/score", expect: "ok" };
    const withTask = (patch: Record<string, unknown>) => {
      const input = plan();
      input.tasks[0] = { ...input.tasks[0], ...patch } as FanoutInput["tasks"][number];
      return input;
    };

    it("keeps the project's check ids and the task's own lines apart, and the lines make it a code task", () => {
      const parsed = parseFanout(withTask({ checks: ["api-tests", line], leave: ["src/legacy", "./docs/"] }));
      const api = parsed.tasks[0];
      expect(api.checkLines).toEqual([line]);
      expect(api.leave).toEqual(["src/legacy", "docs"]);
      expect(api.gates).toEqual({ gates: ["checks"], checks: ["api-tests"], code: true });
      // The contract's own CHECKS list is the project's ids; a line is the task's and is not shown to the others.
      expect(parsed.contract.checks).toEqual([{ task: "api", id: "api-tests" }]);
      // A line alone: the checks gate comes with it (a code task), and no project id is named.
      const alone = parseFanout(withTask({ checks: [line] })).tasks[0];
      expect(alone.checkLines).toEqual([line]);
      expect(alone.gates).toEqual({ code: true });
      expect(alone.codeBrief).toBe(true);
      // A task with neither is as it was.
      const board = parsed.tasks[1];
      expect(board.checkLines).toEqual([]);
      expect(board.leave).toEqual([]);
      expect(board.codeBrief).toBe(false);
    });

    it("a task whose lines are plain names reads exactly as it did", () => {
      const parsed = parseFanout(plan());
      expect(parsed.tasks[0].checkLines).toEqual([]);
      expect(parsed.tasks[0].gates).toEqual({ gates: ["checks"], checks: ["api-tests"] });
    });

    it("is a code task by the full-mode rule when it says so, names gates or in-scope paths", () => {
      expect(parseFanout(withTask({ checks: undefined, code: true })).tasks[0].codeBrief).toBe(true);
      expect(parseFanout(withTask({ checks: undefined, gates: ["diff"] })).tasks[0].codeBrief).toBe(true);
      expect(parseFanout(withTask({ checks: undefined, scope: ["src/api"] })).tasks[0].codeBrief).toBe(true);
      expect(parseFanout(withTask({ checks: undefined })).tasks[0].codeBrief).toBe(false);
      // A project check's id asks for the checks gate, so it is code too (the gates `delegate` will be handed).
      expect(parseFanout(withTask({ checks: ["api-tests"] })).tasks[0].codeBrief).toBe(true);
    });

    it("refuses a bad line or list naming the task, and a line that names passes", () => {
      for (const [patch, says] of [
        [{ checks: [{ what: "w", command: "true", passes: true }] }, "passes"],
        [{ checks: [{ what: "w", command: "a\nb" }] }, "command is one line"],
        [{ checks: [{ what: "w" }] }, "the command that shows it"],
        [{ checks: [7] }, "{what, command, expect}"],
        [{ leave: ["../x"] }, "leaves the project"],
        [{ leave: "src" }, "list of paths"],
      ] as const) {
        const said = refusal(withTask(patch));
        expect(said.startsWith("Task api: "), said).toBe(true);
        expect(said, said).toContain(says);
      }
    });

    it("holds the project check ids to their own limit beside the lines", () => {
      const ids = Array.from({ length: 21 }, (_, i) => `c${i}`);
      expect(refusal(withTask({ checks: [...ids, line] }))).toContain("checks must be a list of at most 20");
    });
  });

  describe("a task's spec of record sections (PT-6)", () => {
    const part = { file: "docs/spec/score.md", section: "Score route", text: "GET /api/score answers 200 with the score." };
    const withTask = (patch: Record<string, unknown>) => {
      const input = plan();
      input.tasks[0] = { ...input.tasks[0], ...patch } as FanoutInput["tasks"][number];
      return input;
    };

    it("keeps the parts on the task, and they make it a code task whose round always runs", () => {
      const parsed = parseFanout(withTask({ checks: undefined, spec: [part] }));
      expect(parsed.tasks[0].spec).toEqual([part]);
      expect(parsed.tasks[0].gates).toEqual({ code: true });
      expect(parsed.tasks[0].codeBrief).toBe(true);
      // The project's own check ids stay beside them, and a task that sends none carries no spec at all.
      expect(parseFanout(withTask({ spec: [part] })).tasks[0].gates).toEqual({ gates: ["checks"], checks: ["api-tests"], code: true });
      expect("spec" in parseFanout(plan()).tasks[1]).toBe(false);
      expect("spec" in parseFanout(withTask({ spec: [] })).tasks[0]).toBe(false);
    });

    it("refuses a bad part naming the task, the part and what is wrong", () => {
      for (const [spec, says] of [
        [[{ ...part, file: "../x.md" }], "Spec part 1: "],
        [[{ ...part, file: "src/app.md" }], "isn't a spec file"],
        [[part, { ...part, section: "score  ROUTE" }], "named twice"],
        [[{ ...part, passes: true }], "isn't one"],
        [Array.from({ length: 4 }, (_, n) => ({ ...part, section: `S${n}` })), "at most 3 spec parts"],
        ["docs/spec/score.md", "must be a list"],
      ] as const) {
        const said = refusal(withTask({ spec }));
        expect(said.startsWith("Task api: "), said).toBe(true);
        expect(said, said).toContain(says);
      }
    });
  });

  it("refuses a requirement nothing provides, before anything starts, and names who and what", () => {
    const input = plan();
    input.tasks[1] = { ...input.tasks[1], requires: ["/api/scores"] };
    const why = refusal(input);
    expect(why).toContain('"/api/scores"');
    expect(why).toContain("board");
    expect(why).toMatch(/no task provides it/);
  });

  it("refuses a task that requires what it provides itself", () => {
    const input = plan();
    input.tasks[0] = { ...input.tasks[0], requires: ["/api/score"] };
    expect(refusal(input)).toMatch(/api.*requires "\/api\/score".*provides itself/);
  });

  it("refuses a provide nobody could check: a name with no file to look in", () => {
    const input = plan();
    input.tasks[0] = {
      ...input.tasks[0],
      owns: undefined,
      provides: [{ kind: "symbol", name: "ScoreService" }],
    };
    input.tasks[1] = { ...input.tasks[1], requires: ["ScoreService"] };
    const why = refusal(input);
    expect(why).toContain('"ScoreService"');
    expect(why).toMatch(/cannot be checked/);
    expect(why).toMatch(/\bin\b/);
  });

  it("accepts a provide that has somewhere to be looked for: in, an owned file, or a declared file", () => {
    const base = (patch: Record<string, unknown>) => {
      const input = plan();
      input.tasks[0] = { ...input.tasks[0], owns: undefined, provides: [{ kind: "symbol", name: "ScoreService" }], ...patch } as never;
      input.tasks[1] = { ...input.tasks[1], requires: ["ScoreService"] };
      return input;
    };
    expect(() => parseFanout(base({ provides: [{ kind: "symbol", name: "ScoreService", in: "src/api/score.ts" }] }))).not.toThrow();
    expect(() => parseFanout(base({ owns: ["src/api/score.ts"] }))).not.toThrow();
    expect(() => parseFanout(base({ files: ["src/api/score.ts"] }))).not.toThrow();
    // A glob is a pattern, never somewhere a name can be looked for.
    expect(refusal(base({ owns: ["src/api/**"] }))).toMatch(/cannot be checked/);
  });

  it("needs no place for a file: its name is the path", () => {
    const input = plan();
    input.tasks[0] = { ...input.tasks[0], owns: undefined, provides: [{ kind: "file", name: "src/api/score.ts" }] };
    input.tasks[1] = { ...input.tasks[1], requires: ["src/api/score.ts"] };
    expect(() => parseFanout(input)).not.toThrow();
  });

  it("refuses duplicate or malformed task names and two providers of one name", () => {
    const dup = plan();
    dup.tasks[1] = { ...dup.tasks[1], name: "api" };
    expect(refusal(dup)).toMatch(/Two tasks are named "api"/);
    const bad = plan();
    bad.tasks[1] = { ...bad.tasks[1], name: "the board" };
    expect(refusal(bad)).toMatch(/name must be letters, digits, - and _/);
    const twice = plan();
    twice.tasks[1] = { ...twice.tasks[1], provides: [{ kind: "endpoint", name: "/api/score", in: "src/ui/Board.tsx" }] };
    expect(refusal(twice)).toMatch(/"\/api\/score" is provided by both api and board/);
  });

  it("refuses two tasks that own the same path, or a path inside another's folder", () => {
    const same = plan();
    same.tasks[1] = { ...same.tasks[1], owns: ["src/api"] };
    expect(refusal(same)).toMatch(/src\/api.*owned by both api and board/);
    const inside = plan();
    inside.tasks[1] = { ...inside.tasks[1], owns: ["src/api/score.ts"] };
    expect(refusal(inside)).toMatch(/owned by both/);
  });

  it("keeps every path inside the project", () => {
    for (const path of ["/etc/passwd", "../outside.ts", "src/../../x.ts", "~/notes.md", "C:\\x.ts", ""]) {
      const input = plan();
      input.tasks[1] = { ...input.tasks[1], owns: [path] };
      expect(refusal(input), path).toMatch(/inside the project/);
    }
  });

  it("checks every task's brief and goal up front, naming the task", () => {
    const input = plan();
    input.tasks[1] = { ...input.tasks[1], goal: "TODO" };
    const why = refusal(input);
    expect(why).toMatch(/Task board:/);
    expect(why).toContain("definition of done (goal) is a placeholder");
    // The intent is shared, so a plan without one needs each task to bring its own.
    const none = plan({ intent: undefined });
    expect(refusal(none)).toMatch(/Task api: The intent \(intent\) is empty/);
  });

  it("refuses an unknown field instead of ignoring it, and bad input of every kind", () => {
    const typo = plan();
    (typo.tasks[0] as Record<string, unknown>).require = ["x"];
    expect(refusal(typo)).toMatch(/Unknown field "require" on task api/);
    expect(refusal(undefined)).toMatch(/tasks/);
    expect(refusal({ intent: INTENT, tasks: [] })).toMatch(/1 to 8 tasks/);
    expect(refusal({ intent: INTENT, tasks: "api" })).toMatch(/1 to 8 tasks/);
    expect(refusal({ ...plan(), surprise: true })).toMatch(/Unknown field "surprise"/);
    const bad = plan();
    bad.tasks[0] = { ...bad.tasks[0], provides: [{ kind: "thing", name: "x", in: "a.ts" }] };
    expect(refusal(bad)).toMatch(/kind must be one of/);
  });

  it("holds a fan-out to the first mate's cap of eight tasks", () => {
    expect(FANOUT_MAX_TASKS).toBe(8);
    const nine = {
      intent: INTENT,
      tasks: Array.from({ length: 9 }, (_, i) => ({ name: `t${i}`, brief: `Do part ${i} in src/p${i}.ts`, goal: `part ${i} works` })),
    };
    expect(refusal(nine)).toMatch(/1 to 8 tasks/);
    expect(() => parseFanout({ ...nine, tasks: nine.tasks.slice(0, 8) })).not.toThrow();
  });

  it("holds the same cap as the first mate's own, in Rust", () => {
    const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/firstmate/mod.rs"), "utf8");
    expect(Number(/pub const MAX_FANOUT: usize = (\d+);/.exec(rust)?.[1])).toBe(FANOUT_MAX_TASKS);
  });

  it("keeps the shared block every worker carries within its bound", () => {
    const input = plan();
    input.tasks[1] = { ...input.tasks[1], requires: undefined };
    input.tasks[0] = {
      ...input.tasks[0],
      provides: Array.from({ length: 60 }, (_, i) => ({ kind: "symbol" as const, name: `Name${i}`, in: "src/api/score.ts", shape: "x".repeat(190) })),
    };
    expect(refusal(input)).toMatch(/contract is too long/);
  });

  describe("cycles", () => {
    function cyclic(): FanoutInput {
      return {
        intent: INTENT,
        tasks: [
          { name: "a", brief: "Build a in src/a.ts", goal: "a works", owns: ["src/a.ts"], provides: [{ kind: "file", name: "src/a.ts" }], requires: ["src/b.ts"] },
          { name: "b", brief: "Build b in src/b.ts", goal: "b works", owns: ["src/b.ts"], provides: [{ kind: "file", name: "src/b.ts" }], requires: ["src/a.ts"] },
          { name: "c", brief: "Build c in src/c.ts", goal: "c works", owns: ["src/c.ts"] },
        ],
      };
    }

    it("finds the loop and names it", () => {
      const parsed = parseFanout(cyclic());
      expect(requiresCycle(parsed.tasks.map((task) => task.name), parsed.contract)).toBe("a → b → a");
    });

    it("runs the tasks anyway and warns, so one tangled plan never blocks the work", () => {
      const parsed = parseFanout(cyclic());
      expect(parsed.warnings).toEqual(["requires form a cycle (a → b → a), so the tasks run in one wave in the order given"]);
    });

    it("finds no cycle in a plan that only chains", () => {
      const parsed = parseFanout(plan());
      expect(requiresCycle(parsed.tasks.map((task) => task.name), parsed.contract)).toBeUndefined();
    });

    it("finds a longer loop and ignores the tasks outside it", () => {
      const input = cyclic();
      input.tasks = [
        { name: "a", brief: "Build a in src/a.ts", goal: "a works", provides: [{ kind: "file", name: "src/a.ts" }], requires: ["src/c.ts"] },
        { name: "b", brief: "Build b in src/b.ts", goal: "b works", provides: [{ kind: "file", name: "src/b.ts" }], requires: ["src/a.ts"] },
        { name: "c", brief: "Build c in src/c.ts", goal: "c works", provides: [{ kind: "file", name: "src/c.ts" }], requires: ["src/b.ts"] },
        { name: "d", brief: "Build d in src/d.ts", goal: "d works", requires: ["src/a.ts"] },
      ];
      const parsed = parseFanout(input);
      expect(requiresCycle(parsed.tasks.map((task) => task.name), parsed.contract)).toBe("a → c → b → a");
    });
  });

  describe("what a worker reads", () => {
    it("writes the shared block once for everyone: owners, provides, requires, checks, warnings", () => {
      const parsed = parseFanout(plan());
      const block = renderContractBlock(parsed.contract, parsed.warnings);
      expect(block).toContain("OWNERS (path, then the task that writes there; write only in paths you own)");
      expect(block).toContain("- src/api → api");
      expect(block).toContain("- [api] endpoint /api/score in src/api/score.ts: GET, returns { score: number }");
      expect(block).toContain("- [board] /api/score");
      expect(block).toContain("- [api] api-tests");
      expect(block).not.toMatch(/[\u2014\u2013]/);
    });

    it("says what this task owns, provides and may rely on, with the shape travelling to the consumer", () => {
      const parsed = parseFanout(plan());
      const board = renderContractForTask(parsed.contract, "board");
      expect(board).toContain("You own: src/ui/Board.tsx");
      expect(board).toContain("You provide: nothing listed");
      expect(board).toContain("You may rely on: /api/score (endpoint from api in src/api/score.ts): GET, returns { score: number }");
      const api = renderContractForTask(parsed.contract, "api");
      expect(api).toContain("You provide: endpoint /api/score in src/api/score.ts: GET, returns { score: number }; file src/api/score.ts");
      expect(api).toContain("You may rely on: nothing from the other parts");
    });

    it("describes a provide the same way everywhere", () => {
      expect(describeProvide({ task: "api", kind: "symbol", name: "HD.Ship", in: "js/ship.js", shape: "a class" })).toBe(
        "symbol HD.Ship in js/ship.js: a class",
      );
      expect(describeProvide({ task: "api", kind: "env", name: "SCORE_URL" })).toBe("env SCORE_URL");
    });
  });
});

// WP-141 LOW 8: a task's role reaches tasks.delegate, so the role rows apply to a fan-out's waves.
it("passes a task's role through to tasks.delegate", () => {
  const input = plan();
  (input.tasks[0] as unknown as Record<string, unknown>).role = "builder";
  const parsed = parseFanout(input);
  expect(parsed.tasks[0].passthrough).toMatchObject({ role: "builder" });
});
