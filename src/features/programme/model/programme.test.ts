// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import {
  READ_NOTICE_AFTER,
  WORKER_REASON,
  applyProgrammeLoad,
  clipText,
  collectProgramme,
  handleProgramme,
  programmeGroup,
  programmeShows,
  readPackage,
  retryDelayMs,
  shownRows,
  textLength,
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
    expect(readPackage(row())?.briefPath).toBe("docs/my briefs/note.md");
  });

  it("never drops a row for being long, and measures by characters, not UTF-16 units", () => {
    const longTitle = "a".repeat(301);
    expect(readPackage({ ...row(), title: longTitle })?.title).toBe(longTitle);
    expect(readPackage({ ...row(), notes: "a".repeat(2001) })?.notes).toHaveLength(2001);
    expect(readPackage({ ...row(), parkReason: "b".repeat(501), status: "parked" })).toBeDefined();
    // 200 astral characters are 400 UTF-16 units but 200 characters: under the 300 limit, so not a drop either way.
    const astral = "\u{1F600}".repeat(200);
    expect(readPackage({ ...row(), title: astral })?.title).toBe(astral);
    expect(textLength(astral)).toBe(200);
    expect(textLength("a\u{1F600}")).toBe(2);
  });

  it("clips a long text for display by characters, never by UTF-16 unit", () => {
    expect(clipText("abc", 3)).toBe("abc");
    expect(clipText("abcd", 3)).toBe("ab\u2026");
    expect(clipText("\u{1F600}".repeat(4), 4)).toBe("\u{1F600}".repeat(4));
    expect(clipText("\u{1F600}".repeat(5), 4)).toBe("\u{1F600}".repeat(3) + "\u2026");
  });

  it("puts a security park with the parked rows and hides a merged one", () => {
    expect(programmeGroup(row({ securityPark: true }))).toBe("parked");
    expect(programmeGroup(row({ status: "parked", parkReason: "Wait" }))).toBe("parked");
    expect(programmeGroup(row({ status: "building" }))).toBe("flight");
    expect(programmeGroup(row({ status: "pr_open" }))).toBe("flight");
    expect(programmeGroup(row({ status: "failed" }))).toBe("failed");
    expect(programmeGroup(row({ status: "merged" }))).toBeUndefined();
  });

  it("reads each project on its own: one bad board does not blank the rest", async () => {
    const missed = await collectProgramme(["crew"], async () => {
      throw new Error("timed out");
    });
    expect(missed).toEqual({ unavailable: true });
    const bad = await collectProgramme(["crew", "notes"], async (project) => {
      if (project === "notes") throw new Error("timed out");
      return [row({ priority: 1 })];
    });
    expect(bad).toEqual({ rows: [row({ priority: 1 })], failed: ["notes"] });
    const junk = await collectProgramme(["crew", "notes"], async () => null);
    expect(junk).toEqual({ unavailable: true });
    const empty = await collectProgramme(["crew"], async () => []);
    expect(empty).toEqual({ rows: [], failed: [] });
    const mixed = await collectProgramme(["crew", "notes"], async (project) => {
      if (project === "notes") return [{ ...row({ id: "programme-2", projectId: "notes", priority: 2 }), extra: true }, { nope: 1 }];
      return [row({ priority: 1 })];
    });
    expect(mixed).toEqual({ rows: [row({ id: "programme-2", projectId: "notes", priority: 2 }), row({ priority: 1 })], failed: [] });
  });

  it("keeps the rows of a board that failed to read, and retries without clearing the rest", () => {
    const kept = row({ id: "programme-9", projectId: "notes", title: "Kept" });
    expect(applyProgrammeLoad(1, 2, { rows: [row()], failed: [] })).toEqual({ drop: true });
    expect(applyProgrammeLoad(1, 1, { unavailable: true }, [kept])).toEqual({ rows: [kept], retry: true, clearNotice: false });
    expect(
      applyProgrammeLoad(4, 4, { rows: [row({ priority: 1 })], failed: ["notes"] }, [kept]),
    ).toEqual({ rows: [row({ priority: 1 }), kept], retry: true, clearNotice: false });
    expect(applyProgrammeLoad(3, 3, { rows: [], failed: [] })).toEqual({ rows: [], retry: false, clearNotice: true });
  });

  it("clears a notice only after a good read that started after the notice", () => {
    expect(applyProgrammeLoad(5, 5, { rows: [], failed: [] }, [], 5)).toMatchObject({ clearNotice: false });
    expect(applyProgrammeLoad(6, 6, { rows: [], failed: [] }, [], 5)).toMatchObject({ clearNotice: true });
    expect(applyProgrammeLoad(6, 6, { unavailable: true }, [], 5)).toMatchObject({ clearNotice: false });
  });

  it("backs off on repeated read failures and says so plainly after a few", () => {
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(2));
    expect(retryDelayMs(2)).toBeLessThan(retryDelayMs(3));
    expect(retryDelayMs(50)).toBe(retryDelayMs(20));
    expect(READ_NOTICE_AFTER).toBeGreaterThanOrEqual(2);
  });

  it("shows the panel only when a row sits in a group it shows, or a notice is set", () => {
    expect(shownRows([row({ status: "merged" })])).toEqual([]);
    expect(programmeShows([row({ status: "merged" })])).toBe(false);
    expect(programmeShows([row({ status: "merged" })], "Could not clear.")).toBe(true);
    expect(programmeShows([row({ status: "queued" })])).toBe(true);
    expect(programmeShows([])).toBe(false);
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
      knownProjects: () => [
        { id: "crew", name: "Crew", folder: "/work/crew" },
        { id: "notes", name: "Notes", folder: "/work/notes" },
      ],
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

  it("files a Mono's package under the hub project Home reads, not the folder", async () => {
    const store = vi.fn(async () => [row()]);
    const host = bare({
      isMono: () => true,
      monoOf: () => ({ id: "lead", projects: ["/work/crew"] }),
      knownProjects: () => [{ id: "crew", name: "Crew", folder: "/work/crew" }],
      programmeStore: store,
    });
    const source = session();
    await handleProgramme(source, "programme.list", {}, host);
    await handleProgramme(source, "programme.list", { project: "Crew" }, host);
    await handleProgramme(source, "programme.list", { project: "crew" }, host);
    expect(store.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { actor: { id: "chat-1", project: "crew", kind: "first-mate" } },
      { actor: { id: "chat-1", project: "crew", kind: "first-mate" } },
      { actor: { id: "chat-1", project: "crew", kind: "first-mate" } },
    ]);
    await expect(handleProgramme(source, "programme.list", { project: "/work/other" }, host)).rejects.toThrow(
      "That project isn't this chat's.",
    );
    const stranger = bare({
      isMono: () => true,
      monoOf: () => ({ id: "lead", projects: ["/work/gone"] }),
      knownProjects: () => [{ id: "crew", name: "Crew", folder: "/work/crew" }],
      programmeStore: store,
    });
    await expect(handleProgramme(source, "programme.list", {}, stranger)).rejects.toThrow("Not a project on this copy.");
    expect(store).toHaveBeenCalledTimes(3);
  });
});
