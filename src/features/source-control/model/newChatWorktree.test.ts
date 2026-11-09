import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";
import { newSession } from "../../sessions/model/session";
import type { NewChatWorktree } from "../../settings/model/settings";
import type { Worktree } from "./worktrees";
import {
  beginNewChatWorktreeOffer,
  clearUnconfirmedNewChatWorktree,
  confirmNewChatWorktreeOffer,
  flippedNewChatWorktree,
  forgetNewChatFolderChoice,
  newChatStaysHere,
  newChatWorktreeAskLine,
  noteNewChatFolderChoice,
  openNewChatWorktree,
  resetNewChatFolderChoices,
  NEW_CHAT_WORKTREE_ASK,
  type NewChatWorktreePort,
} from "./newChatWorktree";

const DIRTY =
  "error: Your local changes to the following files would be overwritten by checkout:\n\tfile.txt\nPlease commit your changes or stash them before you switch branches.";
const TAKEN = "This branch already has a working copy. Select it from the picker.";

function chat(over: Partial<Session> = {}): Session {
  const session = newSession("claude", "/work/proj");
  return { ...session, ...over, id: over.id ?? session.id, cwd: over.cwd ?? session.cwd };
}

function tree(path = "/work/proj-wt", dirty: boolean | null = false): Worktree {
  return {
    path,
    branch: "mc/abcd1234",
    head: "abc",
    isMain: false,
    locked: false,
    prunable: false,
    missing: false,
    dirty,
    unpushed: 0,
    sessionIds: [],
  };
}

function port(overrides: Partial<NewChatWorktreePort> = {}): NewChatWorktreePort {
  return {
    gitOnThisComputer: vi.fn(async () => true),
    createWorktree: vi.fn(async () => tree()),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetNewChatFolderChoices();
});

