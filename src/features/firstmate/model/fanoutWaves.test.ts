import { describe, expect, it } from "vitest";
import { parseFanout, type FanoutInput } from "./fanoutContract";
import {
  NEW_PLAN_GRACE_MS,
  dependencyVerdict,
  parseFanoutLink,
  planFanout,
  planWaves,
  taskRequestId,
  type DependencyLookup,
  type FanoutLink,
  type RowView,
  type Verification,
} from "./fanoutWaves";

const INTENT = "Ash asked for a score board with an API behind it.";

function task(name: string, extra: Record<string, unknown> = {}) {
  return { name, brief: `Build ${name} in src/${name}.ts`, goal: `${name} works`, ...extra };
}
/** A task that provides the file `src/<name>.ts` and requires the files of the tasks named. */
function part(name: string, needs: string[] = []) {
  return task(name, {
    provides: [{ kind: "file", name: `src/${name}.ts` }],
    requires: needs.map((other) => `src/${other}.ts`),
  });
}
const fanout = (...tasks: ReturnType<typeof task>[]): FanoutInput => ({ intent: INTENT, tasks });

describe("waves (WP-171)", () => {
  it("puts independent tasks in one wave, in the order given", () => {
    const parsed = parseFanout(fanout(part("a"), part("b"), part("c")));
    const plan = planWaves(["a", "b", "c"], parsed.contract);
    expect(plan.waves).toEqual([["a", "b", "c"]]);
    expect(plan.after).toEqual({});
    expect(plan.cycle).toBeUndefined();
  });

  it("makes a dependent wait for its provider, wave by wave", () => {
    const parsed = parseFanout(fanout(part("a"), part("b", ["a"]), part("c", ["b"])));
    const plan = planWaves(["a", "b", "c"], parsed.contract);
    expect(plan.waves).toEqual([["a"], ["b"], ["c"]]);
    expect(plan.after).toEqual({ b: ["a"], c: ["b"] });
  });

  it("runs what can run together and holds the join for both providers", () => {
    const parsed = parseFanout(fanout(part("a"), part("b", ["a"]), part("c", ["a"]), part("d", ["b", "c"])));
    const plan = planWaves(["a", "b", "c", "d"], parsed.contract);
    expect(plan.waves).toEqual([["a"], ["b", "c"], ["d"]]);
    expect(plan.after.d).toEqual(["b", "c"]);
  });

  it("orders by what is needed, not by position: a task that needs a later one waits for it", () => {
    const parsed = parseFanout(fanout(part("a", ["b"]), part("b"), part("c")));
    expect(planWaves(["a", "b", "c"], parsed.contract).waves).toEqual([["b", "c"], ["a"]]);
  });

  it("falls back to one wave in the order given when the requires form a cycle, and orders nothing", () => {
    const parsed = parseFanout(fanout(part("a", ["b"]), part("b", ["a"]), part("c")));
    const plan = planWaves(["a", "b", "c"], parsed.contract);
    expect(plan.waves).toEqual([["a", "b", "c"]]);
    expect(plan.after).toEqual({});
    expect(plan.cycle).toBe("requires form a cycle (a → b → a), so the tasks run in one wave in the order given");
  });
});

