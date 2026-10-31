// r101 (5): one grey progress line after ~10 quiet minutes, only when something moved; no Needs you.
import { expect, it } from "vitest";
import { progressNote, PROGRESS_QUIET_MS } from "./progressNote";
import type { Session } from "../../sessions/model/session";
import type { Delegation } from "./delegations";

const T0 = 1_000_000;
const chat = (blocks: Session["blocks"] = []): Session =>
  ({ id: "lead", busy: false, blocks: [{ id: "u1", role: "user", text: "dump", startedAt: T0 }, ...blocks] }) as unknown as Session;
const row = (id: string, state: Delegation["state"]): Delegation => ({ id, ownerSession: "lead", createdAt: T0 + 1, state }) as Delegation;

it("says what moved after ten quiet minutes, as a plain grey line", () => {
  const rows = [row("a", "completed"), row("b", "completed"), row("c", "running"), row("d", "running"), row("e", "running")];
  const note = progressNote(chat(), rows, T0 + PROGRESS_QUIET_MS + 5);
  expect(note?.text).toBe("Still working: 2 of 5 jobs done.");
  expect(note?.role).toBe("system");
  expect(note?.notice).toBeUndefined();
  expect(note?.text).not.toMatch(/needs you/i);
});

it("stays silent when nothing moved, before ten minutes, or with no work out", () => {
  const rows = [row("a", "completed"), row("c", "running")];
  expect(progressNote(chat(), rows, T0 + 60_000)).toBeUndefined();
  const first = progressNote(chat(), rows, T0 + PROGRESS_QUIET_MS + 5)!;
  expect(progressNote(chat([first]), rows, T0 + 3 * PROGRESS_QUIET_MS)).toBeUndefined();
  expect(progressNote(chat(), [row("c", "running")], T0 + PROGRESS_QUIET_MS + 5)).toBeUndefined();
  expect(progressNote(chat(), [row("a", "completed")], T0 + PROGRESS_QUIET_MS + 5)).toBeUndefined();
  const moved = [row("a", "completed"), row("c", "completed"), row("d", "running")];
  expect(progressNote(chat([first]), moved, T0 + 3 * PROGRESS_QUIET_MS)?.text).toBe("Still working: 2 of 3 jobs done.");
});
