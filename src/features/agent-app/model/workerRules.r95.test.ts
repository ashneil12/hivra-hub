// r95 item 2 (c02 BLIND 0774): one worker removed another worker's health route and test. Workers leave code they
// didn't write alone, even where their brief says not to add it, and say what looks wrong instead.
import { expect, it } from "vitest";
import { briefPrompt, workerRules } from "./agentAppTasks";

it("every worker is told its copy may hold siblings' work and not to remove code it didn't write", () => {
  const rules = workerRules(41001);
  expect(rules).toContain("Your checkout may already hold other workers' finished work.");
  expect(rules).toMatch(/Never remove or rewrite code you didn't write unless your brief names it, even where your brief says not to add it/);
  // It reaches the worker: the 0774 brief shape, with its rules after the brief.
  const prompt = briefPrompt("Tally coding team", "Reject a negative bump. Do not add the health route and do not edit the README.", undefined, undefined, rules);
  expect(prompt.indexOf("Do not add the health route")).toBeLessThan(prompt.indexOf("Never remove or rewrite code you didn't write"));
});
