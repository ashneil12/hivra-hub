// @vitest-environment happy-dom
// A Mono-chat scene's runtime mode (scripts/realconv/player.mjs scene.runtimeMode with place.mono): the driver sets it
// on that Mono's chat through the same send path a coding team's start uses, hands back the chat's earlier mode, and a
// `runtimeMode` action puts it back when the scene ends. Dev copies with a verify plan only.
import { expect, it, vi } from "vitest";
import { DriverLog, perform, type DriverHost } from "./verifyDriver";
import type { Session } from "../../features/sessions/model/session";

function hostWith(mode: Session["runtimeMode"] = "auto") {
  const sessions = [{ id: "frank-chat", title: "frank", runtimeMode: mode } as Session];
  const set: [string, string][] = [];
  const host = {
    sessions: () => sessions,
    openMono: vi.fn(async () => "frank-chat"),
    submit: vi.fn(() => true),
    setRuntimeMode: (sessionId: string, runtimeMode: Session["runtimeMode"]) => {
      set.push([sessionId, runtimeMode]);
      const row = sessions.find((session) => session.id === sessionId);
      if (row) row.runtimeMode = runtimeMode;
    },
  } as unknown as DriverHost;
  return { host, sessions, set };
}

it("sets a Mono-chat scene's mode on that Mono's chat and hands back its earlier mode", async () => {
  const { host, set } = hostWith("auto");
  const answer = (await perform({ id: "1", op: "send", to: { mono: "frank" }, text: "run the tests", runtimeMode: "full-access" }, host, new DriverLog())) as {
    session?: string;
    runtimeMode?: string;
    previousRuntimeMode?: string;
  };
  expect(set).toEqual([["frank-chat", "full-access"]]);
  expect(answer).toMatchObject({ session: "frank-chat", runtimeMode: "full-access", previousRuntimeMode: "auto" });
  expect(host.submit).toHaveBeenCalledWith("frank-chat", "run the tests");
});

it("leaves a Mono chat alone when the scene names no mode or one the bench doesn't know", async () => {
  const { host, set } = hostWith();
  for (const runtimeMode of [undefined, "yolo"]) {
    const answer = (await perform({ id: "1", op: "send", to: { mono: "frank" }, text: "run the tests", ...(runtimeMode ? { runtimeMode } : {}) }, host, new DriverLog())) as { runtimeMode?: string };
    expect(answer.runtimeMode).toBeUndefined();
  }
  expect(set).toEqual([]);
});

it("puts a Mono chat's earlier mode back when the scene ends", async () => {
  const { host, set } = hostWith("full-access");
  const answer = (await perform({ id: "1", op: "runtimeMode", session: "frank-chat", runtimeMode: "auto" }, host, new DriverLog())) as { ok?: boolean; runtimeMode?: string };
  expect(set).toEqual([["frank-chat", "auto"]]);
  expect(answer).toMatchObject({ ok: true, runtimeMode: "auto" });
});

it("refuses a mode it doesn't know and a chat that isn't open", async () => {
  const { host, set } = hostWith();
  const answer = (await perform({ id: "1", op: "runtimeMode", session: "frank-chat", runtimeMode: "yolo" }, host, new DriverLog())) as { ok?: boolean; error?: string };
  expect(answer.ok).toBe(false);
  await expect(perform({ id: "2", op: "runtimeMode", session: "gone", runtimeMode: "auto" }, host, new DriverLog())).rejects.toThrow(/no chat/);
  expect(set).toEqual([]);
});
