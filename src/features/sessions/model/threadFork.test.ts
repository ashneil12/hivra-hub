import { describe, expect, it } from "vitest";
import { memoryReadableBlocks, UNREADABLE_BOUNDARY } from "../../memory/model/privateChat";
import { temporaryWorktreeBranchName, type Worktree } from "../../source-control/model/worktrees";
import { sanitizeSessionForPersist } from "../data/sessionStore";
import { newSession, type Attachment, type Block, type Session } from "./session";
import { clearThreadForkAsk, threadForkAskSnapshot } from "./threadForkAsk";
import {
  forkAttemptGate,
  forkChat,
  forkFocusedChat,
  forkSessionAtMessage,
  forkStillValid,
  forkWorktreeDefault,
  forkWorktreeError,
  insertFork,
  lastForkableBlockId,
  type ForkIds,
  type ForkWorktreePort,
} from "./threadFork";

function ids(values: string[]): ForkIds {
  const rest = [...values];
  return {
    next: () => {
      const id = rest.shift();
      if (!id) throw new Error("test ran out of ids");
      return id;
    },
  };
}

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-old",
    name: "notes.txt",
    mimeType: "text/plain",
    kind: "file",
    size: 12,
    path: "C:\\work\\my notes\\café.txt",
    data: "aGVsbG8=",
    previewUrl: "blob:preview",
    copyFromPath: true,
    ...over,
  };
}

function block(over: Partial<Block> & Pick<Block, "id" | "role" | "text">): Block {
  return { ...over };
}

function chat(blocks: Block[], over: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/work/proj"),
    id: "sess-old",
    title: "Plan the launch",
    providerSessionId: "provider-1",
    busy: true,
    queuedMessages: [{ id: "q1", text: "later", attachments: [] }],
    worktreeCwd: "/work/proj-wt",
    branch: "feature/plan",
    blocks,
    ...over,
  };
}

