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

it("Undo in Bot changes calls the backend to revert; when it isn't wired the row says so and stays", async () => {
  const { tauriHubTransport } = await import("../../hub/model/hubTransport");
  const { undoBotChange, redoBotChange } = await import("../../hub/model/botChanges");
  const { CHANGE_ACTIONS } = await import("./hubChange");
  const preview = { ...stubPreview(req), previewId: "pv-undo" };
  const ok = { call: vi.fn(async () => ({})) as never, openFeed: () => () => undefined };
  await applyChange("hub", preview, { transport: ok });
  const row = () => botChangeRows().flatMap((r) => (r.kind === "one" ? [r.change] : r.changes)).find((c) => c.hubChangeId === "pv-undo")!;

  const spy = vi.spyOn(tauriHubTransport, "call").mockResolvedValue({} as never);
  await undoBotChange([row().id]);
  expect(spy).toHaveBeenCalledWith(CHANGE_ACTIONS.undo, { previewId: "pv-undo" });
  expect(row().undone).toBe(true);
  await redoBotChange([row().id]);
  expect(spy).toHaveBeenCalledWith(CHANGE_ACTIONS.redo, { previewId: "pv-undo" });

  spy.mockRejectedValue(new HubCallError("unreachable", "down"));
  await undoBotChange([row().id]);
  expect(row().undone).toBeFalsy();
  expect(row().problem).toBe("Not connected yet, so nothing was undone.");
  spy.mockRestore();
});
