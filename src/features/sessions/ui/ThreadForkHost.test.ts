// @vitest-environment happy-dom
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Worktree } from "../../source-control/model/worktrees";
import { memoryReadableBlocks } from "../../memory/model/privateChat";
import { newSession, type Block, type Session } from "../model/session";
import { pendingForkBrief, type ForkPort, type ForkWorktreePort } from "../model/threadFork";
import { askThreadFork, clearThreadForkAsk } from "../model/threadForkAsk";
import { ForkFromHereButton } from "./ForkFromHereButton";
import { ThreadForkHost } from "./ThreadForkHost";

let root: Root;
let host: HTMLDivElement;

function block(id: string, role: Block["role"], text: string): Block {
  return { id, role, text };
}

function chat(): Session {
  return {
    ...newSession("claude", "/work/proj"),
    id: "sess-1",
    title: "Plan",
    providerSessionId: "provider-1",
    blocks: [
      block("u1", "user", "First"),
      block("a1", "assistant", "Answer"),
      block("u2", "user", "Later"),
    ],
  };
}

const DIRTY =
  "error: Your local changes to the following files would be overwritten by checkout:\n\tfile.txt\nPlease commit your changes or stash them before you switch branches.";
const TAKEN = "This branch already has a working copy. Select it from the picker.";

function worktree(path = "/work/proj-wt"): Worktree {
  return {
    path,
    branch: "mc/fork",
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  clearThreadForkAsk();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearThreadForkAsk();
});

it("opens a copy up to the chosen message and leaves the original", async () => {
  const source = chat();
  const before = structuredClone(source);
  const ref = { current: [source] } as RefObject<Session[]>;
  const opened: Session[] = [];
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
      }),
    );
  });
  act(() => askThreadFork(source.id, "a1"));
  const dialog = document.querySelector("[data-thread-fork-dialog]");
  expect(dialog?.textContent).toContain("Fork this chat?");
  expect(dialog?.textContent).toContain(
    "A new chat keeps the messages up to here. This chat stays as it is.",
  );
  expect(dialog?.textContent).not.toMatch(/[—–]/);
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].id).not.toBe(source.id);
  expect(opened[0].blocks.map((entry) => entry.text)).toEqual(["First", "Answer"]);
  expect(opened[0].blocks.map((entry) => entry.id)).not.toEqual(["u1", "a1"]);
  expect(opened[0].providerSessionId).toBeUndefined();
  expect(source).toEqual(before);
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();
});

it("does not open a chat when the message or the chat is already gone", async () => {
  const source = chat();
  const ref = { current: [source] } as RefObject<Session[]>;
  const opened: Session[] = [];
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
      }),
    );
  });
  act(() => askThreadFork(source.id, "missing"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(0);
  expect(document.querySelector("[role=alert]")?.textContent).toBe(
    "That message is no longer in this chat.",
  );

  act(() => askThreadFork("gone", "u1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(0);
  expect(document.querySelector("[role=alert]")?.textContent).toBe(
    "This chat is no longer open.",
  );
  expect(source.blocks).toHaveLength(3);
});

it("opens one chat when Fork is clicked twice before the dialog closes", async () => {
  const source = chat();
  const ref = { current: [source] } as RefObject<Session[]>;
  const opened: Session[] = [];
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
      }),
    );
  });
  act(() => askThreadFork(source.id, "u1"));
  const button = document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]");
  await act(async () => {
    button?.click();
    button?.click();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].blocks.map((entry) => entry.text)).toEqual(["First"]);
});

it("cancel closes the dialog and does not open a chat", async () => {
  const source = chat();
  const ref = { current: [source] } as RefObject<Session[]>;
  const opened: Session[] = [];
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
      }),
    );
  });
  act(() => askThreadFork(source.id, "u1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-cancel]")?.click();
  });
  expect(opened).toHaveLength(0);
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();
});

it("names the message action Fork from here", async () => {
  const asked: string[] = [];
  await act(async () => {
    root.render(
      createElement(ForkFromHereButton, {
        blockId: "u1",
        onFork: (id) => asked.push(id),
      }),
    );
  });
  const button = host.querySelector<HTMLButtonElement>("[data-fork-from-here]");
  expect(button?.getAttribute("aria-label")).toBe("Fork from here");
  expect(button?.textContent).not.toMatch(/[—–]/);
  await act(async () => {
    button?.click();
  });
  expect(asked).toEqual(["u1"]);
});

async function renderHost(
  source: Session,
  opened: Session[],
  options: { port?: ForkPort; setting?: () => unknown } = {},
) {
  const ref = { current: [source] } as RefObject<Session[]>;
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: ref,
        onOpen: (session) => opened.push(session),
        port: options.port,
        setting: options.setting,
      }),
    );
  });
  return ref;
}

