// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { botChangeRows } from "../../hub/model/botChanges";
import { applyChange, requestChange, SEATED_ONLY, stubPreview } from "./hubChange";

const roster = [{ id: "bo" }];
const req = { flow: "hub" as const, projectId: "hivra", monoId: "bo", prompt: "group my chats by week" };
beforeEach(() => localStorage.clear());

it("only a seated Mono may ask; temporary workers are turned away", async () => {
  expect(await requestChange({ ...req, monoId: "worker-1" }, { roster })).toEqual({ status: "turned-down", reason: SEATED_ONLY });
});

it("outside the dev stub every flow says Not connected: preview builds ran in Ash OS, which is retired (WP-04)", async () => {
  for (const flow of ["hub", "today", "connect"] as const) {
    const r = await requestChange({ ...req, flow }, { roster, stub: false });
    expect(r.status).toBe("not-connected");
  }
  expect((await applyChange("hub", stubPreview(req), { stub: false })).status).toBe("not-connected");
});

it("in the dev stub a preview comes back ready; Apply adds a Bot changes row", async () => {
  const r = await requestChange(req, { roster, stub: true });
  expect(r.status).toBe("ready");
  if (r.status !== "ready") return;
  expect(await applyChange("hub", r.preview, { stub: true })).toEqual({ status: "applied" });
  expect(botChangeRows().some((row) => row.kind === "one" && row.change.hubChangeId === r.preview.previewId)).toBe(true);
});
