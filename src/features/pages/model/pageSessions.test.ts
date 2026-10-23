// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { HubProject } from "../../hub/model/types";
import type { Block, Session } from "../../sessions/model/session";
import { pageSessionsHandlers, sessionsData } from "./pageSessions";

const projects: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/p/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/p/hivra" },
];
const session = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, harness: "claude", model: "opus", modelSettings: {}, runtimeMode: "default", title: id, cwd: "/p", blocks: [], ...over }) as Session;
const block = (role: "user" | "assistant", text: string, startedAt?: number): Block =>
  ({ id: `${role}-${text.slice(0, 8)}-${startedAt ?? 0}`, role, text, ...(startedAt !== undefined ? { startedAt } : {}) }) as Block;

it("leaves out the hub's own runs and anything the sidebar hides", () => {
  const rows = sessionsData(
    [
      session("shown"),
      session("worker", { ephemeral: true }),
      session("hidden", { sidebarHidden: true }),
      session("lead", { orchestrationLeadId: "vg-game-lead" }),
      session("ask", { inboxAsk: true }),
      session("habit", { automationId: "daily-summary" } as Partial<Session>),
    ],
    projects,
  );
  expect(rows.sessions.map((s) => s.id)).toEqual(["shown"]);
  expect(rows.total).toBe(1);
});

it("names the project whose folder a chat works in, and null for any other folder", () => {
  const rows = sessionsData(
    [
      session("exo", { cwd: "/p/vg-game" }),
      session("hivra", { cwd: "/p/hivra" }),
      session("elsewhere", { cwd: "/tmp/scratch" }),
      session("nowhere", { cwd: "" }),
    ],
    projects,
  );
  const byId = new Map(rows.sessions.map((s) => [s.id, s.project]));
  expect(byId.get("exo")).toBe("EXO");
  expect(byId.get("hivra")).toBe("Hivra");
  expect(byId.get("elsewhere")).toBeNull();
  expect(byId.get("nowhere")).toBeNull();
});

it("narrows to one project by id or by name, and says so when there is no such project", () => {
  const all = [session("exo", { cwd: "/p/vg-game" }), session("hivra", { cwd: "/p/hivra" })];
  expect(sessionsData(all, projects, { projectId: "hivra" }).sessions.map((s) => s.id)).toEqual(["hivra"]);
  expect(sessionsData(all, projects, { projectId: "exo" }).sessions.map((s) => s.id)).toEqual(["exo"]);
  expect(() => sessionsData(all, projects, { projectId: "nope" })).toThrow("There's no project called “nope”.");
});

it("gives the last line, one short line, and who said it", () => {
  const long = "a".repeat(200);
  const rows = sessionsData(
    [
      session("one", { blocks: [block("user", "Please look at the   build\nagain", 1_000), block("assistant", long, 2_000)] }),
      session("two", { blocks: [block("assistant", "Working on it", 1_000), block("user", "   ", 2_000)] }),
    ],
    projects,
  );
  const [one, two] = rows.sessions;
  expect(one).toMatchObject({ lastAt: 2_000, lastBy: "agent" });
  expect(one.lastLine).toBe(`${"a".repeat(159)}…`);
  expect(two).toMatchObject({ lastAt: 2_000, lastLine: "Working on it", lastBy: "agent" });
});

it("puts the newest chat first, and a chat with no time last", () => {
  const rows = sessionsData(
    [
      session("old", { blocks: [block("user", "hi", 1_000)] }),
      session("none"),
      session("new", { blocks: [block("user", "hi", 9_000)], busy: true }),
    ],
    projects,
  );
  expect(rows.sessions.map((s) => [s.id, s.working])).toEqual([
    ["new", true],
    ["old", false],
    ["none", false],
  ]);
});

it("returns 50 by default and never more than 200, but says how many there are", () => {
  const many = Array.from({ length: 260 }, (_, i) => session(`s${i}`, { blocks: [block("user", "hi", i + 1)] }));
  const byDefault = sessionsData(many, projects);
  expect(byDefault.sessions).toHaveLength(50);
  expect(byDefault.total).toBe(260);
  expect(byDefault.sessions[0].id).toBe("s259");
  expect(sessionsData(many, projects, { limit: 2 }).sessions.map((s) => s.id)).toEqual(["s259", "s258"]);
  expect(sessionsData(many, projects, { limit: 0 }).sessions).toHaveLength(1);
  expect(sessionsData(many, projects, { limit: 9_000 }).sessions).toHaveLength(200);
  expect(sessionsData(many, projects, { limit: "lots" }).sessions).toHaveLength(50);
});

it("answers sessions.read from the app's chats, and an empty list when there are none to read", async () => {
  const store = { snapshot: () => [session("exo", { cwd: "/p/vg-game", blocks: [block("user", "hi", 5_000)] })] };
  const handlers = pageSessionsHandlers(store, () => projects);
  await expect(handlers["sessions.read"]({})).resolves.toMatchObject({ total: 1, sessions: [{ id: "exo", project: "EXO" }] });
  await expect(pageSessionsHandlers(null, () => projects)["sessions.read"]({})).resolves.toEqual({ sessions: [], total: 0 });
});