describe("forkSessionAtMessage", () => {
  it("copies messages up to the chosen one and leaves later ones behind", () => {
    const source = chat([
      block({ id: "u1", role: "user", text: "First\r\nline" }),
      block({ id: "a1", role: "assistant", text: "Answer one" }),
      block({ id: "u2", role: "user", text: "Second" }),
      block({ id: "a2", role: "assistant", text: "Answer two" }),
    ]);
    const before = structuredClone(source);
    const fork = forkSessionAtMessage(source, "a1", ids(["fork-1", "b1", "b2"]));

    expect(fork).not.toBeNull();
    expect(fork!.blocks.map((entry) => entry.text)).toEqual(["First\r\nline", "Answer one"]);
    expect(fork!.blocks.map((entry) => entry.id)).toEqual(["b1", "b2"]);
    expect(fork!.id).toBe("fork-1");
    expect(fork!.id).not.toBe(source.id);
    expect(fork!.cwd).toBe(source.cwd);
    expect(fork!.title).toBe("Fork of Plan the launch");
    expect(fork!.providerSessionId).toBeUndefined();
    expect(fork!.busy).toBeUndefined();
    expect(fork!.queuedMessages).toBeUndefined();
    expect(source).toEqual(before);
  });

  it("copies attachment metadata onto new rows and does not share them", () => {
    const file = attachment();
    const source = chat([
      block({ id: "u1", role: "user", text: "See file", attachments: [file] }),
      block({ id: "a1", role: "assistant", text: "Read" }),
    ]);
    const fork = forkSessionAtMessage(source, "u1", ids(["fork-1", "b1", "att-new"]));
    const copied = fork!.blocks[0].attachments![0];

    expect(copied).toMatchObject({
      name: "notes.txt",
      mimeType: "text/plain",
      kind: "file",
      size: 12,
      path: "C:\\work\\my notes\\café.txt",
      data: "aGVsbG8=",
    });
    expect(copied.id).toBe("att-new");
    expect(copied.previewUrl).toBeUndefined();
    expect(copied.copyFromPath).toBeUndefined();
    expect(copied).not.toBe(file);

    copied.name = "changed.txt";
    copied.path = "/tmp/other";
    expect(source.blocks[0].attachments![0].name).toBe("notes.txt");
    expect(source.blocks[0].attachments![0].path).toBe("C:\\work\\my notes\\café.txt");
    expect(fork!.blocks).not.toContain(source.blocks[0]);
  });

  it("keeps a windows path, a parent segment and unicode as text, not a resolved path", () => {
    const source = chat([
      block({
        id: "u1",
        role: "user",
        text: "look at ..\\secret and café",
        attachments: [
          attachment({
            id: "a",
            name: "café.png",
            path: "..\\secret\\café.png",
          }),
        ],
      }),
    ]);
    const fork = forkSessionAtMessage(source, "u1", ids(["fork-1", "b1", "att-1"]));
    expect(fork!.blocks[0].text).toBe("look at ..\\secret and café");
    expect(fork!.blocks[0].attachments![0].path).toBe("..\\secret\\café.png");
    expect(fork!.blocks[0].attachments![0].name).toBe("café.png");
  });

  it("does not share nested tool rows with the original", () => {
    const source = chat([
      block({
        id: "u1",
        role: "user",
        text: "Go",
        tool: { callId: "call-1", detail: "original detail" },
      }),
    ]);
    const fork = forkSessionAtMessage(source, "u1", ids(["fork-1", "b1"]));
    fork!.blocks[0].tool!.detail = "forked detail";
    expect(source.blocks[0].tool!.detail).toBe("original detail");
    expect(fork!.blocks[0].providerTurnId).toBeUndefined();
  });

  it("drops a live approval and a provider turn id, and keeps a decided approval", () => {
    const source = chat([
      block({
        id: "u1",
        role: "user",
        text: "Run",
        providerTurnId: "turn-9",
        streaming: true,
        approval: { requestId: 4 },
      }),
      block({
        id: "a1",
        role: "assistant",
        text: "Done",
        approval: { requestId: 5, decided: "allow" },
      }),
    ]);
    const fork = forkSessionAtMessage(source, "a1", ids(["fork-1", "b1", "b2"]));
    expect(fork!.blocks[0].approval).toBeUndefined();
    expect(fork!.blocks[0].providerTurnId).toBeUndefined();
    expect(fork!.blocks[0].streaming).toBe(false);
    expect(fork!.blocks[1].approval).toEqual({ requestId: 5, decided: "allow" });
    fork!.blocks[1].approval!.decided = "deny";
    expect(source.blocks[1].approval!.decided).toBe("allow");
  });

  it("gives a side thread new ids and drops its provider thread", () => {
    const source = chat([
      block({
        id: "u1",
        role: "user",
        text: "Ask",
        btwThreads: [
          {
            id: "thread-old",
            sourceEndBlockId: "u1",
            createdAt: 1,
            updatedAt: 2,
            status: "running",
            providerThreadId: "prov-thread",
            pendingBlocks: [block({ id: "live", role: "assistant", text: "..." })],
            messages: [
              { id: "m1", role: "user", text: "side", createdAt: 1 },
            ],
          },
        ],
      }),
    ]);
    const fork = forkSessionAtMessage(
      source,
      "u1",
      ids(["fork-1", "b1", "thread-new", "m-new"]),
    );
    const thread = fork!.blocks[0].btwThreads![0];
    expect(thread.id).toBe("thread-new");
    expect(thread.sourceEndBlockId).toBe("b1");
    expect(thread.providerThreadId).toBeUndefined();
    expect(thread.pendingBlocks).toBeUndefined();
    expect(thread.status).toBe("ready");
    expect(thread.messages[0].id).toBe("m-new");
    expect(source.blocks[0].btwThreads![0].id).toBe("thread-old");
    expect(source.blocks[0].btwThreads![0].providerThreadId).toBe("prov-thread");
  });

  it("returns null for a missing message, a tool row, an empty id, or a chat with no blocks", () => {
    const source = chat([
      block({ id: "u1", role: "user", text: "Hi" }),
      block({ id: "t1", role: "tool", text: "ran" }),
    ]);
    const before = structuredClone(source);
    expect(forkSessionAtMessage(source, "missing", ids(["fork-1"]))).toBeNull();
    expect(forkSessionAtMessage(source, "t1", ids(["fork-1"]))).toBeNull();
    expect(forkSessionAtMessage(source, "", ids(["fork-1"]))).toBeNull();
    expect(forkSessionAtMessage({ ...source, blocks: [] }, "u1", ids(["fork-1"]))).toBeNull();
    expect(source).toEqual(before);
  });

  it("forks the first of two blocks that share an id, and ignores messages after it", () => {
    const source = chat([
      block({ id: "same", role: "user", text: "kept" }),
      block({ id: "same", role: "assistant", text: "also same id, later" }),
    ]);
    const fork = forkSessionAtMessage(source, "same", ids(["fork-1", "b1"]));
    expect(fork!.blocks).toHaveLength(1);
    expect(fork!.blocks[0].text).toBe("kept");
  });

  it("rejects an id the store would refuse, and does not return a partial chat", () => {
    const source = chat([
      block({
        id: "u1",
        role: "user",
        text: "Hi",
        attachments: [attachment()],
      }),
    ]);
    const before = structuredClone(source);
    expect(
      forkSessionAtMessage(
        source,
        "u1",
        ids(["../a", "../b", "../c", "bad id", "fork-1", "b1", "att-1"]),
      ),
    ).toBeNull();
    expect(forkSessionAtMessage(source, "u1", ids(["fork-1", "b1", "bad id"]))).toBeNull();
    expect(source).toEqual(before);
  });

  it("drops an attachment that is not an object and still forks the message", () => {
    const source = chat([
      block({
        id: "u1",
        role: "user",
        text: "Hi",
        attachments: [null as unknown as Attachment, attachment({ id: "kept" })],
      }),
    ]);
    const fork = forkSessionAtMessage(source, "u1", ids(["fork-1", "b1", "att-1"]));
    expect(fork!.blocks[0].attachments).toHaveLength(1);
    expect(fork!.blocks[0].attachments![0].id).toBe("att-1");
    expect(fork!.blocks[0].attachments![0].name).toBe("notes.txt");
  });

  it("keeps a worktree that was deleted marked as deleted, so the fork does not run in a missing folder", () => {
    const gone = chat([block({ id: "u1", role: "user", text: "Hi" })], { worktreeRemoved: true });
    const fork = forkSessionAtMessage(gone, "u1", ids(["fork-1", "b1"]))!;
    expect(fork.worktreeCwd).toBe("/work/proj-wt");
    expect(fork.worktreeRemoved).toBe(true);
    const present = chat([block({ id: "u1", role: "user", text: "Hi" })]);
    expect(forkSessionAtMessage(present, "u1", ids(["fork-2", "c1"]))!.worktreeRemoved).toBeUndefined();
  });

  it("uses the reserved session id when one is handed in", () => {
    const source = chat([block({ id: "u1", role: "user", text: "Hi" })]);
    const fork = forkSessionAtMessage(source, "u1", ids(["b1"]), "reserved-1");
    expect(fork!.id).toBe("reserved-1");
    expect(fork!.blocks[0].id).toBe("b1");
  });
});

