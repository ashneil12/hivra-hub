// @vitest-environment happy-dom
// r59: hub:verify-live's teardown. The driver's `cleanup` archives exactly the chats it is given, through the sidebar's
// Archive (never Reset chat), and removes exactly the Monos it is given; nothing else in the window is touched.
import { beforeEach, expect, it, vi } from "vitest";
import { DriverLog, perform, type CleanupResult, type DriverHost } from "./verifyDriver";
import { listMonos } from "../../features/monos/model/mono";
import type { Session } from "../../features/sessions/model/session";

function roster(monos: { id: string; name: string }[]) {
  localStorage.setItem("monocode:mono-roster", JSON.stringify(monos.map((mono) => ({ ...mono, projects: [] }))));
}

beforeEach(() => localStorage.clear());

it("archives only the listed chats and removes only the listed Monos", async () => {
  roster([
    { id: "chief-of-staff", name: "Chief of Staff" },
    { id: "verify-lead", name: "Verify lead" },
    { id: "m-1", name: "Verify Marketing" },
  ]);
  const archive = vi.fn(async (id: string) => id !== "refused");
  const reset = vi.fn();
  const host = {
    sessions: () => [{ id: "a" }, { id: "b" }, { id: "ash-own" }] as Session[],
    archive,
    reset,
  } as unknown as DriverHost;
  const answer = (await perform(
    { id: "1", op: "cleanup", sessions: ["a", "b", "b", "refused"], monos: ["verify-lead", "m-1", "gone"] },
    host,
    new DriverLog(),
  )) as CleanupResult;
  expect(archive.mock.calls.map(([id]) => id)).toEqual(["a", "b", "refused"]);
  expect(reset).not.toHaveBeenCalled();
  expect(answer.archived).toEqual(["a", "b"]);
  expect(answer.removedMonos).toEqual(["verify-lead", "m-1"]);
  expect(answer.missing).toEqual(["gone"]);
  expect(answer.failed).toEqual([{ id: "refused", error: "archive refused" }]);
  expect(answer.ok).toBe(false);
  expect(listMonos().map((mono) => mono.id)).toContain("chief-of-staff");
  expect(listMonos().map((mono) => mono.id)).not.toContain("m-1");
});

it("touches nothing when given nothing", async () => {
  roster([{ id: "chief-of-staff", name: "Chief of Staff" }]);
  const archive = vi.fn(async () => true);
  const host = { sessions: () => [{ id: "a" }] as Session[], archive } as unknown as DriverHost;
  const answer = (await perform({ id: "1", op: "cleanup" }, host, new DriverLog())) as CleanupResult;
  expect(archive).not.toHaveBeenCalled();
  expect(answer).toMatchObject({ ok: true, archived: [], removedMonos: [], missing: [], failed: [] });
  expect(listMonos().map((mono) => mono.id)).toEqual(["chief-of-staff"]);
});