function worktreeBox(): HTMLInputElement {
  const box = document.querySelector<HTMLInputElement>("[data-thread-fork-worktree]");
  if (!box) throw new Error("missing worktree checkbox");
  return box;
}

it("starts from the worktree setting and still lets the person choose", async () => {
  const source = chat();
  const calls: string[] = [];
  const port: ForkWorktreePort = {
    createWorktree: async (cwd) => {
      calls.push(cwd);
      return worktree("C:\\work\\my notes\\wt");
    },
  };
  const opened: Session[] = [];
  let setting = "ask";
  await renderHost(source, opened, { port, setting: () => setting });
  act(() => askThreadFork(source.id, "u1"));
  expect(worktreeBox().checked).toBe(true);
  expect(worktreeBox().labels?.[0]?.textContent).toContain(
    "Start the new chat in its own worktree.",
  );
  setting = "off";
  await act(async () => {
    root.render(
      createElement(ThreadForkHost, {
        sessionsRef: { current: [source] } as RefObject<Session[]>,
        onOpen: (session) => opened.push(session),
        port,
        setting: () => setting,
      }),
    );
  });
  expect(worktreeBox().checked).toBe(true);
  await act(async () => {
    worktreeBox().click();
  });
  expect(worktreeBox().checked).toBe(false);
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(calls).toEqual([]);
  expect(opened).toHaveLength(1);
  expect(opened[0].worktreeCwd).toBeUndefined();
  expect(document.body.textContent).not.toMatch(/[—–]/);
});

it("can turn the worktree on when the setting is off, and keeps a path with spaces", async () => {
  const source = { ...chat(), cwd: "C:\\work\\my notes" };
  const calls: unknown[][] = [];
  const port: ForkWorktreePort = {
    createWorktree: async (...args) => {
      calls.push(args);
      return worktree("C:\\work\\my notes\\wt");
    },
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "off" });
  act(() => askThreadFork(source.id, "a1"));
  expect(worktreeBox().checked).toBe(false);
  await act(async () => {
    worktreeBox().click();
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(calls[0]?.[0]).toBe("C:\\work\\my notes");
  expect(calls[0]?.[2]).toBe("HEAD");
  expect(calls[0]?.[3]).toBe(false);
  expect(opened).toHaveLength(1);
  expect(opened[0].worktreeCwd).toBe("C:\\work\\my notes\\wt");
  expect(opened[0].blocks.map((entry) => entry.text)).toEqual(["First", "Answer"]);
  expect(source.blocks.map((entry) => entry.text)).toEqual(["First", "Answer", "Later"]);
});

it("shows a worktree refusal and does not open a chat", async () => {
  const source = chat();
  const before = structuredClone(source);
  const messages = [DIRTY, TAKEN, "fatal: not a git repository (or any of the parent directories): .git"];
  let attempt = 0;
  const port: ForkWorktreePort = {
    createWorktree: async () => {
      throw new Error(messages[attempt]);
    },
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  for (const message of messages) {
    act(() => askThreadFork(source.id, "u1"));
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
    });
    expect(document.querySelector("[role=alert]")?.textContent).toBe(message);
    expect(opened).toHaveLength(0);
    expect(document.querySelector("[data-thread-fork-dialog]")).not.toBeNull();
    attempt += 1;
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-thread-fork-cancel]")?.click();
    });
  }
  expect(source).toEqual(before);
});

it("drops a late worktree when the dialog was cancelled or the message was removed", async () => {
  const source = chat();
  const pending = deferred<Worktree>();
  let calls = 0;
  const port: ForkWorktreePort = {
    createWorktree: () => {
      calls += 1;
      return pending.promise;
    },
  };
  const opened: Session[] = [];
  const ref = await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "u1"));
  await act(async () => {
    const button = document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]");
    button?.click();
    button?.click();
  });
  expect(calls).toBe(1);
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-cancel]")?.click();
  });
  await act(async () => {
    pending.resolve(worktree());
  });
  expect(opened).toHaveLength(0);
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();

  const again = deferred<Worktree>();
  const port2: ForkWorktreePort = { createWorktree: () => again.promise };
  const opened2: Session[] = [];
  const ref2 = await renderHost(source, opened2, { port: port2, setting: () => "always" });
  act(() => askThreadFork(source.id, "u1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  ref2.current = [{ ...source, blocks: source.blocks.filter((entry) => entry.id !== "u1") }];
  await act(async () => {
    again.resolve(worktree("/work/left"));
  });
  expect(opened2).toHaveLength(0);
  expect(document.querySelector("[role=alert]")?.textContent).toBe(
    "That message is no longer in this chat.",
  );
  expect(ref.current[0]).toBe(source);
});