describe("openNewChatWorktree", () => {
  it("does nothing when the setting is off and the toggle is off", async () => {
    const create = vi.fn();
    const git = vi.fn();
    const opened = await openNewChatWorktree(
      { setting: "off", firstTurn: true, toggleOn: false, declined: false, cwd: "/work/proj", base: "HEAD" },
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(opened).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it("creates when the toggle is on, without asking whether the folder is a git repo", async () => {
    const create = vi.fn(async () => tree());
    const git = vi.fn();
    const opened = await openNewChatWorktree(
      { setting: "off", firstTurn: true, toggleOn: true, declined: false, cwd: "/work/my proj", base: "" },
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(opened?.path).toBe("/work/proj-wt");
    expect(git).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const [cwd, branch, base, existing] = create.mock.calls[0];
    expect(cwd).toBe("/work/my proj");
    expect(branch).toMatch(/^mc\/[a-z0-9]{1,8}$/);
    expect(base).toBe("HEAD");
    expect(existing).toBe(false);
  });

  it("passes a chosen base through and still creates for ask when the toggle is on", async () => {
    const create = vi.fn(async () => tree());
    const opened = await openNewChatWorktree(
      { setting: "ask", firstTurn: false, toggleOn: true, declined: false, cwd: "/work/proj/../proj", base: "origin/main" },
      port({ createWorktree: create }),
    );
    expect(opened).not.toBeNull();
    expect(create.mock.calls[0][2]).toBe("origin/main");
    expect(create.mock.calls[0][0]).toBe("/work/proj/../proj");
  });

  it("does not create for ask when the toggle is off", async () => {
    const create = vi.fn();
    const git = vi.fn(async () => true);
    const opened = await openNewChatWorktree(
      { setting: "ask", firstTurn: true, toggleOn: false, declined: false, cwd: "/work/proj", base: "HEAD" },
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(opened).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it("creates for always on a first turn in a git repo, even when the toggle is still off", async () => {
    const create = vi.fn(async () => tree("/wt/feature"));
    const git = vi.fn(async () => true);
    const opened = await openNewChatWorktree(
      { setting: "always", firstTurn: true, toggleOn: false, declined: false, cwd: "/work/proj", base: "HEAD" },
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(opened?.path).toBe("/wt/feature");
    expect(git).toHaveBeenCalledWith("/work/proj");
    expect(create.mock.calls[0][1]).toMatch(/^mc\//);
    expect(create.mock.calls[0][3]).toBe(false);
  });

  it("skips always when the folder is not a git repo, and does not store that answer", async () => {
    const create = vi.fn();
    const git = vi.fn(async () => false);
    const opened = await openNewChatWorktree(
      { setting: "always", firstTurn: true, toggleOn: false, declined: false, cwd: "/work/notes", base: "HEAD" },
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(opened).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(git).toHaveBeenCalledTimes(1);
  });

  it("treats a git check that throws as a skip, not a stored failure", async () => {
    const create = vi.fn();
    const git = vi.fn(async () => {
      throw new Error("timed out");
    });
    const opened = await openNewChatWorktree(
      { setting: "always", firstTurn: true, toggleOn: false, declined: false, cwd: "/work/proj", base: "HEAD" },
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(opened).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not create for always when this is not a new chat", async () => {
    const create = vi.fn();
    const git = vi.fn();
    const opened = await openNewChatWorktree(
      { setting: "always", firstTurn: false, toggleOn: false, declined: false, cwd: "/work/proj", base: "HEAD" },
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(opened).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it("does not create for always after the person chose this folder", async () => {
    const create = vi.fn();
    const opened = await openNewChatWorktree(
      { setting: "always", firstTurn: true, toggleOn: false, declined: true, cwd: "/work/proj", base: "HEAD" },
      port({ createWorktree: create }),
    );
    expect(opened).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["", "~", "/", "remote://box/work/proj"])(
    "does not create for always in %j, and does not ask git",
    async (cwd) => {
      const create = vi.fn();
      const git = vi.fn();
      const opened = await openNewChatWorktree(
        { setting: "always", firstTurn: true, toggleOn: false, declined: false, cwd, base: "HEAD" },
        port({ createWorktree: create, gitOnThisComputer: git }),
      );
      expect(opened).toBeNull();
      expect(create).not.toHaveBeenCalled();
      expect(git).not.toHaveBeenCalled();
    },
  );

  it("keeps a refusal message exactly, and does not return a tree", async () => {
    for (const message of [DIRTY, TAKEN, "This worktree has uncommitted or untracked changes."]) {
      const create = vi.fn(async () => {
        throw new Error(message);
      });
      await expect(
        openNewChatWorktree(
          { setting: "off", firstTurn: true, toggleOn: true, declined: false, cwd: "/work/proj", base: "HEAD" },
          port({ createWorktree: create }),
        ),
      ).rejects.toThrow(message);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("returns the tree when creation accepts a dirty folder", async () => {
    const create = vi.fn(async () => tree("/wt/dirty", true));
    const opened = await openNewChatWorktree(
      { setting: "always", firstTurn: true, toggleOn: false, declined: false, cwd: "/work/proj", base: "HEAD" },
      port({ createWorktree: create, gitOnThisComputer: async () => true }),
    );
    expect(opened?.dirty).toBe(true);
    expect(opened?.path).toBe("/wt/dirty");
  });

  it("still creates from the toggle when the person had declined and switched it back on", async () => {
    const create = vi.fn(async () => tree());
    const opened = await openNewChatWorktree(
      { setting: "always", firstTurn: true, toggleOn: true, declined: true, cwd: "/work/proj", base: "HEAD" },
      port({ createWorktree: create }),
    );
    expect(opened).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("the offer on a new chat", () => {
  it("switches a blank local chat to a worktree for ask and always", () => {
    for (const setting of ["ask", "always"] as const) {
      const target = chat({ id: setting, cwd: "/work/proj" });
      const other = chat({ id: "other", cwd: "/work/other" });
      const next = beginNewChatWorktreeOffer([other, target], setting, "/work/proj/", setting);
      expect(next?.[0]).toBe(other);
      const offered = next?.find((session) => session.id === setting);
      expect(offered?.workspaceMode).toBe("worktree");
      expect(offered?.worktreeBase).toBe("HEAD");
    }
  });

  it("keeps a base the chat already has", () => {
    const target = chat({ id: "s", cwd: "/work/proj", worktreeBase: "release" });
    const next = beginNewChatWorktreeOffer([target], "s", "/work/proj", "ask");
    expect(next?.[0].worktreeBase).toBe("release");
    expect(next?.[0].workspaceMode).toBe("worktree");
  });

  it("is a no-op for off, an unknown value, a second offer, and chats that are not a new local one", () => {
    const blank = chat({ id: "s", cwd: "/work/proj" });
    expect(beginNewChatWorktreeOffer([blank], "s", "/work/proj", "off")).toBeNull();
    expect(beginNewChatWorktreeOffer([blank], "s", "/work/proj", "sometimes" as NewChatWorktree)).toBeNull();
    const offered = beginNewChatWorktreeOffer([blank], "s", "/work/proj", "ask");
    expect(offered).not.toBeNull();
    expect(beginNewChatWorktreeOffer(offered!, "s", "/work/proj", "ask")).toBeNull();

    const started = chat({
      id: "started",
      blocks: [{ role: "user" } as Session["blocks"][number]],
    });
    expect(beginNewChatWorktreeOffer([started], "started", "/work/proj", "always")).toBeNull();
    expect(beginNewChatWorktreeOffer([chat({ id: "busy", busy: true })], "busy", "/work/proj", "ask")).toBeNull();
    expect(
      beginNewChatWorktreeOffer([chat({ id: "tree", worktreeCwd: "/wt" })], "tree", "/work/proj", "ask"),
    ).toBeNull();
    expect(
      beginNewChatWorktreeOffer(
        [chat({ id: "gone", worktreeRemoved: true })],
        "gone",
        "/work/proj",
        "ask",
      ),
    ).toBeNull();
    expect(
      beginNewChatWorktreeOffer(
        [chat({ id: "cont", providerSessionId: "prov-1" })],
        "cont",
        "/work/proj",
        "ask",
      ),
    ).toBeNull();
    expect(
      beginNewChatWorktreeOffer(
        [chat({ id: "ask", inboxAsk: {} as Session["inboxAsk"] })],
        "ask",
        "/work/proj",
        "always",
      ),
    ).toBeNull();
    expect(
      beginNewChatWorktreeOffer(
        [chat({ id: "lead", orchestrationLeadId: "lead-1" })],
        "lead",
        "/work/proj",
        "always",
      ),
    ).toBeNull();
    expect(beginNewChatWorktreeOffer([blank], "missing", "/work/proj", "ask")).toBeNull();
    expect(beginNewChatWorktreeOffer([blank], "s", "/work/else", "ask")).toBeNull();
    expect(beginNewChatWorktreeOffer([chat({ id: "home", cwd: "~" })], "home", "~", "always")).toBeNull();
    expect(beginNewChatWorktreeOffer([chat({ id: "empty", cwd: "" })], "empty", "", "always")).toBeNull();
    expect(
      beginNewChatWorktreeOffer(
        [chat({ id: "far", cwd: "remote://box/work/proj" })],
        "far",
        "remote://box/work/proj",
        "always",
      ),
    ).toBeNull();
    noteNewChatFolderChoice("s", "current");
    expect(beginNewChatWorktreeOffer([blank], "s", "/work/proj", "always")).toBeNull();
    expect(newChatStaysHere("s")).toBe(true);
  });

  it("matches a Windows path with a different slash and case", () => {
    const target = chat({ id: "win", cwd: "C:\\work\\Proj" });
    const next = beginNewChatWorktreeOffer([target], "win", "c:/work/proj", "always");
    expect(next?.[0].workspaceMode).toBe("worktree");
  });

  it("does not offer again after the folder choice is forgotten and the mode is still set", () => {
    const target = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
    forgetNewChatFolderChoice("s");
    expect(beginNewChatWorktreeOffer([target], "s", "/work/proj", "ask")).toBeNull();
  });

  it("clears an offer that is still the one we made when the folder is not a git repo", async () => {
    const target = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
    let latest = [target];
    const git = deferred<boolean>();
    const done = confirmNewChatWorktreeOffer("s", "/work/proj", {
      setting: () => "ask",
      gitOnThisComputer: () => git.promise,
      commit: (update) => {
        latest = update(latest) ?? latest;
      },
    });
    git.resolve(false);
    await done;
    expect(latest[0].workspaceMode).toBeUndefined();
    expect(latest[0].worktreeBase).toBeUndefined();
  });

  it("leaves the offer when git does not answer", async () => {
    const target = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
    const commits: Array<Session[] | null> = [];
    const git = deferred<boolean>();
    const done = confirmNewChatWorktreeOffer("s", "/work/proj", {
      setting: () => "always",
      gitOnThisComputer: () => git.promise,
      commit: (update) => {
        commits.push(update([target]));
      },
    });
    git.reject(new Error("unreachable"));
    await done;
    expect(commits).toEqual([]);
  });

  it("drops the offer when the setting turns off while git is in flight", async () => {
    const target = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
    let setting: NewChatWorktree = "ask";
    let latest = [target];
    const git = deferred<boolean>();
    const done = confirmNewChatWorktreeOffer("s", "/work/proj", {
      setting: () => setting,
      gitOnThisComputer: () => git.promise,
      commit: (update) => {
        latest = update(latest) ?? latest;
      },
    });
    setting = "off";
    git.resolve(true);
    await done;
    expect(latest[0].workspaceMode).toBeUndefined();
  });

  it.each([
    ["a user message landed", (session: Session): Session => ({ ...session, blocks: [{ role: "user" } as Session["blocks"][number]] })],
    ["the chat was removed", (): Session | undefined => undefined],
    ["the folder changed", (session: Session): Session => ({ ...session, cwd: "/work/else" })],
    ["the person picked this folder", (session: Session): Session => ({ ...session, workspaceMode: undefined, worktreeBase: undefined })],
    ["the person picked a base", (session: Session): Session => ({ ...session, worktreeBase: "release" })],
    ["a worktree is already attached", (session: Session): Session => ({ ...session, worktreeCwd: "/wt" })],
  ])("does not clear the chat when %s before the check finishes", async (_name, change) => {
    const target = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
    let latest: Session[] = [target];
    const git = deferred<boolean>();
    const done = confirmNewChatWorktreeOffer("s", "/work/proj", {
      setting: () => "ask",
      gitOnThisComputer: () => git.promise,
      commit: (update) => {
        const changed = change(target);
        latest = changed ? [changed] : [];
        const next = update(latest);
        if (next) latest = next;
        return next;
      },
    });
    git.resolve(false);
    await done;
    if (latest[0]) {
      expect(latest[0].workspaceMode).toBe(change(target)?.workspaceMode);
      expect(latest[0].worktreeBase).toBe(change(target)?.worktreeBase);
    } else {
      expect(latest).toEqual([]);
    }
  });

  it("does not clear a chat whose saved blocks are not a list", () => {
    const broken = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
    (broken as { blocks: unknown }).blocks = null;
    expect(clearUnconfirmedNewChatWorktree([broken], "s", "/work/proj")).toBeNull();
    expect(beginNewChatWorktreeOffer([broken], "s", "/work/proj", "ask")).toBeNull();
  });
});

describe("what the chat says", () => {
  it("asks only while a new chat is set to start in a worktree", () => {
    const ready = chat({ id: "s", workspaceMode: "worktree" });
    expect(newChatWorktreeAskLine(ready, "ask")).toBe(NEW_CHAT_WORKTREE_ASK);
    expect(newChatWorktreeAskLine(ready, "always")).toBeNull();
    expect(newChatWorktreeAskLine(ready, "off")).toBeNull();
    expect(newChatWorktreeAskLine(chat({ id: "s" }), "ask")).toBeNull();
    expect(
      newChatWorktreeAskLine(chat({ id: "s", workspaceMode: "worktree", worktreeCwd: "/wt" }), "ask"),
    ).toBeNull();
    expect(
      newChatWorktreeAskLine(
        chat({
          id: "s",
          workspaceMode: "worktree",
          blocks: [{ role: "user" } as Session["blocks"][number]],
        }),
        "ask",
      ),
    ).toBeNull();
    expect(NEW_CHAT_WORKTREE_ASK).not.toMatch(/[—–]/);
  });
});

describe("the palette flip", () => {
  it("moves between off and ask, and never writes always", () => {
    expect(flippedNewChatWorktree("off")).toBe("ask");
    expect(flippedNewChatWorktree("ask")).toBe("off");
    expect(flippedNewChatWorktree("always")).toBe("ask");
    expect(flippedNewChatWorktree("ask")).toBe("off");
    for (const value of ["off", "ask", "always"] as const) {
      expect(flippedNewChatWorktree(value)).not.toBe("always");
    }
    expect(flippedNewChatWorktree("nope" as NewChatWorktree)).toBe("ask");
  });
});
