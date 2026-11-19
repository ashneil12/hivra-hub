// SC-19 (never lose an ask, gap D1): the app's side of moving a retired chat's work to the chat that takes its place.
import { describe, expect, it, vi } from "vitest";
import { appNoteText } from "../../sessions/model/appNote";
import type { QueuedMessage } from "../../sessions/model/session";
import {
  DelegationTracker,
  type Delegation,
  type DelegationsBackend,
  type Reparented,
} from "./delegations";
import {
  MOVE_RETRY_MS,
  MOVED_TASKS_PREFIX,
  movedStatus,
  movedWorkNote,
  moveOwnedWork,
  ownerSuccessor,
  type SuccessorHost,
} from "./ownerMove";

function row(over: Partial<Delegation> = {}): Delegation {
  return {
    id: "t-1",
    ownerSession: "chat-new",
    ownerMono: "exo-chief",
    batchId: null,
    parentId: null,
    rootId: "t-1",
    childSession: "worker-1",
    requestId: "r-1",
    generation: 1,
    project: "/p",
    title: "Fix the save bug",
    brief: null,
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 1,
    updatedAt: 1,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    status: "working",
    ...over,
  };
}

const moved = (rows: Delegation[], waiting: Reparented["waiting"] = []): Reparented => ({ rows, waiting });

describe("SC-19: the note a chat gets when work moves to it", () => {
  it("lists every moved task with where it stands, and tells the chat its reports will arrive", () => {
    const note = movedWorkNote({
      kind: "reset",
      chatId: "chat-new",
      moved: moved(
        [
          row({ id: "t-1", title: "Fix the save bug" }),
          row({ id: "t-2", title: "Pick the palette", state: "question", status: "needs-you" }),
          row({ id: "t-3", title: "Tidy the tests", state: "completed", status: "done", delivery: "pending" }),
          row({ id: "t-4", title: "Old job", state: "failed", status: "failed", delivery: "queued" }),
        ],
        [{ id: "w-1", title: "Write the docs" }],
      ),
    })!;
    expect(note.text).toBe(
      `${MOVED_TASKS_PREFIX} From the app: These tasks were still going when this chat was reset: ` +
        "Fix the save bug: working, Pick the palette: waiting on you, Tidy the tests: finished, report on its way, " +
        "Old job: failed, report on its way, Write the docs: waiting for a free worker. " +
        "Nothing was stopped. Their reports will arrive in this chat. This is an app notification, not a new message.",
    );
    expect(note.waitForIdle).toBe(true);
    expect(note.attachments).toEqual([]);
  });

  it("says nothing when nothing moved: a reset with no open work posts no note", () => {
    expect(movedWorkNote({ kind: "reset", chatId: "chat-new", moved: moved([]) })).toBeUndefined();
  });

  it("names how the old chat went", () => {
    const one = moved([row()]);
    expect(movedWorkNote({ kind: "archive", chatId: "c", moved: one })!.text).toContain(
      "still going when the chat that owned them was archived: Fix the save bug: working.",
    );
    expect(movedWorkNote({ kind: "delete", chatId: "c", moved: one })!.text).toContain(
      "still going when the chat that owned them was deleted: Fix the save bug: working.",
    );
  });

  it("uses plain words: no em dash and never Stuck, whatever the titles and statuses say", () => {
    const text = movedWorkNote({
      kind: "reset",
      chatId: "chat-new",
      moved: moved(
        [
          row({ id: "t-1", title: "Port the board — phase two", stallKind: "loop", statusNotice: "Stuck on the same step" }),
          row({ id: "t-2", title: "Ship – now" }),
          row({ id: "t-3", title: "   " }),
          row({ id: "t-4", title: null, stallKind: "quiet" }),
        ],
        [{ id: "w-1", title: null }],
      ),
    })!.text;
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/stuck/i);
    expect(text).toContain("Port the board - phase two: working");
    expect(text).toContain("Ship - now: working");
    expect(text).toContain("a task: working, a task: working, a task: waiting for a free worker");
  });

  it("keeps a long title to one line and a long list to twelve, then says how many more", () => {
    const rows = Array.from({ length: 15 }, (_, i) => row({ id: `t-${i}`, title: i === 0 ? `${"x".repeat(200)}\nsecond line` : `Task ${i}` }));
    const text = movedWorkNote({ kind: "reset", chatId: "c", moved: moved(rows) })!.text;
    expect(text).not.toContain("\n");
    expect(text).toContain(`${"x".repeat(79)}…: working`);
    expect(text).toContain("Task 11: working, and 3 more.");
    expect(text).not.toContain("Task 12");
  });

  it("gives the same move the same id, so a repeat is deduplicated, and a different move another", () => {
    const a = movedWorkNote({ kind: "reset", chatId: "chat-new", moved: moved([row({ id: "t-1" }), row({ id: "t-2" })]) })!;
    const again = movedWorkNote({ kind: "reset", chatId: "chat-new", moved: moved([row({ id: "t-2" }), row({ id: "t-1" })]) })!;
    const other = movedWorkNote({ kind: "reset", chatId: "chat-new", moved: moved([row({ id: "t-3" })]) })!;
    const elsewhere = movedWorkNote({ kind: "reset", chatId: "chat-else", moved: moved([row({ id: "t-1" }), row({ id: "t-2" })]) })!;
    expect(again.id).toBe(a.id);
    expect(other.id).not.toBe(a.id);
    expect(elsewhere.id).not.toBe(a.id);
    expect(a.id).toMatch(/^moved-tasks-chat-new-[0-9a-f]{8}$/);
  });

  it("shows in the transcript as one plain line, not as the person's own message", () => {
    const note = movedWorkNote({ kind: "reset", chatId: "c", moved: moved([row()]) })!;
    expect(appNoteText(note.text)).toBe("Tasks that were still going moved to this chat");
  });

  it("reads the row's own status and only adds that a report is owed; a row from an older build still reads", () => {
    expect(movedStatus({ status: "paused", state: "failed", delivery: "pending" })).toBe("paused, report on its way");
    expect(movedStatus({ status: "done", state: "completed", delivery: "queued" })).toBe("finished, report on its way");
    expect(movedStatus({ status: "working", state: "running", delivery: "pending" })).toBe("working");
    // Finished and told already is not listed by the move, but the words stay honest if one is shown.
    expect(movedStatus({ status: "done", state: "completed", delivery: "delivered" })).toBe("finished");
    expect(movedStatus({ status: undefined, state: "running", delivery: "pending" })).toBe("working");
    expect(movedStatus({ status: undefined, state: "completed", delivery: "pending" })).toBe("finished, report on its way");
    // An unknown status (a newer build) never reads as nothing.
    expect(movedStatus({ status: "snoozed" as never, state: "running", delivery: "pending" })).toBe("working");
  });
});

