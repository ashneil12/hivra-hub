// @vitest-environment happy-dom
// H8 with E5: a new worker waits only while every account it may use is out, and knows when the first comes back.
import { describe, expect, it } from "vitest";
import { markAccountLimited, orderedAccounts, providerRoom, workerRoom } from "./accountWaterfall";
import type { ProviderAccount } from "./providerAccounts";

const account = (id: string) => ({ id, provider: "claude", label: id }) as unknown as ProviderAccount;
const order = [account("default"), account("work")];
const usageFor = () => undefined;

describe("providerRoom", () => {
  it("has room while any account in Ash's order has room (the waterfall takes the worker there)", () => {
    const marks = { "claude:default": { at: 0, until: 9_000 } };
    expect(providerRoom("claude", { order, enabled: true, now: 1_000, usageFor, marks })).toEqual({ room: true });
  });

  it("has none when every account is out, until the first one resets", () => {
    const marks = { "claude:default": { at: 0, until: 9_000 }, "claude:work": { at: 0, until: 4_000 } };
    expect(providerRoom("claude", { order, enabled: true, now: 1_000, usageFor, marks })).toEqual({ room: false, provider: "Claude", until: 4_000 });
  });

  it("with the waterfall off, only the first account counts", () => {
    const marks = { "claude:default": { at: 0, until: 9_000 } };
    expect(providerRoom("claude", { order, enabled: false, now: 1_000, usageFor, marks })).toEqual({ room: false, provider: "Claude", until: 9_000 });
  });

  it("an account back from its reset has room again", () => {
    const marks = { "claude:default": { at: 0, until: 900 } };
    expect(providerRoom("claude", { order: order.slice(0, 1), enabled: true, now: 1_000, usageFor, marks })).toEqual({ room: true });
  });
});

describe("workerRoom", () => {
  it("a spent Claude account holds Claude Code workers back, but not while Claude Code runs on Grok 4.7", () => {
    const [first] = orderedAccounts("claude");
    markAccountLimited(first, { now: 1_000, resetsAt: 9_000_000 });
    expect(workerRoom("claude", { now: 2_000, usageFor })).toMatchObject({ room: false, provider: "Claude" });
    expect(workerRoom("claude", { now: 2_000, usageFor, elsewhere: true })).toEqual({ room: true });
  });
});