describe("insertFork", () => {
  it("appends a fork and leaves every existing chat as it was", () => {
    const original = chat([block({ id: "u1", role: "user", text: "Hi" })]);
    const fork = forkSessionAtMessage(original, "u1", ids(["fork-1", "b1"]))!;
    const list = [original];
    const next = insertFork(list, fork);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(original);
    expect(next[1]).toBe(fork);
    expect(list).toHaveLength(1);
  });

  it("does not insert a second time when the id is already there", () => {
    const original = chat([block({ id: "u1", role: "user", text: "Hi" })]);
    const fork = forkSessionAtMessage(original, "u1", ids(["fork-1", "b1"]))!;
    const once = insertFork([original], fork);
    const twice = insertFork(once, { ...fork, title: "replaced" });
    expect(twice).toBe(once);
    expect(twice[1].title).toBe(fork.title);
  });
});

describe("lastForkableBlockId", () => {
  it("picks the latest user or assistant message and skips tool rows", () => {
    const blocks = [
      block({ id: "u1", role: "user", text: "Hi" }),
      block({ id: "t1", role: "tool", text: "ran" }),
      block({ id: "a1", role: "assistant", text: "Ok" }),
      block({ id: "s1", role: "system", text: "note" }),
    ];
    expect(lastForkableBlockId(blocks)).toBe("a1");
    expect(
      lastForkableBlockId([
        ...blocks,
        block({ id: "hidden", role: "user", text: "app", internal: true }),
      ]),
    ).toBe("a1");
    expect(lastForkableBlockId([])).toBeNull();
    expect(forkStillValid(chat(blocks), "a1")).toBe(true);
    clearThreadForkAsk();
    expect(forkFocusedChat(chat(blocks))).toBe(true);
    expect(threadForkAskSnapshot()?.blockId).toBe("a1");
    expect(
      forkFocusedChat(
        chat([
          ...blocks,
          block({ id: "hidden", role: "user", text: "app", internal: true }),
        ]),
      ),
    ).toBe(true);
    expect(threadForkAskSnapshot()?.blockId).toBe("a1");
    expect(forkFocusedChat(chat([block({ id: "t1", role: "tool", text: "ran" })]))).toBe(false);
    expect(forkFocusedChat(undefined)).toBe(false);
    clearThreadForkAsk();
    expect(forkStillValid(chat(blocks), "t1")).toBe(false);
    expect(forkStillValid(undefined, "a1")).toBe(false);
  });
});