describe("SC-19: which chat takes the work of an archived or deleted chat", () => {
  const host = (over: Partial<SuccessorHost> = {}): SuccessorHost => ({
    monoExists: (id) => id === "chief",
    mainChat: (id) => (id === "chief" ? "chief-main" : undefined),
    leadChat: (project) => (project === "/p" ? { monoId: "exo-lead", chatId: "lead-main" } : undefined),
    ...over,
  });

  it("goes to the same first mate's main chat when a project or further chat is removed", () => {
    for (const kind of ["archive", "delete"] as const) {
      expect(ownerSuccessor({ chatId: "side-chat", kind, monoId: "chief", project: "/p" }, host())).toEqual({
        chatId: "chief-main",
        monoId: "chief",
      });
    }
  });

  it("goes to the project's Lead when the first mate itself is gone (deleted), or has no other chat left", () => {
    expect(ownerSuccessor({ chatId: "old-main", kind: "delete", monoId: "gone", project: "/p" }, host())).toEqual({
      chatId: "lead-main",
      monoId: "exo-lead",
    });
    // Its main chat is the one being deleted: it has nowhere to hold the work.
    expect(ownerSuccessor({ chatId: "chief-main", kind: "delete", monoId: "chief", project: "/p" }, host())).toEqual({
      chatId: "lead-main",
      monoId: "exo-lead",
    });
    // A coding-team chat belongs to no first mate: its project's Lead takes it.
    expect(ownerSuccessor({ chatId: "team-chat", kind: "delete", project: "/p" }, host())).toEqual({
      chatId: "lead-main",
      monoId: "exo-lead",
    });
  });

  it("leaves an archived main chat alone: it can come back where it was, nothing is handed to a Lead", () => {
    expect(ownerSuccessor({ chatId: "chief-main", kind: "archive", monoId: "chief", project: "/p" }, host())).toBeUndefined();
    expect(ownerSuccessor({ chatId: "team-chat", kind: "archive", project: "/p" }, host())).toBeUndefined();
  });

  it("never picks a chat that can't hold the work: the retired chat itself, its own Mono's Lead seat, or no chat at all", () => {
    // The first mate IS the Lead and its main chat is the one deleted.
    expect(
      ownerSuccessor(
        { chatId: "lead-main", kind: "delete", monoId: "exo-lead", project: "/p" },
        host({ monoExists: () => true, mainChat: () => "lead-main" }),
      ),
    ).toBeUndefined();
    // The Lead's chat is the retired chat.
    expect(ownerSuccessor({ chatId: "lead-main", kind: "delete", project: "/p" }, host())).toBeUndefined();
    // No project, an unknown project, a blank one.
    expect(ownerSuccessor({ chatId: "x", kind: "delete", monoId: "gone" }, host())).toBeUndefined();
    expect(ownerSuccessor({ chatId: "x", kind: "delete", monoId: "gone", project: "/elsewhere" }, host())).toBeUndefined();
    expect(ownerSuccessor({ chatId: "x", kind: "delete", monoId: "gone", project: "   " }, host())).toBeUndefined();
  });
});

