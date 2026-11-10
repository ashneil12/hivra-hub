// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTABLE_LOOK_MS,
  flushNotableDue,
  noteNotable,
  type NotableDeps,
} from "./notableDelivery";
import { NOTABLE_FLUSH_MS, notableMemory, type NotablePing } from "./notableEvents";
import type { PingResult } from "./notifications";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const quiet = { enabled: true, start: "22:00", end: "08:00" };
const at = (hour: number, minute = 0) => new Date(2026, 10, 10, hour, minute, 30).getTime();

function setup(result: PingResult | Error = "shown") {
  const store = notableMemory();
  const sent: NotablePing[] = [];
  let clock = at(12, 0);
  let outcome = result;
  const deps: NotableDeps = {
    read: store.read,
    save: store.save,
    now: () => clock,
    quiet: () => quiet,
    send: async (ping) => {
      sent.push(ping);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return {
    deps,
    store,
    sent,
    at: (when: number) => {
      clock = when;
    },
    answer: (next: PingResult | Error) => {
      outcome = next;
    },
  };
}

const red = (id: string, text = "PR #42: checks failed", when = 1) => ({ id, kind: "ci-red", text, at: when });

beforeEach(() => localStorage.clear());

describe("sending the notable ping", () => {
  it("sends the first failure at once, and the next one only when the interval has passed", async () => {
    const run = setup();
    await noteNotable(red("a"), run.deps);
    expect(run.sent).toEqual([{ title: "CI failed", body: "CI failed: PR #42: checks failed" }]);
    expect(run.store.read().pending).toEqual([]);

    await noteNotable(red("b", "PR #43: checks failed", 2), run.deps);
    await noteNotable(red("c", "PR #44: checks failed", 3), run.deps);
    expect(run.sent).toHaveLength(1);
    expect(run.store.read().pending.map((item) => item.id)).toEqual(["b", "c"]);

    run.at(at(12, 0) + NOTABLE_FLUSH_MS);
    expect(await flushNotableDue(run.deps)).toBe("shown");
    expect(run.sent[1].title).toBe("2 programme notices");
    expect(run.store.read().pending).toEqual([]);
    expect(await flushNotableDue(run.deps)).toBeNull();
  });

  it("lets a failure through inside quiet hours and keeps a held notice until the window ends", async () => {
    const run = setup();
    run.at(at(23, 30));
    await noteNotable({ id: "held:s1:1", kind: "held", text: "Fix login: Claude finished", at: 1 }, run.deps);
    expect(run.sent).toEqual([]);

    await noteNotable(red("a"), run.deps);
    expect(run.sent.map((ping) => ping.title)).toEqual(["CI failed"]);
    expect(run.store.read().pending.map((item) => item.id)).toEqual(["held:s1:1"]);

    run.at(new Date(2026, 10, 11, 7, 59, 30).getTime());
    expect(await flushNotableDue(run.deps)).toBeNull();
    run.at(new Date(2026, 10, 11, 8, 0, 30).getTime());
    expect(await flushNotableDue(run.deps)).toBe("shown");
    expect(run.sent[1]).toEqual({ title: "While you were away", body: "Fix login: Claude finished" });
    expect(run.store.read().pending).toEqual([]);
  });

  it("does not bring a ping back that was not owed, but retries one the system refused", async () => {
    const off = setup("off");
    await noteNotable(red("a"), off.deps);
    expect(off.sent).toHaveLength(1);
    expect(off.store.read().pending).toEqual([]);

    const refused = setup("failed");
    await noteNotable(red("a"), refused.deps);
    expect(refused.store.read().pending.map((item) => item.id)).toEqual(["a"]);
    refused.answer("shown");
    refused.at(at(12, 0) + NOTABLE_FLUSH_MS);
    expect(await flushNotableDue(refused.deps)).toBe("shown");
    expect(refused.sent).toHaveLength(2);
    expect(refused.store.read().pending).toEqual([]);

    const broken = setup(new Error("native bridge gone"));
    await noteNotable(red("a"), broken.deps);
    expect(broken.store.read().pending.map((item) => item.id)).toEqual(["a"]);
  });

  it("drops an event it cannot read without sending anything", async () => {
    const run = setup();
    await noteNotable({ id: "", kind: "ci-red", text: "x", at: 1 }, run.deps);
    await noteNotable({ id: "x", kind: "email", text: "x", at: 1 }, run.deps);
    expect(run.sent).toEqual([]);
    expect(run.store.read().pending).toEqual([]);
  });

  it("looks about once a minute", () => {
    expect(NOTABLE_LOOK_MS).toBe(60_000);
  });
});
