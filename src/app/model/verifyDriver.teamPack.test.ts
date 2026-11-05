// @vitest-environment happy-dom
// The realconv runner picks "Pre-load Ash's team" before scenes that play his Monos (G5: a fresh dev copy starts plain).
import { beforeEach, expect, it, vi } from "vitest";

const preload = vi.fn(async () => ({ monos: [{ id: "ada", name: "Ada" }], wrote: ["ada"] }));
vi.mock("./benchAshTeam", () => ({ benchAshTeam: (...args: unknown[]) => preload(...args) }));
vi.mock("../../features/hub/model/teamPack", () => ({ teamPack: () => (preload.mock.calls.length ? "ash" : "plain") }));

import { DriverLog, perform, type DriverHost } from "./verifyDriver";

const host = {} as DriverHost;
beforeEach(() => preload.mockClear());

it("pre-loads Ash's team the way onboarding does and says which souls it wrote", async () => {
  const answer = (await perform({ id: "1", op: "teamPack", pack: "ash", project: "tally" }, host, new DriverLog())) as { ok: boolean; pack: string; wrote: string[]; monos: { id: string; name: string }[] };
  expect(preload).toHaveBeenCalledWith({ project: "tally" });
  expect(answer).toEqual({ ok: true, pack: "ash", wrote: ["ada"], monos: [{ id: "ada", name: "Ada" }] });
});

it("takes only the Ash pre-load, and only for a project", async () => {
  const plain = (await perform({ id: "2", op: "teamPack", pack: "plain", project: "tally" }, host, new DriverLog())) as { ok: boolean; error: string };
  expect(plain.ok).toBe(false);
  const noProject = (await perform({ id: "3", op: "teamPack", pack: "ash" }, host, new DriverLog())) as { ok: boolean; error: string };
  expect(noProject.ok).toBe(false);
  expect(noProject.error).toMatch(/project/);
  expect(preload).not.toHaveBeenCalled();
});
