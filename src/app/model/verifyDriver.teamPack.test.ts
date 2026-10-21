// @vitest-environment happy-dom
// The realconv runner picks "Pre-load Ash's team" before scenes that play his Monos (G5: a fresh dev copy starts plain).
import { beforeEach, expect, it, vi } from "vitest";

const preload = vi.fn(async () => ["chief-of-staff"]);
vi.mock("./benchAshTeam", () => ({ benchAshTeam: () => preload() }));
vi.mock("../../features/hub/model/teamPack", () => ({ teamPack: () => (preload.mock.calls.length ? "ash" : "plain") }));

import { DriverLog, perform, type DriverHost } from "./verifyDriver";

const host = {} as DriverHost;
beforeEach(() => preload.mockClear());

it("pre-loads Ash's team the way onboarding does and says which souls it wrote", async () => {
  const answer = (await perform({ id: "1", op: "teamPack", pack: "ash" }, host, new DriverLog())) as { ok: boolean; pack: string; wrote: string[] };
  expect(preload).toHaveBeenCalledTimes(1);
  expect(answer).toEqual({ ok: true, pack: "ash", wrote: ["chief-of-staff"] });
});

it("takes only the Ash pre-load", async () => {
  const answer = (await perform({ id: "2", op: "teamPack", pack: "plain" }, host, new DriverLog())) as { ok: boolean; error: string };
  expect(answer.ok).toBe(false);
  expect(preload).not.toHaveBeenCalled();
});
