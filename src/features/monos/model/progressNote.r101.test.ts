// r101 (5): one grey progress line after ~10 quiet minutes, only when something moved; no Needs you.
import { expect, it } from "vitest";
import { progressNote, PROGRESS_QUIET_MS } from "./progressNote";
import type { Session } from "../../sessions/model/session";
import type { Delegation } from "./delegations";

const T0 = 1_000_000;
const chat = (blocks: Session["blocks"] = []): Session =>
  ({ id: "lead", busy: false, blocks: [{ id: "u1", role: "user", text: "dump", startedAt: T0 }, ...blocks] }) as unknown as Session;
const row = (id: string, state: Delegation["state"]): Delegation => ({ id, ownerSession: "lead", createdAt: T0 + 1, state }) as Delegation;

it("says what moved after five quiet minutes, as a plain grey line", () => {
  const rows = [row("a", "completed"), row("b", "completed"), row("c", "running"), row("d", "running"), row("e", "running")];
  const note = progressNote(chat(), rows, T0 + PROGRESS_QUIET_MS + 5);
  expect(note?.text).toBe("Still working: 2 of 5 jobs done.");
  expect(note?.role).toBe("system");
  expect(note?.notice).toBe("still-running");
  expect(note?.text).not.toMatch(/needs you/i);
});

it("reports unchanged work periodically, stays quiet before the interval, and stops with no work out", () => {
  const rows = [row("a", "completed"), row("c", "running")];
  expect(progressNote(chat(), rows, T0 + 60_000)).toBeUndefined();
  const first = progressNote(chat(), rows, T0 + PROGRESS_QUIET_MS + 5)!;
  expect(progressNote(chat([first]), rows, T0 + 3 * PROGRESS_QUIET_MS)?.text).toBe("No new worker report yet: 1 of 2 jobs finished; 1 running.");
  expect(progressNote(chat(), [row("c", "running")], T0 + PROGRESS_QUIET_MS + 5)?.text).toBe("No new worker report yet: 0 of 1 jobs finished; 1 running.");
  expect(progressNote(chat(), [row("a", "completed")], T0 + PROGRESS_QUIET_MS + 5)).toBeUndefined();
  const moved = [row("a", "completed"), row("c", "completed"), row("d", "running")];
  expect(progressNote(chat([first]), moved, T0 + 3 * PROGRESS_QUIET_MS)?.text).toBe("Still working: 2 of 3 jobs done.");
});

it("keeps reporting an active job after a later status question, without counting cancelled duplicates", () => {
  const c = chat([{ id: "later", role: "user", text: "How is it going?", startedAt: T0 + 1_000 }]);
  const rows = [row("active", "running"), row("duplicate", "cancelled")];
  const note = progressNote(c, rows, T0 + PROGRESS_QUIET_MS + 5)!;
  expect(note.text).toBe("No new worker report yet: 0 of 1 jobs finished; 1 running.");
  expect(progressNote(chat([note]), rows, T0 + PROGRESS_QUIET_MS + 100)).toBeUndefined();
});

it("keeps a completed sibling in the count after a later status question", () => {
  const c = chat([{ id: "status", role: "user", text: "How is it going?", startedAt: T0 + 30 }]);
  const a = { ...row("a", "running"), createdAt: T0 + 10 };
  const b = { ...row("b", "running"), createdAt: T0 + 20 };
  const first = progressNote(c, [a, b], T0 + PROGRESS_QUIET_MS + 50)!;
  expect(first.text).toBe("No new worker report yet: 0 of 2 jobs finished; 2 running.");
  const next = progressNote({ ...c, blocks: [...c.blocks, first] }, [{ ...a, state: "completed" }, b], T0 + 2 * PROGRESS_QUIET_MS + 100)!;
  expect(next.text).toBe("Still working: 1 of 2 jobs done.");
});

it("starts a new work cohort for an actual request about a progress bar", () => {
  const c = chat([{ id: "new-work", role: "user", text: "Add a progress bar", startedAt: T0 + 100 }]);
  const rows = [row("old", "completed"), { ...row("new", "running"), createdAt: T0 + 110 }];
  expect(progressNote(c, rows, T0 + PROGRESS_QUIET_MS + 200)?.text).toBe("No new worker report yet: 0 of 1 jobs finished; 1 running.");
});
