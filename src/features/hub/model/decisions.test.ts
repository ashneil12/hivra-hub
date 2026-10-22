// Settings > Decisions reads Ash OS's own primer text and the inbox's open asks (scorecard D2): a line's day, which
// layer it belongs to, and never-do rules apart from decisions.
import { beforeEach, expect, it } from "vitest";
import { forgetMemoryPrimers } from "./hubMemoryPrimer";
import { asksFrom, parseMemoryPrimer, projectDecisions } from "./decisions";
import type { Need } from "./types";

// Exactly the shape ashos/core.py memory_primer writes (22 Oct): a top sentence, the project's two headings, Ash's
// global layer under a heading that names it, then the footnote when lines did not fit.
const PRIMER = `Current memory of MonoCode Hub (hub) and how Ash works, as of 22 Oct 2026: what holds now. Ash's latest words beat it; it beats the code, docs and plans.

## MonoCode Hub: never do
- Never edit the main checkout directly. [16 Oct]
- Never launch a build of this app with the real HOME. [18 Oct]

## MonoCode Hub: decisions, newest first
- Ship is the only way a build reaches the app. [20 Oct]
- Long-chat tree memory is merged in.

## Ash (ash: Ash's global memory, every project): never do
- Codex is for image generation only. [15 Oct]

## Ash (ash: Ash's global memory, every project): decisions, newest first
- Bigger bot changes apply themselves and are logged with Undo. [14 Oct]

(3 more current lines did not fit here: they are in never.md and decisions.md in /Users/ash/agent-memory/hub and /Users/ash/agent-memory/ash.)`;

beforeEach(() => {
  forgetMemoryPrimers();
});

it("splits never-do rules from decisions, keeps the day, and marks Ash's global layer", () => {
  const { lines, more, empty } = parseMemoryPrimer(PRIMER);
  expect(lines).toEqual([
    { kind: "never", text: "Never edit the main checkout directly.", when: "16 Oct", global: false },
    { kind: "never", text: "Never launch a build of this app with the real HOME.", when: "18 Oct", global: false },
    { kind: "decision", text: "Ship is the only way a build reaches the app.", when: "20 Oct", global: false },
    { kind: "decision", text: "Long-chat tree memory is merged in.", global: false },
    { kind: "never", text: "Codex is for image generation only.", when: "15 Oct", global: true },
    { kind: "decision", text: "Bigger bot changes apply themselves and are logged with Undo.", when: "14 Oct", global: true },
  ]);
  expect(more).toBe(3);
  expect(empty).toBe(false);
});

it("a sentence that ends in brackets is left whole; an empty memory reads as empty, not as an error", () => {
  expect(parseMemoryPrimer("## Hub: decisions, newest first\n- Nothing broke today").lines[0]?.text).toBe("Nothing broke today");
  expect(parseMemoryPrimer("## Hub: decisions, newest first\n- Keep [the v2] theme").lines[0]).toMatchObject({
    text: "Keep [the v2] theme",
  });
  const nothing = parseMemoryPrimer("How Ash works (ash), as of 22 Oct 2026.\n\n(Nothing is in this memory yet.)");
  expect(nothing.lines).toEqual([]);
  expect(nothing.empty).toBe(true);
});

it("reads the project's memory through the primer call, and says so plainly when Ash OS can't answer", async () => {
  const seen: unknown[] = [];
  const call = async (action: string, payload: Record<string, unknown>) => {
    seen.push([action, payload]);
    return { project: "hub", text: PRIMER, lines: 6, more: 3, memory_dir: "/Users/ash/agent-memory/hub", global_dir: "/Users/ash/agent-memory/ash" };
  };
  const got = await projectDecisions("hub", { call });
  expect(seen).toEqual([["ash-hub-memory-primer", { project: "hub" }]]);
  expect(got?.lines).toHaveLength(6);
  expect(got?.memoryDir).toBe("/Users/ash/agent-memory/hub");

  forgetMemoryPrimers();
  expect(await projectDecisions("hub", { call: async () => Promise.reject(new Error("offline")) })).toBeUndefined();
});

it("open asks put what waits on Ash first and parked ones under them, keeping each list's order", () => {
  const need = (id: string, later?: true): Need => ({
    id,
    projectId: "hub",
    title: `Ask ${id}`,
    why: "why",
    actionType: "see_options",
    actionLabel: "See options",
    ...(later ? { later } : {}),
  });
  expect(asksFrom([need("a"), need("b", true), need("c")])).toEqual([
    { id: "a", title: "Ask a", why: "why", later: false },
    { id: "c", title: "Ask c", why: "why", later: false },
    { id: "b", title: "Ask b", why: "why", later: true },
  ]);
  expect(asksFrom([])).toEqual([]);
});
