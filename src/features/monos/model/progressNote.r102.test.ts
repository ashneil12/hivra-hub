// r102 (5): one long job still at 0 of 1 gets a grey line saying what it is doing, only when the worker's words moved.
import { expect, it } from "vitest";
import { progressNote, PROGRESS_QUIET_MS, workerLineOf } from "./progressNote";
import type { Session } from "../../sessions/model/session";
import type { Delegation } from "./delegations";

const T0 = 1_000_000;
const chat = (blocks: Session["blocks"] = []): Session =>
  ({ id: "lead", busy: false, blocks: [{ id: "u1", role: "user", text: "dump", startedAt: T0 }, ...blocks] }) as unknown as Session;
const job = { id: "j", ownerSession: "lead", createdAt: T0 + 1, state: "running", childSession: "w", title: "the hub screen fixes" } as Delegation;

it("says what the one job is doing once its worker said something new", () => {
  const said = { text: "Independent screen fixes are in. I'll commit each one on its own.", at: T0 + 5 * 60_000 };
  const note = progressNote(chat(), [job], T0 + PROGRESS_QUIET_MS + 5, () => said)!;
  expect(note.text).toBe("Still working on the hub screen fixes: Independent screen fixes are in.");
  expect(note.role).toBe("system");
  // The same words again: silent.
  expect(progressNote(chat([note]), [job], T0 + 3 * PROGRESS_QUIET_MS, () => said)?.text).toBe("No new worker report yet: 0 of 1 jobs finished; 1 running.");
  // New words after the note: a new line.
  const later = { text: "All twelve are committed; wiring the App changes.", at: T0 + 2 * PROGRESS_QUIET_MS };
  expect(progressNote(chat([note]), [job], T0 + 3 * PROGRESS_QUIET_MS, () => later)?.text).toBe(
    "Still working on the hub screen fixes: All twelve are committed; wiring the App changes.",
  );
});

it("reports that no worker report has arrived at 0 of 1", () => {
  expect(progressNote(chat(), [job], T0 + PROGRESS_QUIET_MS + 5, () => undefined)?.text).toBe("No new worker report yet: 0 of 1 jobs finished; 1 running.");
});

it("reads the worker's newest finished words, not a tool row or a streaming one", () => {
  const w = {
    blocks: [
      { id: "1", role: "assistant", text: "Reading the screens.", startedAt: 5 },
      { id: "2", role: "assistant", text: "", tool: { name: "Read" }, startedAt: 6 },
      { id: "3", role: "assistant", text: "half", streaming: true, startedAt: 7 },
    ],
  } as unknown as Session;
  expect(workerLineOf(w)).toEqual({ text: "Reading the screens.", at: 5 });
});
