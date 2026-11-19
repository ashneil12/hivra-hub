// Property tests for the wave planner (WP-171) and the request ids of a fan-out. The example tests in fanoutWaves.test.ts
// pin chosen shapes; these state what must hold for any plan, and any order the tasks are given in.
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";
import { FANOUT_MAX_TASKS, type Contract } from "./fanoutContract";
import { planWaves, restartRequestId, taskRequestId } from "./fanoutWaves";

type Links = Pick<Contract, "provides" | "requires">;

/** Task `a` provides `f:a`; a task that requires another requires `f:<other>`. */
function contractOf(edges: readonly (readonly [string, string])[], names: readonly string[]): Links {
  return {
    provides: names.map((task) => ({ task, kind: "file" as const, name: `f:${task}` })),
    requires: edges.map(([task, needs]) => ({ task, name: `f:${needs}` })),
  };
}

const sizeArb = fc.integer({ min: 1, max: FANOUT_MAX_TASKS });
const namesOf = (n: number) => Array.from({ length: n }, (_, i) => `t${String(i)}`);

/** Tasks t0..t(n-1) in a random order, with edges only from a later t to an earlier one: always orderable. */
const dagArb = sizeArb.chain((n) => {
  const names = namesOf(n);
  const pairs = names.flatMap((a, i) => names.slice(0, i).map((b): [string, string] => [a, b]));
  return fc.record({
    order: fc.shuffledSubarray(names, { minLength: n, maxLength: n }),
    edges: fc.subarray(pairs),
  });
});

/** Any edges at all, self-requires and cycles included. */
const anyGraphArb = sizeArb.chain((n) => {
  const names = namesOf(n);
  return fc.record({
    order: fc.shuffledSubarray(names, { minLength: n, maxLength: n }),
    edges: fc.array(fc.tuple(fc.constantFrom(...names), fc.constantFrom(...names)), { maxLength: 20 }),
  });
});

const waveOf = (waves: string[][]) => new Map(waves.flatMap((wave, i) => wave.map((name): [string, number] => [name, i])));

test.prop([dagArb])("an orderable plan puts every task in exactly one wave, none empty, no cycle", ({ order, edges }) => {
  const plan = planWaves(order, contractOf(edges, order));
  expect(plan.cycle).toBeUndefined();
  expect(plan.waves.every((wave) => wave.length > 0)).toBe(true);
  expect(plan.waves.flat().sort()).toEqual([...order].sort());
});

test.prop([dagArb])("no task is in a wave before, or with, a task it waits for, and it waits for exactly what it requires", ({ order, edges }) => {
  const plan = planWaves(order, contractOf(edges, order));
  const at = waveOf(plan.waves);
  for (const [name, needs] of Object.entries(plan.after))
    for (const dep of needs) {
      expect(at.get(dep)!).toBeLessThan(at.get(name)!);
      expect(edges).toContainEqual([name, dep]);
    }
  for (const [task, needs] of edges) expect(plan.after[task]).toContain(needs);
});

test.prop([dagArb])("a task starts as early as it can: wave one waits for nothing, a later task waits for the wave just before", ({ order, edges }) => {
  const plan = planWaves(order, contractOf(edges, order));
  const at = waveOf(plan.waves);
  for (const name of order) {
    const needs = plan.after[name] ?? [];
    if (at.get(name) === 0) expect(needs).toEqual([]);
    else expect(needs.some((dep) => at.get(dep) === at.get(name)! - 1)).toBe(true);
  }
});

test.prop([dagArb, fc.nat()])("the waves do not depend on the order the tasks were given, and each wave keeps that order", ({ order, edges }, seed) => {
  const contract = contractOf(edges, order);
  const first = planWaves(order, contract);
  // Another order of the same tasks: a rotation by the seed, then reversed.
  const k = seed % order.length;
  const other = [...order.slice(k), ...order.slice(0, k)].reverse();
  const second = planWaves(other, contract);
  expect(second.waves.map((wave) => [...wave].sort())).toEqual(first.waves.map((wave) => [...wave].sort()));
  expect(second.after).toEqual(first.after);
  for (const [waves, given] of [[first.waves, order], [second.waves, other]] as const)
    for (const wave of waves) expect(wave).toEqual(given.filter((name) => wave.includes(name)));
});

test.prop([anyGraphArb])("never throws on any requires; a cycle is one wave of everything in the order given, ordering nothing", ({ order, edges }) => {
  const plan = planWaves(order, contractOf(edges, order));
  expect(plan.waves.flat().sort()).toEqual([...order].sort());
  if (plan.cycle !== undefined) {
    expect(plan.cycle).not.toBe("");
    expect(plan.waves).toEqual([order]);
    expect(plan.after).toEqual({});
  } else {
    const at = waveOf(plan.waves);
    for (const [name, needs] of Object.entries(plan.after)) for (const dep of needs) expect(at.get(dep)!).toBeLessThan(at.get(name)!);
  }
});

test.prop([anyGraphArb])("a cycle is reported exactly when the requires cannot be ordered", ({ order, edges }) => {
  // Reference: a task that can reach itself through the requires (a self-require is not a dependency).
  const deps = new Map<string, Set<string>>(order.map((name) => [name, new Set<string>()]));
  for (const [task, needs] of edges) if (task !== needs) deps.get(task)!.add(needs);
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean =>
    [...deps.get(from)!].some((next) => next === target || (!seen.has(next) && (seen.add(next), reaches(next, target, seen))));
  const cyclic = order.some((name) => reaches(name, name));
  expect(planWaves(order, contractOf(edges, order)).cycle !== undefined).toBe(cyclic);
});

const idPart = fc.string({ unit: fc.constantFrom(..."abcxyz019-_ "), minLength: 1, maxLength: 12 });

test.prop([fc.string({ maxLength: 150 }), fc.string({ maxLength: 150 }), fc.nat({ max: 99 })])(
  "a task's request ids stay within 100 characters, and a restart never takes a first start's id",
  (requestId, name, generation) => {
    const first = taskRequestId(requestId, name);
    const again = restartRequestId(requestId, name, generation);
    expect(first.length).toBeLessThanOrEqual(100);
    expect(again.length).toBeLessThanOrEqual(100);
    expect(first.startsWith("f")).toBe(true);
    expect(again.startsWith(`r${String(generation)}`)).toBe(true);
    expect(again).not.toBe(first);
  },
);

test.prop([idPart, idPart, idPart, idPart])("two different (plan, task) pairs never share a request id, however the dashes fall", (r1, n1, r2, n2) => {
  fc.pre(r1 !== r2 || n1 !== n2);
  expect(taskRequestId(r1, n1)).not.toBe(taskRequestId(r2, n2));
});