describe("a task's link to its fan-out (WP-171)", () => {
  const parsed = parseFanout(fanout(part("a"), part("b", ["a"])));

  it("names every task's worker chat and carries the contract, so a restart loses nothing", () => {
    const plan = planFanout(parsed, "mono-exo", "req1");
    expect(plan.links.map((link) => [link.name, link.wave, link.after])).toEqual([
      ["a", 1, []],
      ["b", 2, ["a"]],
    ]);
    const [a] = plan.links;
    expect(a.plan).toBe("req1");
    expect(a.tasks.a.session).toBe("app-mono-exo-req1-a");
    expect(a.tasks.b.session).toBe("app-mono-exo-req1-b");
    expect(a.contract).toEqual(parsed.contract);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  it("keeps a task's request id within the 100 characters a request id may have", () => {
    const long = "r".repeat(100);
    const id = taskRequestId(long, "x".repeat(40));
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(taskRequestId(long, "a")).not.toBe(taskRequestId(long, "b"));
    expect(taskRequestId("req1", "a")).toBe("req1-a");
  });

  it("reads a stored link back, and refuses one that is not a link", () => {
    const [, b] = planFanout(parsed, "mono-exo", "req1").links;
    expect(parseFanoutLink(JSON.parse(JSON.stringify(b)))).toEqual(b);
    for (const bad of [
      undefined,
      "x",
      { ...b, after: ["nobody"] },
      { ...b, name: "nobody" },
      { ...b, wave: 0 },
      { ...b, contract: { ...b.contract, provides: [{ task: "a", kind: "thing", name: "x" }] } },
      { ...b, tasks: { ...b.tasks, a: { session: 4, title: "a" } } },
    ])
      expect(() => parseFanoutLink(bad)).toThrow(/fan-out/);
  });

  it("checks owners, file names and in again when a stored link is read", () => {
    const parsed = parseFanout(
      fanout(
        task("a", {
          owns: ["src/api"],
          files: ["src/api/route.ts"],
          provides: [{ kind: "endpoint", name: "/api/score", in: "src/api/route.ts" }],
        }),
      ),
    );
    const [link] = planFanout(parsed, "mono-exo", "req1").links;
    const tamper = (edit: (contract: FanoutLink["contract"]) => void) => {
      const copy = JSON.parse(JSON.stringify(link)) as FanoutLink;
      edit(copy.contract);
      return copy;
    };
    // A name that is not a path is kept. A path written with ./ is the same path.
    const read = parseFanoutLink(tamper((contract) => {
      contract.provides[0].in = "./src/api/route.ts";
      contract.files.a = ["./src/api/route.ts"];
    }));
    expect(read.contract.provides[0]).toMatchObject({ name: "/api/score", in: "src/api/route.ts" });
    expect(read.contract.files.a).toEqual(["src/api/route.ts"]);
    expect(read.contract.owners).toEqual({ "src/api": "a" });
    for (const bad of ["../secret", "src/../../etc", "/etc/passwd", "~/.ssh/id", "C:/windows", "src\\secret", "src/\n/x"]) {
      expect(() => parseFanoutLink(tamper((contract) => { contract.owners = { [bad]: "a" }; }))).toThrow(/inside the project/);
      expect(() => parseFanoutLink(tamper((contract) => { contract.files = { a: [bad] }; }))).toThrow(/inside the project/);
      expect(() => parseFanoutLink(tamper((contract) => { contract.provides[0].in = bad; }))).toThrow(/inside the project/);
      expect(() => parseFanoutLink(tamper((contract) => { contract.provides[0].name = bad; contract.provides[0].kind = "file"; }))).toThrow(/inside the project/);
    }
  });
});

describe("what a waiting task waits for (WP-171)", () => {
  const parsed = parseFanout(fanout(part("a"), part("b", ["a"])));
  const [, link] = planFanout(parsed, "mono-exo", "req1").links;
  const provider = link.tasks.a.session;

  function lookup(
    row?: Partial<RowView>,
    options: { queued?: boolean; verified?: Verification; others?: Record<string, RowView> } = {},
  ): DependencyLookup {
    return {
      row: (session) => (session === provider ? (row as RowView | undefined) : options.others?.[session]),
      queued: (session) => session === provider && options.queued === true,
      verified: (session) => (session === provider ? options.verified : undefined),
    };
  }
  const done = { state: "completed", status: "done" } as const;

  it("is ready when nothing is waited for", () => {
    const [first] = planFanout(parsed, "mono-exo", "req1").links;
    expect(dependencyVerdict(first, lookup())).toBeUndefined();
  });

  it("waits while its provider works, or has not started", () => {
    const working = dependencyVerdict(link, lookup({ state: "running", status: "working" }));
    expect(working).toMatchObject({ reason: "requires" });
    expect(working!.line).toMatch(/^Waiting for a to finish and be checked/);
    expect(working!.line).toContain("It starts by itself then.");
    expect(dependencyVerdict(link, lookup(undefined, { queued: true }))).toMatchObject({ reason: "requires" });
  });

  it("waits for the check of what the provider made before it starts, then goes", () => {
    expect(dependencyVerdict(link, lookup(done))).toMatchObject({ reason: "requires" });
    expect(dependencyVerdict(link, lookup(done))!.line).toMatch(/checking what a provided/i);
    expect(dependencyVerdict(link, lookup(done, { verified: { ok: true, problems: [] } }))).toBeUndefined();
  });

  it("holds when what it was to provide is not there, and says what is missing", () => {
    const why = dependencyVerdict(link, lookup(done, { verified: { ok: false, problems: ["file src/a.ts does not exist"] } }));
    expect(why).toMatchObject({ reason: "held" });
    expect(why!.line).toContain("file src/a.ts does not exist");
    expect(why!.line).toMatch(/^Held: /);
  });

  it("never lets an unrun, pending, failed or unsure check pass", () => {
    const withCheck = parseFanout({
      intent: INTENT,
      tasks: [
        task("a", { provides: [{ kind: "file", name: "src/a.ts" }], checks: ["a-tests"] }),
        task("b", { requires: ["src/a.ts"] }),
      ],
    });
    const [, b] = planFanout(withCheck, "mono-exo", "req3").links;
    const session = b.tasks.a.session;
    const at = (gateVerdict: string | null | undefined, status: RowView["status"] = "done") =>
      dependencyVerdict(b, {
        row: (s) => (s === session ? ({ state: "completed", status, gateVerdict } as RowView) : undefined),
        queued: () => false,
        verified: () => ({ ok: true, problems: [] }),
      });
    expect(at("passed")).toBeUndefined();
    for (const verdict of [null, undefined, "pending", "failed", "unsure"]) {
      const held = at(verdict);
      expect(held, String(verdict)).toMatchObject({ reason: "held" });
      expect(held!.line).toContain("a-tests");
    }
  });

  it("holds a task that depends on a provider that failed, and tells the first mate what landed", () => {
    const plan = parseFanout(fanout(part("a"), part("b"), part("c", ["a", "b"]), part("d", ["a"])));
    const [a, b, c] = planFanout(plan, "mono-exo", "req4").links;
    const rows: Record<string, RowView> = {
      [a.tasks.a.session]: { state: "failed", error: "the build broke in src/a.ts", status: "failed" },
      [a.tasks.b.session]: { state: "completed", status: "done" },
    };
    const held = dependencyVerdict(c, {
      row: (s) => rows[s],
      queued: () => false,
      verified: () => ({ ok: true, problems: [] }),
    });
    expect(held).toMatchObject({ reason: "held" });
    expect(held!.line).toContain("a failed: the build broke in src/a.ts");
    expect(held!.line).toContain("Done and checked: b");
    expect(held!.line).toContain("Not started: c and d");
    expect(held!.line).toContain("task_cancel");
    expect(b.after).toEqual([]);
    expect(held!.line).not.toMatch(/[\u2014\u2013]/);
  });

  it("treats a stopped provider like a failed one", () => {
    const held = dependencyVerdict(link, lookup({ state: "cancelled", status: "failed" }));
    expect(held).toMatchObject({ reason: "held" });
    expect(held!.line).toContain("a was stopped");
  });

  it("holds when the provider cannot be found at all, instead of waiting forever", () => {
    const held = dependencyVerdict(link, lookup(undefined), link.at + NEW_PLAN_GRACE_MS);
    expect(held).toMatchObject({ reason: "held" });
    expect(held!.line).toMatch(/can't find a/);
  });

  it("reads a provider it cannot find as late to appear for a minute after the plan went out, then as gone", () => {
    const early = dependencyVerdict(link, lookup(undefined), link.at + 1_000);
    expect(early).toMatchObject({ reason: "requires" });
    expect(early!.line).toContain("looking for a's task");
    expect(dependencyVerdict(link, lookup(undefined), link.at + NEW_PLAN_GRACE_MS - 1)).toMatchObject({ reason: "requires" });
    expect(dependencyVerdict(link, lookup(undefined), link.at + NEW_PLAN_GRACE_MS)).toMatchObject({ reason: "held" });
  });

  it("stamps the plan with when it was sent", () => {
    expect(planFanout(parsed, "mono-exo", "req9", 12_345).links.map((entry) => entry.at)).toEqual([12_345, 12_345]);
  });

  it("lets a failure win over a provider that is still working", () => {
    const plan = parseFanout(fanout(part("a"), part("b"), part("c", ["a", "b"])));
    const [a, , c] = planFanout(plan, "mono-exo", "req5").links;
    const rows: Record<string, RowView> = {
      [a.tasks.a.session]: { state: "running", status: "working" },
      [a.tasks.b.session]: { state: "failed", status: "failed", error: "boom" },
    };
    expect(dependencyVerdict(c, { row: (s) => rows[s], queued: () => false, verified: () => undefined })).toMatchObject({ reason: "held" });
  });

  it("waits while the provider's own checks are still being decided", () => {
    for (const status of ["working", "needs-you"] as const) {
      const wait = dependencyVerdict(link, lookup({ state: "completed", status }));
      expect(wait, status).toMatchObject({ reason: "requires" });
    }
  });

  it("reads a finished row from before statuses existed as delivered unless its checks failed", () => {
    expect(dependencyVerdict(link, lookup({ state: "completed" }, { verified: { ok: true, problems: [] } }))).toBeUndefined();
    expect(dependencyVerdict(link, lookup({ state: "completed", gateVerdict: "failed" }))).toMatchObject({ reason: "held" });
  });
});