it("keeps an edit made while the worktree is created, and not a later message", async () => {
  const source = chat();
  const pending = deferred<Worktree>();
  const port: ForkWorktreePort = { createWorktree: () => pending.promise };
  const opened: Session[] = [];
  const ref = await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  ref.current = [
    {
      ...source,
      blocks: [
        block("u1", "user", "First, edited"),
        block("a1", "assistant", "Answer, edited"),
        block("u2", "user", "Later"),
        block("u3", "user", "Added while waiting"),
      ],
    },
  ];
  await act(async () => {
    pending.resolve(worktree("/work/proj-wt"));
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].blocks.map((entry) => entry.text)).toEqual([
    "First, edited",
    "Answer, edited",
  ]);
  expect(opened[0].worktreeCwd).toBe("/work/proj-wt");
  expect(source.blocks[0].text).toBe("First");
});

it("treats a timeout as something to try again, not a finished failure", async () => {
  const source = chat();
  let calls = 0;
  const port: ForkWorktreePort = {
    createWorktree: async () => {
      calls += 1;
      if (calls === 1) throw new Error("The worktree create timed out");
      return worktree();
    },
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "u1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(document.querySelector("[role=alert]")?.textContent).toBe(
    "The worktree create timed out",
  );
  expect(opened).toHaveLength(0);
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].blocks.map((entry) => entry.text)).toEqual(["First"]);
});

it("opens a fork of a private chat as private, and keeps what was private unread", async () => {
  const source = { ...chat(), private: true, privateBoundaryId: "u1" };
  const opened: Session[] = [];
  await renderHost(source, opened);
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].private).toBe(true);
  expect(memoryReadableBlocks(opened[0])).toEqual([]);
  expect(opened[0].privateBoundaryId).toBe(opened[0].blocks[0].id);
  expect(source.private).toBe(true);
  expect(source.privateBoundaryId).toBe("u1");
});

it("opens a fork that owes its history to the first send", async () => {
  const source = chat();
  const opened: Session[] = [];
  await renderHost(source, opened);
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  const owed = pendingForkBrief(opened[0]);
  expect(owed?.text).toContain("First");
  expect(owed?.text).toContain("Answer");
  expect(owed?.text).not.toContain("Later");
  expect(pendingForkBrief(source)).toBeNull();
});

it("starts the new worktree from the chat's own worktree", async () => {
  const source = { ...chat(), worktreeCwd: "/work/proj-wt-a", branch: "mc/a" };
  const calls: unknown[][] = [];
  const port: ForkWorktreePort = {
    createWorktree: async (...args) => {
      calls.push(args);
      return worktree("/work/proj-wt-b");
    },
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(calls[0]?.[0]).toBe("/work/proj-wt-a");
  expect(calls[0]?.[2]).toBe("HEAD");
  expect(opened[0].worktreeCwd).toBe("/work/proj-wt-b");
});

function pictureChat(): Session {
  return {
    ...chat(),
    blocks: [
      block("u1", "user", "Draw a cat"),
      {
        id: "i1",
        role: "image",
        text: "",
        image: {
          path: "/data/generated-images/one.png",
          name: "cat.png",
          mimeType: "image/png",
          size: 10,
        },
      },
      block("a1", "assistant", "Here it is"),
    ],
  };
}

it("gives the fork its own copy of a generated image", async () => {
  const source = pictureChat();
  const copied: string[] = [];
  const port: ForkPort = {
    createWorktree: async () => worktree(),
    copyImage: async (path) => {
      copied.push(path);
      return { path: "/data/generated-images/copy.png", mimeType: "image/png", size: 10 };
    },
    removeImages: async () => {},
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "off" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(copied).toEqual(["/data/generated-images/one.png"]);
  expect(opened).toHaveLength(1);
  expect(opened[0].blocks[1].image?.path).toBe("/data/generated-images/copy.png");
  expect(source.blocks[1].image?.path).toBe("/data/generated-images/one.png");
});

it("shows why an image could not be copied, opens no chat and makes no worktree", async () => {
  const source = pictureChat();
  let worktrees = 0;
  const port: ForkPort = {
    createWorktree: async () => {
      worktrees += 1;
      return worktree();
    },
    copyImage: async () => {
      throw new Error("/data/generated-images/one.png: Permission denied (os error 13)");
    },
    removeImages: async () => {},
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(document.querySelector("[role=alert]")?.textContent).toBe(
    "An image in this chat could not be copied. Try again.",
  );
  expect(document.querySelector("[role=alert]")?.textContent).not.toMatch(/[—–]/);
  expect(opened).toHaveLength(0);
  expect(worktrees).toBe(0);
});

it("opens the fork without a picture whose original is gone", async () => {
  const source = pictureChat();
  const port: ForkPort = {
    createWorktree: async () => worktree(),
    copyImage: async () => null,
    removeImages: async () => {},
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "off" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(opened).toHaveLength(1);
  expect(opened[0].blocks.map((entry) => entry.text)).toEqual(["Draw a cat", "", "Here it is"]);
  expect(opened[0].blocks[1].image).toBeUndefined();
  expect(source.blocks[1].image?.path).toBe("/data/generated-images/one.png");
});

const NOTICE = "Uncommitted changes in this chat's worktree weren't copied.";

function noticePort(over: Partial<ForkPort> = {}) {
  const removed: string[] = [];
  const port: ForkPort = {
    createWorktree: async () => ({ ...worktree("/work/proj-fork"), changesNotice: NOTICE }),
    removeWorktree: async (_cwd, path) => {
      removed.push(path);
    },
    ...over,
  };
  return { port, removed };
}

it("opens the fork and says on the confirm that the uncommitted changes were not copied", async () => {
  const source = chat();
  const { port, removed } = noticePort();
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0].worktreeCwd).toBe("/work/proj-fork");
  const dialog = document.querySelector("[data-thread-fork-dialog]");
  expect(dialog).not.toBeNull();
  expect(document.querySelector("[data-thread-fork-notice]")?.textContent).toBe(NOTICE);
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(dialog?.textContent).not.toMatch(/[—–]/);
  // It is a note about a chat that already exists: no second fork, no worktree choice, no cancel.
  expect(document.querySelector("[data-thread-fork-confirm]")).toBeNull();
  expect(document.querySelector("[data-thread-fork-worktree]")).toBeNull();
  expect(document.querySelector("[data-thread-fork-cancel]")).toBeNull();
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-done]")?.click();
  });
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();
  expect(opened).toHaveLength(1);
  expect(removed).toEqual([]);
});

