// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { HubCallError } from "../../hub/model/hubTransport";
import { botChangeRows } from "../../hub/model/botChanges";
import { applyChange, requestChange, SEATED_ONLY, stubPreview } from "./hubChange";

const roster = [{ id: "projects-manager" }];
const req = { flow: "hub" as const, projectId: "hivra", monoId: "projects-manager", prompt: "group my chats by week" };
beforeEach(() => localStorage.clear());

it("only a seated Mono may ask; temporary workers are turned away", async () => {
  expect(await requestChange({ ...req, monoId: "worker-1" }, { roster })).toEqual({ status: "turned-down", reason: SEATED_ONLY });
});

it("asks the backend for a preview build and shows Not connected yet when it isn't wired", async () => {
  const call = vi.fn(async () => { throw new HubCallError("unreachable", "down"); });
  const r = await requestChange(req, { roster, transport: { call: call as never, openFeed: () => () => undefined } });
  expect(call).toHaveBeenCalledWith("ash-hub-change-preview", req);
  expect(r.status).toBe("not-connected");
  for (const flow of ["today", "connect"] as const) {
    expect((await requestChange({ ...req, flow }, { roster, transport: { call: call as never, openFeed: () => () => undefined } })).status).toBe("not-connected");
  }
});

it("a valid preview comes back ready; Apply adds a Bot changes row with Undo", async () => {
  const preview = stubPreview(req);
  const call = vi.fn(async () => preview);
  const transport = { call: call as never, openFeed: () => () => undefined };
  const r = await requestChange(req, { roster, transport });
  expect(r.status).toBe("ready");
  expect(await applyChange("hub", preview, { transport })).toEqual({ status: "applied" });
  expect(call).toHaveBeenLastCalledWith("ash-hub-change-apply", { previewId: preview.previewId });
  expect(botChangeRows().some((row) => row.kind === "one" && row.change.hubChangeId === preview.previewId)).toBe(true);
});
