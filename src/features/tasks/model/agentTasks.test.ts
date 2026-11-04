import { describe, expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import { handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import { taskProjectOf } from "./agentTasks";

function hostFor(who: "one" | "two" | "team" | "none", taskStore?: AgentAppHost["taskStore"]): AgentAppHost {
  return {
    isMono: () => who !== "team" && who !== "none",
    codingTeamOf: () => (who === "team" ? { project: "hivra", name: "Hivra", folder: "/work/hivra" } : undefined),
    monoOf: () => {
      if (who === "one") return { id: "lead", projects: ["/work/hivra"] };
      if (who === "two") return { id: "lead", projects: ["/work/hivra", "/work/site"] };
      return undefined;
    },
    ...(taskStore ? { taskStore } : {}),
  } as unknown as AgentAppHost;
}

describe("taskProjectOf", () => {
  it("uses the coding team, else the Mono's only project", () => {
    const source = newSession("claude", "/work/hivra", "claude:opus-5-5");
    expect(taskProjectOf(source, hostFor("team"))).toBe("hivra");
    expect(taskProjectOf(source, hostFor("one"))).toBe("/work/hivra");
    expect(() => taskProjectOf(source, hostFor("two"))).toThrow("Name the project this task belongs to.");
    expect(() => taskProjectOf(source, hostFor("none"))).toThrow("Name the project this task belongs to.");
  });
});

describe("tasks.list", () => {
  it("asks as this chat, and refuses another project before the store", async () => {
    const source = { ...newSession("claude", "/work/hivra", "claude:opus-5-5"), id: "mono-hivra" };
    const taskStore = vi.fn(async () => [{ id: "task-1" }]);
    const host = hostFor("one", taskStore);
    await expect(handleAgentApp(source, "r1", "tasks.list", {}, host)).resolves.toEqual([{ id: "task-1" }]);
    expect(taskStore).toHaveBeenCalledWith("tasks_list", {
      actor: { id: "mono-hivra", project: "/work/hivra", kind: "agent" },
    });
    await expect(handleAgentApp(source, "r2", "tasks.create", { title: "A", project: "/work/site" }, host)).rejects.toThrow(
      "That project isn't this chat's.",
    );
    await expect(handleAgentApp(source, "r3", "tasks.list", { kind: "person" }, host)).rejects.toThrow(/Unknown tasks.list fields/);
  });

  it("says the store is missing, and a chat with no project never reaches it", async () => {
    const source = newSession("claude", "/work/hivra", "claude:opus-5-5");
    await expect(handleAgentApp(source, "r", "tasks.get", { id: "task-1" }, hostFor("one"))).rejects.toThrow(
      "Tasks aren't available in this chat.",
    );
    const taskStore = vi.fn();
    await expect(handleAgentApp(source, "r", "tasks.get", { id: "task-1" }, hostFor("two", taskStore))).rejects.toThrow(
      "Name the project this task belongs to.",
    );
    expect(taskStore).not.toHaveBeenCalled();
  });
});