it("keeps the fork and its worktree when the note is dismissed with Escape", async () => {
  const source = chat();
  const { port, removed } = noticePort();
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();
  expect(opened).toHaveLength(1);
  expect(removed).toEqual([]);
});

it("shows no note when the changes were copied", async () => {
  const source = chat();
  const opened: Session[] = [];
  const port: ForkPort = { createWorktree: async () => worktree("/work/proj-fork") };
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(1);
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();
});

it("removes the worktree and the image copies when cancelled while the worktree is created", async () => {
  const source = { ...pictureChat(), worktreeCwd: "/work/proj-wt-a" };
  const pending = deferred<Worktree>();
  const removedTrees: unknown[][] = [];
  const removedImages: string[][] = [];
  const port: ForkPort = {
    createWorktree: () => pending.promise,
    removeWorktree: async (...args) => {
      removedTrees.push(args);
    },
    copyImage: async () => ({ path: "/data/generated-images/copy.png", mimeType: "image/png", size: 10 }),
    removeImages: async (paths) => {
      removedImages.push(paths);
    },
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-cancel]")?.click();
  });
  expect(removedTrees).toEqual([]);
  await act(async () => {
    pending.resolve(worktree("/work/proj-fork"));
  });
  expect(opened).toHaveLength(0);
  expect(removedTrees).toEqual([["/work/proj-wt-a", "/work/proj-fork", true]]);
  expect(removedImages).toEqual([["/data/generated-images/copy.png"]]);
  expect(document.querySelector("[data-thread-fork-dialog]")).toBeNull();
});

it("removes the image copies when cancelled while they are copied, and makes no worktree", async () => {
  const source = pictureChat();
  const copying = deferred<{ path: string; mimeType: string; size: number }>();
  let worktrees = 0;
  const removedImages: string[][] = [];
  const port: ForkPort = {
    createWorktree: async () => {
      worktrees += 1;
      return worktree();
    },
    copyImage: () => copying.promise,
    removeImages: async (paths) => {
      removedImages.push(paths);
    },
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-cancel]")?.click();
  });
  await act(async () => {
    copying.resolve({ path: "/data/generated-images/copy.png", mimeType: "image/png", size: 10 });
  });
  expect(opened).toHaveLength(0);
  expect(worktrees).toBe(0);
  expect(removedImages).toEqual([["/data/generated-images/copy.png"]]);
});

it("keeps the copies and the worktree of a fork that was not cancelled", async () => {
  const source = pictureChat();
  const removedTrees: unknown[][] = [];
  const removedImages: string[][] = [];
  const port: ForkPort = {
    createWorktree: async () => worktree("/work/proj-fork"),
    removeWorktree: async (...args) => {
      removedTrees.push(args);
    },
    copyImage: async () => ({ path: "/data/generated-images/copy.png", mimeType: "image/png", size: 10 }),
    removeImages: async (paths) => {
      removedImages.push(paths);
    },
  };
  const opened: Session[] = [];
  await renderHost(source, opened, { port, setting: () => "always" });
  act(() => askThreadFork(source.id, "a1"));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-thread-fork-confirm]")?.click();
  });
  expect(opened).toHaveLength(1);
  expect(removedTrees).toEqual([]);
  expect(removedImages).toEqual([]);
});