const DIRTY =
  "error: Your local changes to the following files would be overwritten by checkout:\n\tfile.txt\nPlease commit your changes or stash them before you switch branches.";
const TAKEN = "This branch already has a working copy. Select it from the picker.";
const NOT_GIT =
  "fatal: not a git repository (or any of the parent directories): .git";

function tree(path: string, branch: string | null = "mc/fork"): Worktree {
  return {
    path,
    branch,
    head: "abc",
    isMain: false,
    locked: false,
    prunable: false,
    missing: false,
    dirty: false,
    unpushed: 0,
    sessionIds: [],
  };
}

describe("forkWorktreeDefault", () => {
  it("starts checked for ask and always, and unchecked for anything else", () => {
    expect(forkWorktreeDefault("ask")).toBe(true);
    expect(forkWorktreeDefault("always")).toBe(true);
    expect(forkWorktreeDefault("off")).toBe(false);
    expect(forkWorktreeDefault("sometimes")).toBe(false);
    expect(forkWorktreeDefault(null)).toBe(false);
    expect(forkWorktreeDefault(1)).toBe(false);
  });
});

describe("forkChat", () => {
  it("does not create a worktree when the box is off or the message cannot be forked", async () => {
    const source = chat([
      block({ id: "u1", role: "user", text: "Hi" }),
      block({ id: "a1", role: "assistant", text: "Later" }),
    ]);
    const calls: unknown[] = [];
    const port: ForkWorktreePort = {
      createWorktree: async (...args) => {
        calls.push(args);
        return tree("/work/proj-wt");
      },
    };
    const fork = await forkChat(source, "u1", { useNewWorktree: false }, port, ids(["fork-1", "b1"]));
    expect(fork!.blocks.map((entry) => entry.text)).toEqual(["Hi"]);
    expect(fork!.worktreeCwd).toBe(source.worktreeCwd);
    expect(calls).toEqual([]);
    expect(await forkChat(source, "missing", { useNewWorktree: true }, port)).toBeNull();
    expect(calls).toEqual([]);
    expect(source.blocks).toHaveLength(2);
  });

  it("passes the project path through and keeps the new worktree", async () => {
    const source = chat(
      [block({ id: "u1", role: "user", text: "Hi" })],
      {
        cwd: "C:\\work\\my notes",
        branch: "old",
        worktreeCwd: "C:\\work\\old",
        workspaceMode: "current",
        worktreeBase: "HEAD",
        worktreeRemoved: true,
      },
    );
    const before = structuredClone(source);
    let seen: unknown[] = [];
    const port: ForkWorktreePort = {
      createWorktree: async (...args) => {
        seen = args;
        return tree("C:\\work\\my notes\\wt", "mc/fork");
      },
    };
    const fork = await forkChat(
      source,
      "u1",
      { useNewWorktree: true },
      port,
      ids(["fork-1", "b1"]),
    );
    expect(seen).toEqual([
      "C:\\work\\my notes",
      temporaryWorktreeBranchName("fork-1"),
      "HEAD",
      false,
    ]);
    expect(fork!.id).toBe("fork-1");
    expect(fork!.worktreeCwd).toBe("C:\\work\\my notes\\wt");
    expect(fork!.branch).toBe("mc/fork");
    expect(fork!.workspaceMode).toBeUndefined();
    expect(fork!.worktreeBase).toBeUndefined();
    expect(fork!.worktreeRemoved).toBeUndefined();
    expect(source).toEqual(before);
  });

  it("keeps a refusal and does not open a partial chat", async () => {
    const source = chat([block({ id: "u1", role: "user", text: "Hi" })]);
    const before = structuredClone(source);
    for (const message of [DIRTY, TAKEN, NOT_GIT]) {
      const port: ForkWorktreePort = {
        createWorktree: async () => {
          throw new Error(message);
        },
      };
      await expect(
        forkChat(source, "u1", { useNewWorktree: true }, port, ids(["fork-1", "b1"])),
      ).rejects.toThrow(message);
    }
    expect(source).toEqual(before);
    expect(forkWorktreeError(new Error(DIRTY))).toBe(DIRTY);
    expect(forkWorktreeError(TAKEN)).toBe(TAKEN);
    expect(forkWorktreeError(null)).toBe("The new worktree could not be created.");
  });

  it("reads the chat again after the worktree exists", async () => {
    const source = chat([
      block({ id: "u1", role: "user", text: "Hi" }),
      block({ id: "a1", role: "assistant", text: "Later" }),
    ]);
    let live = source;
    const port: ForkWorktreePort = {
      createWorktree: async () => {
        live = chat([
          block({ id: "u1", role: "user", text: "Hi, edited" }),
          block({ id: "a1", role: "assistant", text: "Later" }),
          block({ id: "u2", role: "user", text: "After the fork point" }),
        ]);
        return tree("/work/proj-wt");
      },
    };
    const fork = await forkChat(
      source,
      "u1",
      { useNewWorktree: true, readSource: () => live },
      port,
      ids(["fork-1", "b1"]),
    );
    expect(fork!.blocks.map((entry) => entry.text)).toEqual(["Hi, edited"]);
    expect(fork!.worktreeCwd).toBe("/work/proj-wt");

    const removed = chat([block({ id: "u1", role: "user", text: "Hi" })]);
    const gone = await forkChat(
      removed,
      "u1",
      {
        useNewWorktree: true,
        readSource: () => chat([]),
      },
      {
        createWorktree: async () => tree("/work/left-behind"),
      },
      ids(["fork-2", "b1"]),
    );
    expect(gone).toBeNull();
  });
});

