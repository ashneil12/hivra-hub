import { describe, expect, it, vi } from "vitest";
import { handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import { memoryId } from "../../memory/model/doc";
import { newSession } from "../../sessions/model/session";
import { EVERY_PROJECT_LINE } from "./scope";

const source = { ...newSession("claude", "/work/crew", "claude:opus-5-5"), id: "mono-crew" };

function host(over: Partial<AgentAppHost> = {}): AgentAppHost {
  return {
    isMono: () => true,
    monoOf: () => ({
      id: "coord",
      projects: ["/work/crew"],
      instructions: `# Soul\n${EVERY_PROJECT_LINE}\n`,
      everyProject: true,
    }),
    knownProjects: () => [
      { id: "crew", name: "Crew", folder: "/work/crew" },
      { id: "site", name: "Site", folder: "/work/site" },
    ],
    ...over,
  } as unknown as AgentAppHost;
}

describe("cross-project reads", () => {
  it("stays on its own project when the scope is off", async () => {
    const taskStore = vi.fn(async () => [{ id: "own" }]);
    const off = host({
      monoOf: () => ({ id: "coord", projects: ["/work/crew"], instructions: "# Soul\n" }),
      taskStore,
    });
    await expect(handleAgentApp(source, "r", "tasks.list", { project: "site" }, off)).rejects.toThrow(
      "That project isn't this chat's.",
    );
    expect(taskStore).not.toHaveBeenCalled();
  });

  it("reads every project, refuses a write, and files into a named one", async () => {
    const taskStore = vi.fn(async (command: string, args: { actor: { project: string }; id?: string }) => {
      if (command === "tasks_update") {
        if (args.actor.project === "site" || args.actor.project === "/work/site") throw new Error("wrong project");
        throw new Error("No task with that id.");
      }
      if (command === "tasks_get") {
        if (args.id === "t-site" && (args.actor.project === "site" || args.actor.project === "/work/site")) return { id: "t-site" };
        throw new Error("No task with that id.");
      }
      if (args.actor.project === "crew" || args.actor.project === "/work/crew") return [{ id: "t-crew" }];
      if (args.actor.project === "site" || args.actor.project === "/work/site") return [{ id: "t-site" }];
      return [];
    });
    const wide = host({ taskStore });
    const listed = await handleAgentApp(source, "r1", "tasks.list", {}, wide);
    expect(listed).toEqual([{ id: "t-crew" }, { id: "t-site" }]);
    await expect(handleAgentApp(source, "r2", "tasks.get", { id: "t-site" }, wide)).resolves.toEqual({ id: "t-site" });
    await expect(handleAgentApp(source, "r3", "tasks.create", { title: "Write the notes", project: "Site" }, wide)).resolves.toEqual([
      { id: "t-site" },
    ]);
    const created = taskStore.mock.calls.find((call) => call[0] === "tasks_create");
    expect(created?.[1]).toMatchObject({ actor: { project: "site", kind: "agent" }, input: { project: "site", title: "Write the notes" } });
    await expect(handleAgentApp(source, "r4", "tasks.create", { title: "Nope", project: "../daily" }, wide)).rejects.toThrow(
      "Not a project on this copy.",
    );
    await expect(handleAgentApp(source, "r5", "tasks.update", { id: "t-site", version: 1, comment: "no" }, wide)).rejects.toThrow(
      "No task with that id.",
    );
    const updates = taskStore.mock.calls.filter((call) => call[0] === "tasks_update");
    expect(updates.map((call) => call[1].actor.project)).toEqual(["crew", "/work/crew"]);
  });

  it("reads pages across projects and refuses to write one", async () => {
    const docs = {
      list: vi.fn(async () => [
        { id: "crew-plan", title: "Crew plan", slug: "crew-plan", parentId: null, updatedAt: 1, trashedAt: null, sourceCwd: "/work/crew", body: "notes" },
        { id: "site-spec", title: "Site spec", slug: "site-spec", parentId: null, updatedAt: 2, trashedAt: null, sourceCwd: "/work/site", body: "spec" },
        { id: "daily", title: "Daily", slug: "daily", parentId: null, updatedAt: 3, trashedAt: null, sourceCwd: "/daily/app", body: "no" },
      ]),
      get: vi.fn(async (id: string) => ({ id, title: id, body: "page", trashedAt: null, sourceCwd: id === "site-spec" ? "/work/site" : "/daily/app" })),
      create: vi.fn(async () => ({ page: { id: "new-page", title: "X", slug: "x" } })),
      update: vi.fn(),
    };
    const wide = host({ docs });
    const listed = await handleAgentApp(source, "r", "docs.list", {}, wide);
    expect(listed).toEqual([
      { id: "crew-plan", title: "Crew plan", slug: "crew-plan", parentId: null, updatedAt: 1 },
      { id: "site-spec", title: "Site spec", slug: "site-spec", parentId: null, updatedAt: 2 },
    ]);
    await expect(handleAgentApp(source, "r", "docs.get", { id: "site-spec" }, wide)).resolves.toMatchObject({ id: "site-spec", untrusted: true });
    await expect(handleAgentApp(source, "r", "docs.get", { id: "daily" }, wide)).rejects.toThrow("Page was not found");
    await expect(handleAgentApp(source, "r", "docs.create", { title: "X", markdown: "Y", project: "site" }, wide)).rejects.toThrow(
      "That project isn't this chat's.",
    );
    expect(docs.create).not.toHaveBeenCalled();
    await expect(handleAgentApp(source, "own", "docs.create", { title: "X", markdown: "Y", project: "crew" }, wide)).resolves.toMatchObject({
      id: "new-page",
    });
    expect(docs.create).toHaveBeenCalledWith(expect.objectContaining({ sourceCwd: "/work/crew" }));
  });

  it("reads activity on this copy, and a timeout is not an empty log", async () => {
    const activityList = vi.fn(async () => ({ entries: [{ id: "a1", kind: "ship", summary: "Shipped", at: 1, project: "site", link: "task:t-site" }] }));
    const wide = host({ activityList });
    const page = await handleAgentApp(source, "r", "activity.list", {}, wide);
    expect(page).toMatchObject({ untrusted: true, entries: [{ id: "a1" }] });
    expect(activityList.mock.calls[0][0]).not.toHaveProperty("project");
    activityList.mockRejectedValueOnce(new Error("timed out"));
    await expect(handleAgentApp(source, "r", "activity.list", { project: "Site" }, wide)).rejects.toThrow("timed out");
    const off = host({
      monoOf: () => ({ id: "coord", projects: ["/work/crew"] }),
      activityList,
    });
    await expect(handleAgentApp(source, "r", "activity.list", { project: "site" }, off)).rejects.toThrow(
      "That project isn't this chat's.",
    );
  });

  it("recalls another mono's memory only when the scope is on", async () => {
    const fact = (mateId: string, text: string) => ({
      id: memoryId([mateId, text]),
      mateId,
      action: "add",
      text,
      state: "confirmed",
      source: { kind: "turn", ref: "turn-1", label: "chat" },
      evidence: "said in chat",
      support: 3,
      against: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const memoryDoc = vi.fn(async () => ({
      revision: 1,
      generation: 0,
      items: [fact("coord", "Crew keeps the notes."), fact("other", "Site uses the notes.")],
      doneTurns: [],
      imports: {},
    }));
    const wide = host({ memoryDoc, mateIds: () => ["coord", "other"], now: () => new Date(1) });
    const recalled = await handleAgentApp(source, "r", "memory.recall", { query: "notes" }, wide);
    expect(JSON.stringify(recalled)).toContain("Site uses the notes.");
    expect(JSON.stringify(recalled)).toContain("untrusted");
    const off = host({
      monoOf: () => ({ id: "coord", projects: ["/work/crew"] }),
      memoryDoc,
      mateIds: () => ["coord", "other"],
      now: () => new Date(1),
    });
    const own = await handleAgentApp(source, "r", "memory.recall", { query: "notes" }, off);
    expect(JSON.stringify(own)).toContain("Crew keeps the notes.");
    expect(JSON.stringify(own)).not.toContain("Site uses the notes.");
  });

  it("counts what memory.recall read as used, and a miss does not fail the read", async () => {
    const fact = (mateId: string, text: string) => ({
      id: memoryId([mateId, text]),
      mateId,
      action: "add",
      text,
      state: "confirmed",
      source: { kind: "turn", ref: "turn-1", label: "chat" },
      evidence: "said in chat",
      support: 1,
      against: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const memoryDoc = vi.fn(async () => ({
      revision: 1,
      generation: 0,
      items: [fact("coord", "Crew keeps the notes."), fact("coord", "Reviews run on Fridays.")],
      doneTurns: [],
      imports: {},
    }));
    const markMemoryUsed = vi.fn(async () => true);
    const own = host({
      monoOf: () => ({ id: "coord", projects: ["/work/crew"] }),
      memoryDoc,
      markMemoryUsed,
      now: () => new Date(50),
    });
    const read = await handleAgentApp(source, "r", "memory.recall", { query: "notes" }, own);
    expect(JSON.stringify(read)).toContain("Crew keeps the notes.");
    expect(markMemoryUsed).toHaveBeenCalledTimes(1);
    const [ids, at] = markMemoryUsed.mock.calls[0] as unknown as [string[], number];
    expect(ids).toEqual([memoryId(["coord", "Crew keeps the notes."])]);
    expect(at).toBe(50);

    // A query that recalls nothing is not a use, and a store that is away does not fail the read.
    markMemoryUsed.mockClear();
    const miss = await handleAgentApp(source, "r", "memory.recall", { query: "zzzz" }, own);
    expect(JSON.stringify(miss)).not.toContain("notes");
    expect(markMemoryUsed).not.toHaveBeenCalled();
    const away = host({
      monoOf: () => ({ id: "coord", projects: ["/work/crew"] }),
      memoryDoc,
      markMemoryUsed: async () => {
        throw new Error("busy");
      },
      now: () => new Date(50),
    });
    await expect(handleAgentApp(source, "r", "memory.recall", { query: "notes" }, away)).resolves.toBeTruthy();
  });

  it("updates a task filed under the hub id, and still one filed under the folder", async () => {
    const rows = new Map<string, string>([["task-old", "/work/crew"]]);
    const taskStore = vi.fn(async (command: string, args: { actor: { project: string }; input?: { id?: string; project?: string } }) => {
      if (command === "tasks_create") {
        const project = args.actor.project;
        rows.set("task-new", project);
        return { id: "task-new" };
      }
      if (command === "tasks_update") {
        const id = args.input?.id ?? "";
        if (rows.get(id) !== args.actor.project) throw new Error("No task with that id.");
        return { id };
      }
      return [];
    });
    const wide = host({ taskStore });
    await handleAgentApp(source, "c", "tasks.create", { title: "Write the notes", project: "crew" }, wide);
    expect(rows.get("task-new")).toBe("crew");
    await expect(handleAgentApp(source, "u1", "tasks.update", { id: "task-new", version: 1, title: "Write the notes" }, wide)).resolves.toEqual({
      id: "task-new",
    });
    await expect(handleAgentApp(source, "u3", "tasks.update", { id: "task-old", version: 1, title: "Old" }, wide)).resolves.toEqual({
      id: "task-old",
    });
    const updates = taskStore.mock.calls.filter((call) => call[0] === "tasks_update");
    expect(updates.some((call) => call[1].actor.project === "site" || call[1].actor.project === "/work/site")).toBe(false);
  });

  it("refuses to update a task into another project, and a timeout is not a miss", async () => {
    let updates = 0;
    const taskStore = vi.fn(async (command: string) => {
      if (command === "tasks_update") {
        updates += 1;
        throw new Error("timed out");
      }
      return [];
    });
    const wide = host({ taskStore });
    await expect(handleAgentApp(source, "r", "tasks.update", { id: "task-new", version: 1, project: "site" }, wide)).rejects.toThrow(
      "Unknown tasks.update fields: project",
    );
    expect(updates).toBe(0);
    await expect(handleAgentApp(source, "r", "tasks.update", { id: "task-new", version: 1, title: "Again" }, wide)).rejects.toThrow(
      "timed out",
    );
    expect(updates).toBe(1);
  });
});
