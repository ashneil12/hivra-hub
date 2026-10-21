// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import { appActions, handleAgentApp, type AgentAppHost } from "./agentApp";

function fixture(options: { on?: boolean; habit?: boolean; mono?: boolean } = {}) {
  const source = newSession("claude", "/tmp/project", "claude:test");
  source.id = "chat";
  const zoom = vi.fn(async (_m: string, id: number, n: number, at: number) => `${id}+${n}@${at}`);
  const date = vi.fn(async () => "2026-10-21 18:02:11");
  const host = {
    isMono: (id: string) => (options.mono ?? true) && id === "chat",
    isHabitRun: () => options.habit === true,
    monoOf: (id: string) => (id === "chat" ? { id: "hivra", projects: [] } : undefined),
    tree: { on: () => options.on ?? true, zoom, date },
  } as unknown as AgentAppHost;
  const run = (action: string, input: Record<string, unknown> = {}) => handleAgentApp(source, `req-${Math.random()}`, action, input, host);
  return { run, zoom, date };
}

it("lists tree.zoom and tree.date among the app's actions", () => {
  expect(appActions()).toEqual(expect.arrayContaining(["tree.zoom", "tree.date"]));
});

it("zooms and dates a long-chat Mono's own tree from its own chat", async () => {
  const { run, zoom } = fixture();
  expect(await run("tree.zoom", { id: 12, n: 4 })).toEqual({ lines: "12+4@0" });
  expect(await run("tree.zoom", { id: 12 })).toEqual({ lines: "12+1@0" });
  expect(await run("tree.date", { id: 12 })).toEqual({ date: "2026-10-21 18:02:11" });
  expect(zoom).toHaveBeenCalledWith("hivra", 12, 1, 0);
  await expect(run("tree.zoom", { id: -1 })).rejects.toThrow("whole number");
  await expect(run("tree.zoom", { id: 1, n: 2, page: 3 })).rejects.toThrow("Unknown tree.zoom fields");
});

it("refuses workers, habit runs and Monos without the long chat", async () => {
  await expect(fixture({ mono: false }).run("tree.zoom", { id: 0 })).rejects.toThrow("only be read from a Mono's own chat");
  await expect(fixture({ habit: true }).run("tree.date", { id: 0 })).rejects.toThrow("only be read from a Mono's own chat");
  await expect(fixture({ on: false }).run("tree.zoom", { id: 0 })).rejects.toThrow("doesn't keep one long chat");
});