describe("SC-19: moving the work, and telling the new chat once", () => {
  function trackerOver(reparent: DelegationsBackend["reparent"]) {
    const backend = { reparent } as unknown as DelegationsBackend;
    return new DelegationTracker(backend, {
      session: () => undefined,
      load: async () => null,
      openOwner: async () => null,
      isMono: () => true,
      queueReport: async () => undefined,
      quitting: () => false,
    });
  }

  it("asks the store to move the work, then posts one note to the new chat", async () => {
    const reparent = vi.fn(async () => moved([row({ id: "t-1" }), row({ id: "t-2", title: "Write the docs" })]));
    const posted: [string, QueuedMessage][] = [];
    const result = await moveOwnedWork({
      tracker: trackerOver(reparent),
      kind: "reset",
      from: { chatId: "chat-old", title: "Planning" },
      to: { chatId: "chat-new", monoId: "exo-chief" },
      post: async (chatId, message) => void posted.push([chatId, message]),
    });
    expect(reparent).toHaveBeenCalledExactlyOnceWith({
      from: "chat-old",
      to: "chat-new",
      toMono: "exo-chief",
      fromTitle: "Planning",
      why: "reset",
    });
    expect(result.rows.map((r) => r.id)).toEqual(["t-1", "t-2"]);
    expect(posted).toHaveLength(1);
    expect(posted[0][0]).toBe("chat-new");
    expect(posted[0][1].text).toContain("Fix the save bug: working, Write the docs: working");
  });

  it("leaves out what it wasn't told: no title, no Mono", async () => {
    const reparent = vi.fn(async () => moved([]));
    await moveOwnedWork({
      tracker: trackerOver(reparent),
      kind: "delete",
      from: { chatId: "chat-old" },
      to: { chatId: "chat-new" },
      post: async () => undefined,
    });
    expect(reparent).toHaveBeenCalledExactlyOnceWith({ from: "chat-old", to: "chat-new", why: "delete" });
  });

  it("posts nothing when the chat had nothing open", async () => {
    const post = vi.fn(async () => undefined);
    const result = await moveOwnedWork({
      tracker: trackerOver(async () => moved([])),
      kind: "reset",
      from: { chatId: "chat-old" },
      to: { chatId: "chat-new" },
      post,
    });
    expect(result).toEqual({ rows: [], waiting: [] });
    expect(post).not.toHaveBeenCalled();
  });

  it("tries again, further apart each time, when the store is busy: a refusal is not final", async () => {
    const reparent = vi
      .fn<NonNullable<DelegationsBackend["reparent"]>>()
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValue(moved([row()]));
    const sleep = vi.fn(async () => undefined);
    const post = vi.fn(async () => undefined);
    await moveOwnedWork({
      tracker: trackerOver(reparent),
      kind: "reset",
      from: { chatId: "chat-old" },
      to: { chatId: "chat-new" },
      post,
      sleep,
    });
    expect(reparent).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([MOVE_RETRY_MS[1], MOVE_RETRY_MS[2]]);
    expect(post).toHaveBeenCalledOnce();
  });

  it("throws the last failure once every try is used, and posts nothing", async () => {
    const reparent = vi.fn().mockRejectedValue(new Error("database is locked"));
    const post = vi.fn(async () => undefined);
    await expect(
      moveOwnedWork({
        tracker: trackerOver(reparent),
        kind: "reset",
        from: { chatId: "chat-old" },
        to: { chatId: "chat-new" },
        post,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("database is locked");
    expect(reparent).toHaveBeenCalledTimes(MOVE_RETRY_MS.length);
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps the move when the note can't be posted: the work moved, the failure is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reparent = vi.fn(async () => moved([row()]));
    const result = await moveOwnedWork({
      tracker: trackerOver(reparent),
      kind: "reset",
      from: { chatId: "chat-old" },
      to: { chatId: "chat-new" },
      post: async () => {
        throw new Error("chat closed");
      },
    });
    expect(result.rows).toHaveLength(1);
    expect(reparent).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("a backend from before the move existed moves nothing and says nothing", async () => {
    const tracker = new DelegationTracker({} as DelegationsBackend, {
      session: () => undefined,
      load: async () => null,
      openOwner: async () => null,
      isMono: () => true,
      queueReport: async () => undefined,
      quitting: () => false,
    });
    const post = vi.fn(async () => undefined);
    expect(
      await moveOwnedWork({ tracker, kind: "reset", from: { chatId: "a" }, to: { chatId: "b" }, post }),
    ).toEqual({ rows: [], waiting: [] });
    expect(post).not.toHaveBeenCalled();
  });
});
