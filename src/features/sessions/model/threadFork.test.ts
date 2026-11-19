import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memoryReadableBlocks, UNREADABLE_BOUNDARY } from "../../memory/model/privateChat";
import { temporaryWorktreeBranchName, type Worktree } from "../../source-control/model/worktrees";
import { sanitizeSessionForPersist } from "../data/sessionStore";
import { pendingHandoff, wrapForkPrompt, wrapHandoffPrompt } from "./handoff";
import { newSession, type Attachment, type Block, type Session } from "./session";
import { clearThreadForkAsk, threadForkAskSnapshot } from "./threadForkAsk";
import {
  consumeForkPoint,
  forkAttemptGate,
  forkChat,
  forkFocusedChat,
  forkSessionAtMessage,
  forkStillValid,
  forkWorktreeDefault,
  forkWorktreeError,
  insertFork,
  lastForkableBlockId,
  pendingForkBrief,
  type ForkIds,
  type ForkImagePort,
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

  it("drops a move notice, so a fork does not keep a release owed", () => {
    const source = chat([
      block({ id: "note", role: "system", text: "{}", notice: "teleport-release-owed" }),
      block({ id: "u1", role: "user", text: "continue" }),
    ]);
    const fork = forkSessionAtMessage(source, "u1", ids(["fork-1", "b1", "b2"]));
    expect(fork).not.toBeNull();
    expect(fork!.blocks.some((entry) => (entry.notice ?? "").startsWith("teleport"))).toBe(false);
    expect(fork!.blocks.map((entry) => entry.text)).toEqual(["continue"]);
    expect(source.blocks.some((entry) => entry.notice === "teleport-release-owed")).toBe(true);
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

  // Review #231 r2 repro (MEDIUM): a More agents chat is saved with the placeholder harness `claude`, and its entry is
  // now the session's `registryAgentId` (the row). A fork copies the harness but not the entry, so "Fork from here" on
  // a More agents chat (offered on every chat: palette, ThreadForkHost) makes a Claude chat whose first send starts
  // Claude Code with the other agent's conversation as its recap. The fork should keep the entry (and so be routed to
  // it, or refused with the entry's own sentence).
  it("keeps a More agents chat's entry, so the fork does not run on the placeholder CLI", () => {
    const source = chat([block({ id: "u1", role: "user", text: "Hi" })], {
      registryAgentId: "my-copilot",
    });
    const fork = forkSessionAtMessage(source, "u1", ids(["fork-1", "b1"]))!;
    expect(fork.harness).toBe("claude");
    expect(fork.registryAgentId).toBe("my-copilot");
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
      { carryChanges: true },
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

describe("the first send from a fork", () => {
  function conversation(): Session {
    return chat([
      block({ id: "u1", role: "user", text: "Launch plan: ship on Friday" }),
      block({ id: "a1", role: "assistant", text: "Agreed, Friday it is" }),
      block({ id: "u2", role: "user", text: "Now plan the budget" }),
      block({ id: "a2", role: "assistant", text: "Budget draft" }),
    ]);
  }

  /** The calls App.tsx makes when a chat's next message goes out: a fork's recap, else a handoff's. */
  function firstPrompt(session: Session, typed: string): string | null {
    const owed = pendingForkBrief(session);
    if (owed) return wrapForkPrompt(owed.text, typed, owed.earlier);
    const handoff = pendingHandoff(session);
    return handoff ? wrapHandoffPrompt(handoff.text, handoff.from, typed) : null;
  }

  const fresh = ["fork-1", "b1", "b2"];

  it("carries the copied history, and nothing from after the fork point", () => {
    const fork = forkSessionAtMessage(conversation(), "a1", ids(fresh))!;
    const prompt = firstPrompt(fork, "And the budget?")!;
    expect(prompt).toContain("Launch plan: ship on Friday");
    expect(prompt).toContain("Agreed, Friday it is");
    expect(prompt).toContain("And the budget?");
    expect(prompt).not.toContain("Now plan the budget");
    expect(prompt).not.toContain("Budget draft");
  });

  it("is owed by a chat that was forked, and by no other", () => {
    expect(pendingForkBrief(conversation())).toBeNull();
    const fork = forkSessionAtMessage(conversation(), "a1", ids(fresh))!;
    expect(pendingForkBrief(fork)).not.toBeNull();
  });

  it("is still owed after the chat is saved and opened again", () => {
    const fork = forkSessionAtMessage(conversation(), "a1", ids(fresh))!;
    const saved = sanitizeSessionForPersist(fork);
    expect(saved.blocks.map((entry) => entry.forkPoint)).toEqual([undefined, true]);
    const reopened: Session = { ...fork, blocks: saved.blocks };
    expect(firstPrompt(reopened, "Next")).toContain("Launch plan: ship on Friday");
  });

  it("is owed once: a taken turn clears it, and the fork itself is not changed", () => {
    const fork = forkSessionAtMessage(conversation(), "a1", ids(fresh))!;
    const before = structuredClone(fork);
    const after = consumeForkPoint(fork);
    expect(pendingForkBrief(after)).toBeNull();
    expect(firstPrompt(after, "Next")).toBeNull();
    expect(pendingForkBrief(fork)).not.toBeNull();
    expect(fork).toEqual(before);
    expect(after.blocks.at(-1)).not.toBe(fork.blocks.at(-1));
    expect(after.blocks[0]).toBe(fork.blocks[0]);
    expect(consumeForkPoint(after)).toBe(after);
  });

  it("is still owed after a first message that failed, and names that message", () => {
    const fork = forkSessionAtMessage(conversation(), "a1", ids(fresh))!;
    const failed = {
      ...fork,
      blocks: [...fork.blocks, block({ id: "n1", role: "user", text: "Send the invoice" })],
    };
    const owed = pendingForkBrief(failed)!;
    expect(owed.text).toContain("Launch plan: ship on Friday");
    expect(owed.earlier).toEqual(["Send the invoice"]);
  });

  it("marks only its own last message when a fork is forked again", () => {
    const first = forkSessionAtMessage(conversation(), "a2", ids(["fork-1", "b1", "b2", "b3", "b4"]))!;
    const second = forkSessionAtMessage(first, first.blocks[3].id, ids(["fork-2", "c1", "c2", "c3", "c4"]))!;
    expect(second.blocks.filter((entry) => entry.forkPoint)).toHaveLength(1);
    expect(second.blocks.at(-1)!.forkPoint).toBe(true);
    const earlierPoint = forkSessionAtMessage(first, first.blocks[1].id, ids(["fork-3", "d1", "d2"]))!;
    expect(earlierPoint.blocks.filter((entry) => entry.forkPoint)).toHaveLength(1);
    expect(earlierPoint.blocks.at(-1)!.forkPoint).toBe(true);
  });

  it("does not repeat the user's messages after an older handoff divider", () => {
    const source = chat([
      block({ id: "u1", role: "user", text: "Launch plan: ship on Friday" }),
      block({
        id: "h1",
        role: "handoff",
        text: "old recap",
        handoff: { from: "codex", to: "claude", status: "ready" },
      }),
      block({ id: "u2", role: "user", text: "Said after the switch" }),
      block({ id: "a2", role: "assistant", text: "Done" }),
    ]);
    const fork = forkSessionAtMessage(source, "a2", ids(["fork-1", "b1", "b2", "b3", "b4"]))!;
    expect(pendingForkBrief(fork)!.earlier).toEqual([]);
  });

  it("is not owed when the copy has nothing a recap could say", () => {
    const source = chat([block({ id: "u1", role: "user", text: "   " })]);
    const fork = forkSessionAtMessage(source, "u1", ids(["fork-1", "b1"]))!;
    expect(pendingForkBrief(fork)).toBeNull();
  });
});

describe("the first send from a fork, as the app sends it", () => {
  // The send path lives in the App component, which a unit test cannot render. The model tests above build the
  // prompt the way App does; these read App so that dropping a call there fails here (the repo's other App guards).
  const app = readFileSync(`${process.cwd()}/src/app/App.tsx`, "utf8");

  it("asks for a fork's recap ahead of a handoff's, and not while a harness switch owns the send", () => {
    expect(app).toMatch(/const queuedFork =\s*live && !pendingSwitch \? pendingForkBrief\(current\) : null;/);
    expect(app).toMatch(/live && !pendingSwitch && !queuedFork \? pendingHandoff\(current\) : null/);
    expect(app).toMatch(/: \(queuedFork \?\? queuedHandoff\);/);
  });

  it("wraps the recap into the prompt like a handoff, with the messages typed since", () => {
    expect(app).toMatch(/const earlier = queuedFork\s*\? queuedFork\.earlier/);
    expect(app).toMatch(
      /wrapHandoffPrompt\(\s*wrap\.text,\s*wrap\.from,\s*turnPrompt\.trim\(\) \|\| CONTINUE_PROMPT,\s*earlier,\s*\)/,
    );
  });

  it("words a fork's recap as a fork's, and a handoff's as a handoff's", () => {
    expect(app).toMatch(
      /wrap\.fork\s*\? wrapForkPrompt\(\s*wrap\.text,\s*turnPrompt\.trim\(\) \|\| CONTINUE_PROMPT,\s*earlier,\s*\)\s*: wrapHandoffPrompt\(/,
    );
  });

  it("clears the saved fork point once a turn is taken, and leaves it for a slash command", () => {
    expect(app).toMatch(/rawCommand\s*\? ready\s*: consumeForkPoint\(consumeHandoff\(ready\)\)/);
  });
});

describe("the worktree a fork starts in", () => {
  const blocks = [block({ id: "u1", role: "user", text: "Hi" })];

  function run(source: Session) {
    let seen: unknown[] = [];
    const port: ForkWorktreePort = {
      createWorktree: async (...args) => {
        seen = args;
        return tree("/work/proj-fork");
      },
    };
    return forkChat(source, "u1", { useNewWorktree: true }, port, ids(["fork-1", "b1"])).then(
      () => seen,
    );
  }

  it("branches from the chat's own worktree, not from the project", async () => {
    const source = chat(blocks, { worktreeCwd: "/work/proj-wt-a", branch: "mc/a" });
    expect(await run(source)).toEqual([
      "/work/proj-wt-a",
      temporaryWorktreeBranchName("fork-1"),
      "HEAD",
      false,
      { carryChanges: true },
    ]);
  });

  it("branches from the project when the chat has no worktree", async () => {
    const source = chat(blocks, { worktreeCwd: undefined, branch: undefined });
    expect((await run(source))[0]).toBe("/work/proj");
  });

  it("branches from the project when the chat's worktree was deleted", async () => {
    const source = chat(blocks, { worktreeCwd: "/work/proj-wt-a", worktreeRemoved: true });
    expect((await run(source))[0]).toBe("/work/proj");
  });
});

describe("forking a chat with generated images", () => {
  const ONE = "/data/generated-images/one.png";
  const TWO = "/data/generated-images/two.png";

  function picture(id: string, path: string): Block {
    return {
      id,
      role: "image",
      text: "",
      image: { path, name: "cat.png", mimeType: "image/png", size: 10, alt: "a cat" },
    };
  }

  function conversation(): Session {
    return chat([
      block({ id: "u1", role: "user", text: "Draw a cat" }),
      picture("i1", ONE),
      block({ id: "a1", role: "assistant", text: "Here it is" }),
      picture("i2", TWO),
    ]);
  }

  function imagePort(over: Partial<ForkImagePort> = {}) {
    const calls: string[][] = [];
    const removed: string[][] = [];
    const port: ForkWorktreePort & ForkImagePort = {
      createWorktree: async () => tree("/work/proj-fork"),
      copyImage: async (path, name) => {
        calls.push([path, name]);
        return { path: path.replace(".png", "-copy.png"), mimeType: "image/png", size: 11 };
      },
      removeImages: async (paths) => {
        removed.push(paths);
      },
      ...over,
    };
    return { port, calls, removed };
  }

  it("gives the fork its own file and leaves the original alone", async () => {
    const source = conversation();
    const before = structuredClone(source);
    const { port, calls, removed } = imagePort();
    const fork = await forkChat(
      source,
      "a1",
      { useNewWorktree: false },
      port,
      ids(["fork-1", "b1", "b2", "b3"]),
    );
    expect(calls).toEqual([[ONE, "cat.png"]]);
    expect(fork!.blocks[1].image).toEqual({
      path: "/data/generated-images/one-copy.png",
      name: "cat.png",
      mimeType: "image/png",
      size: 11,
      alt: "a cat",
    });
    expect(fork!.blocks).toHaveLength(3);
    expect(removed).toEqual([]);
    expect(source).toEqual(before);
  });

  it("copies a file used by two messages once", async () => {
    const source = chat([
      block({ id: "u1", role: "user", text: "Draw" }),
      picture("i1", ONE),
      picture("i2", ONE),
      block({ id: "a1", role: "assistant", text: "Both" }),
    ]);
    const { port, calls } = imagePort();
    const fork = await forkChat(
      source,
      "a1",
      { useNewWorktree: false },
      port,
      ids(["fork-1", "b1", "b2", "b3", "b4"]),
    );
    expect(calls).toEqual([[ONE, "cat.png"]]);
    expect(fork!.blocks[1].image!.path).toBe("/data/generated-images/one-copy.png");
    expect(fork!.blocks[2].image!.path).toBe("/data/generated-images/one-copy.png");
  });

  it("refuses the fork, removes the copies already made, and creates no worktree when one cannot be copied", async () => {
    const source = chat([
      block({ id: "u1", role: "user", text: "Draw two" }),
      picture("i1", ONE),
      picture("i2", TWO),
      block({ id: "a1", role: "assistant", text: "Both" }),
    ]);
    let made = 0;
    let worktrees = 0;
    const { port, removed } = imagePort({
      copyImage: async (path) => {
        made += 1;
        if (made === 2) throw new Error("File is too large to attach inline.");
        return { path: path.replace(".png", "-copy.png"), mimeType: "image/png", size: 11 };
      },
    });
    port.createWorktree = async () => {
      worktrees += 1;
      return tree("/work/proj-fork");
    };
    await expect(
      forkChat(source, "a1", { useNewWorktree: true }, port, ids(["fork-1", "b1", "b2", "b3", "b4"])),
    ).rejects.toThrow(/^An image in this chat could not be copied\. Try again\.$/);
    expect(worktrees).toBe(0);
    expect(removed).toEqual([["/data/generated-images/one-copy.png"]]);
  });

  it("does not copy images that come after the fork point", async () => {
    const { port, calls } = imagePort();
    await forkChat(
      conversation(),
      "u1",
      { useNewWorktree: false },
      port,
      ids(["fork-1", "b1"]),
    );
    expect(calls).toEqual([]);
  });

  it("removes its copies when the message is gone by the time the worktree exists", async () => {
    const source = conversation();
    const { port, removed } = imagePort();
    const fork = await forkChat(
      source,
      "a1",
      { useNewWorktree: true, readSource: () => chat([]) },
      port,
      ids(["fork-1", "b1", "b2", "b3"]),
    );
    expect(fork).toBeNull();
    expect(removed).toEqual([["/data/generated-images/one-copy.png"]]);
  });

  it("refuses rather than share a path when no way to copy is given", async () => {
    const source = conversation();
    await expect(
      forkChat(
        source,
        "a1",
        { useNewWorktree: false },
        { createWorktree: async () => tree("/work/proj-fork") },
        ids(["fork-1", "b1", "b2", "b3"]),
      ),
    ).rejects.toThrow("An image in this chat could not be copied");
  });

  it("returns nothing from the plain copy when an image has no copy of its own", () => {
    expect(forkSessionAtMessage(conversation(), "a1", ids(["fork-1", "b1", "b2", "b3"]))).toBeNull();
  });
});

describe("a fork's worktree and the chat's uncommitted changes", () => {
  const NOTICE = "Uncommitted changes in this chat's worktree weren't copied.";
  const blocks = [block({ id: "u1", role: "user", text: "Hi" })];

  it("asks for the changes to come along", async () => {
    let options: unknown;
    const port: ForkWorktreePort = {
      createWorktree: async (_cwd, _branch, _base, _existing, given) => {
        options = given;
        return tree("/work/proj-fork");
      },
    };
    await forkChat(chat(blocks), "u1", { useNewWorktree: true }, port, ids(["fork-1", "b1"]));
    expect(options).toEqual({ carryChanges: true });
  });

  it("says so, and still makes the fork, when they could not be copied", async () => {
    const lines: string[] = [];
    const port: ForkWorktreePort = {
      createWorktree: async () => ({ ...tree("/work/proj-fork"), changesNotice: NOTICE }),
    };
    const fork = await forkChat(
      chat(blocks),
      "u1",
      { useNewWorktree: true, onNotice: (line) => lines.push(line) },
      port,
      ids(["fork-1", "b1"]),
    );
    expect(fork!.worktreeCwd).toBe("/work/proj-fork");
    expect(lines).toEqual([NOTICE]);
  });

  it("says nothing when they were copied, or when no worktree was asked for", async () => {
    const lines: string[] = [];
    const port: ForkWorktreePort = { createWorktree: async () => tree("/work/proj-fork") };
    await forkChat(
      chat(blocks),
      "u1",
      { useNewWorktree: true, onNotice: (line) => lines.push(line) },
      port,
      ids(["fork-1", "b1"]),
    );
    await forkChat(
      chat(blocks),
      "u1",
      { useNewWorktree: false, onNotice: (line) => lines.push(line) },
      port,
      ids(["fork-2", "b2"]),
    );
    expect(lines).toEqual([]);
  });
});

describe("a generated image whose file is not on this Mac", () => {
  // A chat imported from another Mac keeps a picture's name and caption with an empty path.
  const conversation = () =>
    chat([
      block({ id: "u1", role: "user", text: "Draw a cat" }),
      {
        id: "i1",
        role: "image",
        text: "",
        image: { path: "", name: "cat.png", mimeType: "image/png", size: 10, alt: "a cat" },
      } as Block,
      block({ id: "a1", role: "assistant", text: "Here" }),
    ]);

  it("forks as it is: nothing is copied and the block keeps what it says", async () => {
    const copied: string[] = [];
    const given: ForkWorktreePort & ForkImagePort = {
      createWorktree: async () => tree("/work/proj-fork"),
      copyImage: async (path) => {
        copied.push(path);
        return null;
      },
      removeImages: async () => {},
    };
    const fork = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: false },
      given,
      ids(["fork-1", "b1", "b2", "b3"]),
    );
    expect(copied).toEqual([]);
    expect(fork!.blocks.map((entry) => entry.role)).toEqual(["user", "image", "assistant"]);
    expect(fork!.blocks[1].image).toEqual({ path: "", name: "cat.png", mimeType: "image/png", size: 10, alt: "a cat" });
  });

  it("is not refused by the plain copy either", () => {
    const fork = forkSessionAtMessage(conversation(), "a1", ids(["fork-1", "b1", "b2", "b3"]), undefined, new Map());
    expect(fork).not.toBeNull();
    expect(fork!.blocks[1].image!.path).toBe("");
  });
});

describe("a generated image whose original is gone", () => {
  const ONE = "/data/generated-images/one.png";
  const TWO = "/data/generated-images/two.png";

  function picture(id: string, path: string): Block {
    return {
      id,
      role: "image",
      text: "",
      image: { path, name: "cat.png", mimeType: "image/png", size: 10, alt: "a cat" },
    };
  }

  const conversation = () =>
    chat([
      block({ id: "u1", role: "user", text: "Draw two cats" }),
      picture("i1", ONE),
      picture("i2", TWO),
      block({ id: "a1", role: "assistant", text: "Both" }),
    ]);

  function port(over: Partial<ForkImagePort> = {}) {
    const removed: string[][] = [];
    const given: ForkWorktreePort & ForkImagePort = {
      createWorktree: async () => tree("/work/proj-fork"),
      copyImage: async (path) =>
        path === ONE
          ? null
          : { path: path.replace(".png", "-copy.png"), mimeType: "image/png", size: 11 },
      removeImages: async (paths) => {
        removed.push(paths);
      },
      ...over,
    };
    return { given, removed };
  }

  it("is left out of the fork, which carries on with the other pictures", async () => {
    const source = conversation();
    const before = structuredClone(source);
    const { given, removed } = port();
    const fork = await forkChat(
      source,
      "a1",
      { useNewWorktree: false },
      given,
      ids(["fork-1", "b1", "b2", "b3", "b4"]),
    );
    expect(fork!.blocks.map((entry) => entry.text)).toEqual(["Draw two cats", "", "", "Both"]);
    expect(fork!.blocks[1].image).toBeUndefined();
    expect(fork!.blocks[2].image!.path).toBe("/data/generated-images/two-copy.png");
    expect(removed).toEqual([]);
    expect(source).toEqual(before);
  });

  it("still lets a fork with a worktree through", async () => {
    const { given } = port();
    const fork = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: true },
      given,
      ids(["fork-1", "b1", "b2", "b3", "b4"]),
    );
    expect(fork!.worktreeCwd).toBe("/work/proj-fork");
    expect(fork!.blocks[1].image).toBeUndefined();
  });

  it("is not the same as a copy that failed: that refuses with a sentence and no path", async () => {
    const { given, removed } = port({
      copyImage: async (path) => {
        if (path === TWO) throw new Error(`${TWO}: Permission denied (os error 13)`);
        return { path: path.replace(".png", "-copy.png"), mimeType: "image/png", size: 11 };
      },
    });
    const refusal = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: false },
      given,
      ids(["fork-1", "b1", "b2", "b3", "b4"]),
    ).catch((error: unknown) => error as Error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe("An image in this chat could not be copied. Try again.");
    expect((refusal as Error).message).not.toContain("/data");
    expect((refusal as Error).message).not.toContain("os error");
    expect(removed).toEqual([["/data/generated-images/one-copy.png"]]);
  });

  it("names a window that cannot copy images without a path", async () => {
    const refusal = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: false },
      { createWorktree: async () => tree("/work/proj-fork") },
      ids(["fork-1", "b1", "b2", "b3", "b4"]),
    ).catch((error: unknown) => error as Error);
    expect((refusal as Error).message).toBe("An image in this chat could not be copied. Try again.");
  });
});

