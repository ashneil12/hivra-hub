// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import {
  WORKER_REASON,
  applyProgrammeLoad,
  collectProgramme,
  handleProgramme,
  programmeGroup,
  readPackage,
  type ProgrammePackage,
} from "./programme";

function session(): Session {
  return { ...newSession("claude", "/work/crew"), id: "chat-1" };
}

function bare(extra: Partial<AgentAppHost> = {}): AgentAppHost {
  const unused = async () => {
    throw new Error("unused");
  };
  return {
    start: unused,
    sessions: unused,
    session: async () => null,
    send: unused,
    draft: unused,
    stop: unused,
    remove: unused,
    worktrees: unused,
    createWorktree: unused,
    notes: async () => [],
    note: async () => null,
    saveNote: unused,
    isMono: () => false,
    agentFiles: unused,
    readAgentFile: unused,
    writeAgentFile: unused,
    ...extra,
  };
}

function row(patch: Partial<ProgrammePackage> = {}): ProgrammePackage {
  return {
    id: "programme-1",
    projectId: "crew",
    wp: "WP-159",
    title: "Queue the programme",
    briefPath: "docs/my briefs/note.md",
    branch: "wp/159-programme-queue",
    status: "queued",
    securityPark: false,
    priority: 0,
    notes: "",
    parkReason: null,
    version: 1,
    createdAt: 10,
    updatedAt: 10,
    claimedAt: null,
    finishedAt: null,
    ...patch,
  };
}

describe("programme rows", () => {
  it("drops a row that is not a package and keeps a path with spaces", () => {
    expect(readPackage(null)).toBeUndefined();
    expect(readPackage({ ...row(), status: "nope" })).toBeUndefined();
    expect(readPackage({ ...row(), title: "" })).toBeUndefined();
    expect(readPackage({ ...row(), notes: "a".repeat(2001) })).toBeUndefined();
    expect(readPackage(row())?.briefPath).toBe("docs/my briefs/note.md");
  });

  it("puts a security park with the parked rows and hides a merged one", () => {
    expect(programmeGroup(row({ securityPark: true }))).toBe("parked");
    expect(programmeGroup(row({ status: "parked", parkReason: "Wait" }))).toBe("parked");
    expect(programmeGroup(row({ status: "building" }))).toBe("flight");
    expect(programmeGroup(row({ status: "pr_open" }))).toBe("flight");
    expect(programmeGroup(row({ status: "failed" }))).toBe("failed");
    expect(programmeGroup(row({ status: "merged" }))).toBeUndefined();
  });

  it("keeps the last rows when a read fails, and drops junk", async () => {
    const missed = await collectProgramme(["crew"], async () => {
      throw new Error("timed out");
    });
    expect(missed).toEqual({ unavailable: true });
    const empty = await collectProgramme(["crew", "notes"], async () => null);
    expect(empty).toEqual({ rows: [] });
    const mixed = await collectProgramme(["crew", "notes"], async (project) => {
      if (project === "notes") return [{ ...row({ id: "programme-2", projectId: "notes", priority: 2 }), extra: true }, { nope: 1 }];
      return [row({ priority: 1 })];
    });
    expect(mixed).toEqual({ rows: [row({ id: "programme-2", projectId: "notes", priority: 2 }), row({ priority: 1 })] });
  });

  it("drops a late read and retries a miss without clearing the board", () => {
    expect(applyProgrammeLoad(1, 2, { rows: [row()] })).toEqual({ drop: true });
    expect(applyProgrammeLoad(1, 1, { unavailable: true })).toEqual({ retry: true });
    expect(applyProgrammeLoad(3, 3, { rows: [] })).toEqual({ rows: [] });
  });
});

describe("who may change the programme", () => {
  it("refuses a worker before the store is called", async () => {
    const store = vi.fn();
    const host = bare({ programmeStore: store });
    await expect(handleAgentApp(session(), "r1", "programme.enqueue", {
      wp: "WP-159",
      title: "Queue",
      briefPath: "docs/brief.md",
      branch: "wp/159",
    }, host)).rejects.toThrow(WORKER_REASON);
    await expect(handleAgentApp(session(), "r2", "programme.list", {}, host)).rejects.toThrow(WORKER_REASON);
    await expect(handleAgentApp(session(), "r3", "programme.park", { id: "programme-1", version: 1, reason: "Wait" }, host)).rejects.toThrow(WORKER_REASON);
    expect(store).not.toHaveBeenCalled();
  });

  it("refuses a habit run and the checker without calling them a worker", async () => {
    const store = vi.fn();
    const habit = bare({ isHabitRun: () => true, programmeStore: store });
    await expect(handleProgramme(session(), "programme.list", {}, habit)).rejects.toThrow(/habit run/i);
    const checker = bare({
      isMono: () => true,
      monoOf: () => ({ id: CHECKER_MONO_ID, projects: ["crew"] }),
      programmeStore: store,
    });
    await expect(handleProgramme(session(), "programme.list", {}, checker)).rejects.toThrow(/checker only reads/i);
    expect(store).not.toHaveBeenCalled();
  });

  it("lets a coding-team chat enqueue as the first mate, and not for another project", async () => {
    const store = vi.fn(async () => row());
    const host = bare({
      codingTeamOf: (id) => (id === "chat-1" ? { project: "crew", name: "Crew", folder: "/work/crew" } : undefined),
      programmeStore: store,
    });
    const source = session();
    await expect(handleAgentApp(source, "r1", "programme.enqueue", {
      wp: "WP-159",
      title: "Queue",
      briefPath: "docs/brief.md",
      branch: "wp/159",
      kind: "person",
    }, host)).rejects.toThrow(/Unknown programme\.enqueue fields/);
    await expect(handleAgentApp(source, "r2", "programme.enqueue", {
      wp: "WP-159",
      title: "Queue",
      briefPath: "docs/brief.md",
      branch: "wp/159",
      project: "other",
    }, host)).rejects.toThrow("That project isn't this chat's.");
    expect(store).not.toHaveBeenCalled();
    await handleAgentApp(source, "r3", "programme.enqueue", {
      wp: "WP-159",
      title: "Queue",
      briefPath: "docs/brief.md",
      branch: "wp/159",
    }, host);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith("programme_enqueue", {
      actor: { id: "chat-1", project: "crew", kind: "first-mate" },
      input: { wp: "WP-159", title: "Queue", briefPath: "docs/brief.md", branch: "wp/159" },
    });
  });

  it("asks a mono with two projects to name one, and a park needs a reason", async () => {
    const store = vi.fn(async () => row());
    const host = bare({
      isMono: () => true,
      monoOf: () => ({ id: "lead", projects: ["crew", "notes"] }),
      programmeStore: store,
    });
    const source = session();
    await expect(handleProgramme(source, "programme.list", {}, host)).rejects.toThrow("Name the project this programme belongs to.");
    await expect(handleProgramme(source, "programme.park", { id: "programme-1", version: 1, project: "crew" }, host)).rejects.toThrow("reason is required.");
    await expect(handleProgramme(source, "programme.set_status", { id: "programme-1", version: 1.5, status: "building", project: "crew" }, host)).rejects.toThrow("version is required.");
    expect(store).not.toHaveBeenCalled();
    await handleProgramme(source, "programme.set_status", { id: "programme-1", version: 2, status: "building", project: "notes" }, host);
    expect(store).toHaveBeenCalledWith("programme_set_status", {
      actor: { id: "chat-1", project: "notes", kind: "first-mate" },
      input: { id: "programme-1", version: 2, status: "building" },
    });
  });
});