describe("forkAttemptGate", () => {
  it("drops a late result after cancel, and a newer attempt replaces the old one", () => {
    const gate = forkAttemptGate();
    const first = gate.start();
    expect(gate.current(first)).toBe(true);
    gate.cancel();
    expect(gate.current(first)).toBe(false);
    const second = gate.start();
    const third = gate.start();
    expect(gate.current(second)).toBe(false);
    expect(gate.current(third)).toBe(true);
  });
});

describe("a forked private chat", () => {
  function conversation(over: Partial<Session> = {}): Session {
    return chat(
      [
        block({ id: "u1", role: "user", text: "Secret one" }),
        block({ id: "a1", role: "assistant", text: "Secret answer" }),
        block({ id: "u2", role: "user", text: "Public question" }),
        block({ id: "a2", role: "assistant", text: "Public answer" }),
        block({ id: "u3", role: "user", text: "Later" }),
      ],
      over,
    );
  }
  const texts = (blocks: readonly { text: string }[]) => blocks.map((entry) => entry.text);
  const fresh = ["fork-1", "b1", "b2", "b3", "b4", "b5"];

  it("stays private, so memory reads nothing from it", () => {
    const source = conversation({ private: true });
    const fork = forkSessionAtMessage(source, "a2", ids(fresh))!;
    expect(fork.private).toBe(true);
    expect(memoryReadableBlocks(fork)).toEqual([]);
    expect(source.private).toBe(true);
  });

  it("keeps what was private unread after the chat was switched off", () => {
    const source = conversation({ privateBoundaryId: "a1" });
    const fork = forkSessionAtMessage(source, "u3", ids(fresh))!;
    expect(fork.private).toBeUndefined();
    expect(fork.privateBoundaryId).toBe("b2");
    expect(texts(memoryReadableBlocks(fork))).toEqual(["Public question", "Public answer", "Later"]);
  });

  it("keeps a chat that is private again and still has its old boundary", () => {
    const source = conversation({ private: true, privateBoundaryId: "a1" });
    const fork = forkSessionAtMessage(source, "a2", ids(fresh))!;
    expect(fork.private).toBe(true);
    expect(fork.privateBoundaryId).toBe("b2");
  });

  it("is unread throughout when the boundary comes after the fork point", () => {
    const source = conversation({ privateBoundaryId: "a2" });
    const fork = forkSessionAtMessage(source, "a1", ids(fresh))!;
    expect(fork.privateBoundaryId).toBe("b2");
    expect(memoryReadableBlocks(fork)).toEqual([]);
    const later = { ...fork, blocks: [...fork.blocks, block({ id: "n1", role: "user", text: "New" })] };
    expect(texts(memoryReadableBlocks(later))).toEqual(["New"]);
  });

  it("stays unread when the boundary matches no message", () => {
    const source = conversation({ privateBoundaryId: "gone" });
    const fork = forkSessionAtMessage(source, "a1", ids(fresh))!;
    expect(fork.privateBoundaryId).toBe(UNREADABLE_BOUNDARY);
    expect(memoryReadableBlocks(fork)).toEqual([]);
  });

  it("gives a chat that was never private neither flag", () => {
    const fork = forkSessionAtMessage(conversation(), "a2", ids(fresh))!;
    expect(fork.private).toBeUndefined();
    expect(fork.privateBoundaryId).toBeUndefined();
    expect(memoryReadableBlocks(fork)).toHaveLength(4);
  });

  it("saves both flags with the new chat", () => {
    const source = conversation({ private: true, privateBoundaryId: "a1" });
    const fork = forkSessionAtMessage(source, "a2", ids(fresh))!;
    const saved = sanitizeSessionForPersist(fork);
    expect(saved.private).toBe(true);
    expect(saved.privateBoundaryId).toBe(fork.blocks[1].id);
  });

  it("is still private when it also gets its own worktree", async () => {
    const source = conversation({ private: true });
    const fork = await forkChat(
      source,
      "a2",
      { useNewWorktree: true },
      { createWorktree: async () => tree("/work/new-wt") },
      ids(fresh),
    );
    expect(fork!.private).toBe(true);
    expect(fork!.worktreeCwd).toBe("/work/new-wt");
  });
});