describe("cancelling a fork", () => {
  const IMG = "/data/generated-images/one.png";
  const conversation = () =>
    chat(
      [
        block({ id: "u1", role: "user", text: "Draw a cat" }),
        {
          id: "i1",
          role: "image",
          text: "",
          image: { path: IMG, name: "cat.png", mimeType: "image/png", size: 10 },
        },
        block({ id: "a1", role: "assistant", text: "Here it is" }),
      ],
      { worktreeCwd: "/work/proj-wt-a" },
    );

  function ledger() {
    const events: string[] = [];
    const port = {
      createWorktree: async () => {
        events.push("worktree made");
        return tree("/work/proj-fork");
      },
      removeWorktree: async (cwd: string, path: string, force: boolean) => {
        events.push(`worktree removed ${cwd} ${path} ${force}`);
      },
      copyImage: async (path: string) => {
        events.push("image copied");
        return { path: path.replace(".png", "-copy.png"), mimeType: "image/png", size: 11 };
      },
      removeImages: async (paths: string[]) => {
        events.push(`images removed ${paths.join(",")}`);
      },
    } satisfies ForkWorktreePort & ForkImagePort;
    return { events, port };
  }
  const COPY = "/data/generated-images/one-copy.png";
  const fresh = ["fork-1", "b1", "b2", "b3"];

  it("removes the worktree it made and the image copies when cancelled while the worktree is created", async () => {
    const { events, port } = ledger();
    let cancelled = false;
    const slow = {
      ...port,
      createWorktree: async () => {
        cancelled = true;
        return port.createWorktree();
      },
    };
    const fork = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: true, cancelled: () => cancelled },
      slow,
      ids(fresh),
    );
    expect(fork).toBeNull();
    expect(events).toEqual([
      "image copied",
      "worktree made",
      `images removed ${COPY}`,
      "worktree removed /work/proj-wt-a /work/proj-fork true",
    ]);
  });

  it("removes the image copies when cancelled while they are copied, and makes no worktree", async () => {
    const { events, port } = ledger();
    let cancelled = false;
    const fork = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: true, cancelled: () => cancelled },
      {
        ...port,
        copyImage: async (path, name) => {
          cancelled = true;
          return port.copyImage(path, name);
        },
      },
      ids(fresh),
    );
    expect(fork).toBeNull();
    expect(events).toEqual(["image copied", `images removed ${COPY}`]);
  });

  it("still removes everything when the cancel lands while a copy the fork did not use is removed", async () => {
    const { events, port } = ledger();
    let cancelled = false;
    // The picture was deleted from the chat while the worktree was being made, so its copy goes unused.
    const edited = chat(
      [block({ id: "u1", role: "user", text: "Draw a cat" }), block({ id: "a1", role: "assistant", text: "Here it is" })],
      { worktreeCwd: "/work/proj-wt-a" },
    );
    const fork = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: true, readSource: () => edited, cancelled: () => cancelled },
      {
        ...port,
        removeImages: async (paths) => {
          cancelled = true;
          return port.removeImages(paths);
        },
      },
      ids(fresh),
    );
    expect(fork).toBeNull();
    // The unused copy is removed once, then the worktree; nothing is removed twice.
    expect(events).toEqual([
      "image copied",
      "worktree made",
      `images removed ${COPY}`,
      "worktree removed /work/proj-wt-a /work/proj-fork true",
    ]);
  });

  it("keeps everything when it is not cancelled", async () => {
    const { events, port } = ledger();
    const fork = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: true, cancelled: () => false },
      port,
      ids(fresh),
    );
    expect(fork!.blocks[1].image!.path).toBe(COPY);
    expect(fork!.worktreeCwd).toBe("/work/proj-fork");
    expect(events).toEqual(["image copied", "worktree made"]);
  });

  it("removes the worktree too when the message is gone by the time the worktree exists", async () => {
    const { events, port } = ledger();
    const fork = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: true, readSource: () => chat([]) },
      port,
      ids(fresh),
    );
    expect(fork).toBeNull();
    expect(events).toEqual([
      "image copied",
      "worktree made",
      `images removed ${COPY}`,
      "worktree removed /work/proj-wt-a /work/proj-fork true",
    ]);
  });

  it("removes the worktree and the copies when the fork cannot be finished", async () => {
    const { events, port } = ledger();
    await expect(
      forkChat(
        conversation(),
        "a1",
        { useNewWorktree: true },
        { ...port, createWorktree: async () => ({ ...tree("/work/proj-fork"), path: "" }) },
        ids(fresh),
      ),
    ).rejects.toThrow("The new worktree could not be created.");
    // The tree has no path, so there is nothing to remove; the copies still go.
    expect(events).toEqual(["image copied", `images removed ${COPY}`]);
  });

  it("does not fail the fork's own refusal when the clean-up fails", async () => {
    const { port } = ledger();
    const fork = await forkChat(
      conversation(),
      "a1",
      { useNewWorktree: true, readSource: () => chat([]) },
      {
        ...port,
        removeWorktree: async () => {
          throw new Error("busy");
        },
        removeImages: async () => {
          throw new Error("busy");
        },
      },
      ids(fresh),
    );
    expect(fork).toBeNull();
  });
});
