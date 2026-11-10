import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";
import { newSession } from "../../sessions/model/session";
import type { NewChatWorktree } from "../../settings/model/settings";
import { newTab } from "../../workspace/model/layout";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
} from "../../workspace/model/workspaceSnapshot";
import type { Worktree } from "./worktrees";
import {
  beginNewChatWorktreeOffer,
  clearUnconfirmedNewChatWorktree,
  confirmNewChatWorktreeOffer,
  flippedNewChatWorktree,
  newChatOfferCheck,
  pendingNewChatOfferCheck,
  newChatStaysHere,
  newChatWorktreeAskLine,
  newChatWorktreeOpenFor,
  openNewChatWorktree,
  startedByTheApp,
  withNewChatFolderChoice,
  withoutNewChatFolderChoice,
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
    offerCheck: () => null,
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

describe("a send that comes while the offer's git check is running", () => {
  const offered = { setting: "ask" as const, firstTurn: true, toggleOn: true, declined: false, cwd: "/work/proj", base: "HEAD", offerChat: "s" };

  it("waits for that check, then makes the worktree when git says this is a repository", async () => {
    const create = vi.fn(async () => tree());
    const check = deferred<boolean>();
    const git = vi.fn();
    let outcome: "pending" | "done" = "pending";
    const sent = openNewChatWorktree(offered, port({ createWorktree: create, gitOnThisComputer: git, offerCheck: () => check.promise })).then((worktree) => {
      outcome = "done";
      return worktree;
    });
    await Promise.resolve();
    expect(outcome).toBe("pending");
    expect(create).not.toHaveBeenCalled();
    check.resolve(true);
    expect((await sent)?.path).toBe("/work/proj-wt");
    expect(create).toHaveBeenCalledTimes(1);
    expect(git).not.toHaveBeenCalled();
  });

  it.each([
    ["says this is not a repository", (check: ReturnType<typeof deferred<boolean>>) => check.resolve(false)],
    ["does not answer in time", (check: ReturnType<typeof deferred<boolean>>) => check.reject(new Error("git did not answer in time"))],
  ])("goes on in this folder when git %s", async (_name, finish) => {
    const create = vi.fn(async () => tree());
    const check = deferred<boolean>();
    const sent = openNewChatWorktree(offered, port({ createWorktree: create, offerCheck: () => check.promise }));
    finish(check);
    expect(await sent).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("makes the worktree at once when no check is running, and does not ask git", async () => {
    const create = vi.fn(async () => tree());
    const git = vi.fn();
    const looked = vi.fn(() => null);
    expect((await openNewChatWorktree(offered, port({ createWorktree: create, gitOnThisComputer: git, offerCheck: looked })))?.path).toBe("/work/proj-wt");
    expect(looked).toHaveBeenCalledWith("s");
    expect(git).not.toHaveBeenCalled();
  });

  it("does not look for a check when the worktree is not the offer's own", async () => {
    const looked = vi.fn(() => new Promise<boolean>(() => {}));
    const { offerChat: _gone, ...chosen } = offered;
    expect((await openNewChatWorktree(chosen, port({ offerCheck: looked })))?.path).toBe("/work/proj-wt");
    expect(looked).not.toHaveBeenCalled();
  });

  it("is told it is the offer's own only while nothing has been chosen on the chat", () => {
    const ask = (session: Session) =>
      newChatWorktreeOpenFor(session, { setting: "ask", isFirstTurn: true, toggleOn: true }).offerChat;
    const mode = { workspaceMode: "worktree" as const, worktreeBase: "HEAD" };
    expect(ask(chat({ id: "s", ...mode }))).toBe("s");
    expect(ask(chat({ id: "s", workspaceMode: "worktree" }))).toBe("s");
    expect(ask(chat({ id: "s", ...mode, worktreeBase: "release" }))).toBeUndefined();
    expect(ask(chat({ id: "s" }))).toBeUndefined();
    expect(ask(chat({ id: "s", ...mode, worktreeCwd: "/wt" }))).toBeUndefined();
    expect(ask(withNewChatFolderChoice(chat({ id: "s", ...mode }), "current"))).toBeUndefined();
    expect(ask(chat({ id: "app-x-y", ...mode }))).toBeUndefined();
    expect(ask(chat({ id: "council:r:a-1", ...mode }))).toBeUndefined();
    expect(ask(chat({ id: "s", ...mode, firstMate: true }))).toBeUndefined();
  });
});

describe("the offer's one git check per chat", () => {
  it("is shared by whoever asks while it runs, and is dropped when it settles", async () => {
    const answer = deferred<boolean>();
    const ask = vi.fn(() => answer.promise);
    const first = newChatOfferCheck("shared-1", "/work/proj", ask);
    const second = newChatOfferCheck("shared-1", "/work/proj/", ask);
    expect(second).toBe(first);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(pendingNewChatOfferCheck("shared-1")).toBe(first);
    answer.resolve(true);
    await first;
    await Promise.resolve();
    expect(pendingNewChatOfferCheck("shared-1")).toBeNull();
    // A later offer asks again: nothing about the folder is kept.
    const again = vi.fn(async () => false);
    expect(await newChatOfferCheck("shared-1", "/work/proj", again)).toBe(false);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("is dropped when git fails, and the failure still reaches whoever waits", async () => {
    const answer = deferred<boolean>();
    const check = newChatOfferCheck("shared-2", "/work/proj", () => answer.promise);
    answer.reject(new Error("timed out"));
    await expect(check).rejects.toThrow("timed out");
    await Promise.resolve();
    expect(pendingNewChatOfferCheck("shared-2")).toBeNull();
  });

  it("is one per chat, and a chat moved to another folder gets its own", async () => {
    const one = deferred<boolean>();
    const two = deferred<boolean>();
    const a = newChatOfferCheck("shared-3", "/work/one", () => one.promise);
    const b = newChatOfferCheck("shared-3", "/work/two", () => two.promise);
    const other = newChatOfferCheck("shared-4", "/work/one", () => Promise.resolve(true));
    expect(b).not.toBe(a);
    expect(other).not.toBe(a);
    expect(pendingNewChatOfferCheck("shared-3")).toBe(b);
    // The old folder's answer does not take the new folder's check away.
    one.resolve(true);
    await a;
    await Promise.resolve();
    expect(pendingNewChatOfferCheck("shared-3")).toBe(b);
    two.resolve(true);
    await b;
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
    const stayed = withNewChatFolderChoice(blank, "current");
    expect(beginNewChatWorktreeOffer([stayed], "s", "/work/proj", "always")).toBeNull();
    expect(newChatStaysHere(stayed)).toBe(true);
  });

  it("matches a Windows path with a different slash and case", () => {
    const target = chat({ id: "win", cwd: "C:\\work\\Proj" });
    const next = beginNewChatWorktreeOffer([target], "win", "c:/work/proj", "always");
    expect(next?.[0].workspaceMode).toBe("worktree");
  });

  it("does not offer again when the chat already has a mode, whatever was chosen before", () => {
    const target = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
    expect(beginNewChatWorktreeOffer([target], "s", "/work/proj", "ask")).toBeNull();
    expect(
      beginNewChatWorktreeOffer([withoutNewChatFolderChoice(target)], "s", "/work/proj", "ask"),
    ).toBeNull();
  });

  it("offers again once the folder choice is dropped", () => {
    const stayed = withNewChatFolderChoice(chat({ id: "s", cwd: "/work/proj" }), "current");
    expect(beginNewChatWorktreeOffer([stayed], "s", "/work/proj", "ask")).toBeNull();
    const dropped = withoutNewChatFolderChoice(stayed);
    expect(newChatStaysHere(dropped)).toBe(false);
    expect(beginNewChatWorktreeOffer([dropped], "s", "/work/proj", "ask")?.[0].workspaceMode).toBe("worktree");
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

  it.each(["ask", "always"] as const)(
    "skips the chat when git does not answer for %s, and stores no answer about the folder",
    async (setting) => {
      const target = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
      let latest = [target];
      const git = deferred<boolean>();
      const done = confirmNewChatWorktreeOffer("s", "/work/proj", {
        setting: () => setting,
        gitOnThisComputer: () => git.promise,
        commit: (update) => {
          latest = update(latest) ?? latest;
        },
      });
      git.reject(new Error("timed out"));
      await done;
      expect(latest[0].workspaceMode).toBeUndefined();
      expect(latest[0].worktreeBase).toBeUndefined();
      // A timeout is not "this folder": nothing says the person chose it, and nothing says it is not a repo.
      expect(newChatStaysHere(latest[0])).toBe(false);
      expect(beginNewChatWorktreeOffer(latest, "s", "/work/proj", setting)?.[0].workspaceMode).toBe("worktree");
    },
  );

  it("does not clear a chat the person changed while a timed-out check was running", async () => {
    const target = chat({ id: "s", cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD" });
    let latest = [{ ...target, worktreeBase: "release" }];
    const git = deferred<boolean>();
    const done = confirmNewChatWorktreeOffer("s", "/work/proj", {
      setting: () => "ask",
      gitOnThisComputer: () => git.promise,
      commit: (update) => {
        latest = update(latest) ?? latest;
      },
    });
    git.reject(new Error("timed out"));
    await done;
    expect(latest[0].workspaceMode).toBe("worktree");
    expect(latest[0].worktreeBase).toBe("release");
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

describe("a chat the app started for a Lead", () => {
  const opened = (session: Session, setting: NewChatWorktree, toggleOn = false) =>
    newChatWorktreeOpenFor(session, { setting, isFirstTurn: true, toggleOn });

  it.each(["ask", "always"] as const)(
    "is never offered a worktree for %s, whatever its id after app-",
    (setting) => {
      for (const id of ["app-x-y", "app-s1-r2", "app-s1-lead-0f3a"]) {
        const worker = chat({ id, cwd: "/work/proj" });
        expect(beginNewChatWorktreeOffer([worker], id, "/work/proj", setting)).toBeNull();
      }
      const ordinary = chat({ id: "application-1", cwd: "/work/proj" });
      expect(beginNewChatWorktreeOffer([ordinary], ordinary.id, "/work/proj", setting)).not.toBeNull();
    },
  );

  it("is not moved into a new worktree by always, and git is not even asked", async () => {
    const create = vi.fn(async () => tree());
    const git = vi.fn(async () => true);
    const worktree = await openNewChatWorktree(
      opened(chat({ id: "app-x-y", cwd: "/work/proj" }), "always"),
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(worktree).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it("is moved by always when it is an ordinary new chat (the same input, another id)", async () => {
    const create = vi.fn(async () => tree("/wt/ordinary"));
    const worktree = await openNewChatWorktree(
      opened(chat({ id: "s-1", cwd: "/work/proj" }), "always"),
      port({ createWorktree: create }),
    );
    expect(worktree?.path).toBe("/wt/ordinary");
  });

  it("still gets the worktree its launch asked for, because that is the toggle and not the default", async () => {
    const create = vi.fn(async () => tree("/wt/asked"));
    const worktree = await openNewChatWorktree(
      opened(chat({ id: "app-x-y", cwd: "/work/proj", workspaceMode: "worktree" }), "always", true),
      port({ createWorktree: create }),
    );
    expect(worktree?.path).toBe("/wt/asked");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// One check says "the app started this chat": a worker, a council seat, a Mono's or a Lead's chat. The default never
// moves any of them into a new worktree, however the check is reached.
describe("a chat the app started", () => {
  const KINDS: [string, Partial<Session>][] = [
    ["a worker (app- id)", { id: "app-s1-r2" }],
    ["a worker for a Lead (app- id with a lead part)", { id: "app-s1-lead-0f3a" }],
    ["a council seat", { id: "council:room-9:claude-anthropic-1" }],
    ["a Mono's or a Lead's chat", { id: "mono-chat-1", firstMate: true }],
  ];
  const ORDINARY: [string, Partial<Session>][] = [
    ["an ordinary chat", { id: "s-1" }],
    ["a chat whose id only starts like a worker", { id: "application-1" }],
    ["a chat whose id only starts like a council seat", { id: "councillor-2" }],
    ["a chat with the first mate flag off", { id: "s-2", firstMate: false }],
  ];

  it.each(KINDS)("startedByTheApp is true for %s", (_name, over) => {
    expect(startedByTheApp(chat(over))).toBe(true);
  });

  it.each(ORDINARY)("startedByTheApp is false for %s", (_name, over) => {
    expect(startedByTheApp(chat(over))).toBe(false);
  });

  it.each(KINDS)("is not offered a worktree for ask or always: %s", (_name, over) => {
    for (const setting of ["ask", "always"] as const) {
      const session = chat({ cwd: "/work/proj", ...over });
      expect(beginNewChatWorktreeOffer([session], session.id, "/work/proj", setting)).toBeNull();
    }
  });

  it.each(ORDINARY)("is offered a worktree for ask and always: %s", (_name, over) => {
    for (const setting of ["ask", "always"] as const) {
      const session = chat({ cwd: "/work/proj", ...over });
      expect(beginNewChatWorktreeOffer([session], session.id, "/work/proj", setting)).not.toBeNull();
    }
  });

  it.each(KINDS)("is not a first turn the default may act on: %s", (_name, over) => {
    const open = newChatWorktreeOpenFor(chat({ cwd: "/work/proj", ...over }), {
      setting: "always",
      isFirstTurn: true,
      toggleOn: false,
    });
    expect(open.firstTurn).toBe(false);
  });

  it.each(KINDS)("is not moved into a new worktree by always, and git is not asked: %s", async (_name, over) => {
    const create = vi.fn(async () => tree());
    const git = vi.fn(async () => true);
    const worktree = await openNewChatWorktree(
      newChatWorktreeOpenFor(chat({ cwd: "/work/proj", ...over }), {
        setting: "always",
        isFirstTurn: true,
        toggleOn: false,
      }),
      port({ createWorktree: create, gitOnThisComputer: git }),
    );
    expect(worktree).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it.each(ORDINARY)("is moved by always when it is a new chat: %s", async (_name, over) => {
    const create = vi.fn(async () => tree("/wt/ordinary"));
    const worktree = await openNewChatWorktree(
      newChatWorktreeOpenFor(chat({ cwd: "/work/proj", ...over }), {
        setting: "always",
        isFirstTurn: true,
        toggleOn: false,
      }),
      port({ createWorktree: create }),
    );
    expect(worktree?.path).toBe("/wt/ordinary");
  });

  it.each(KINDS)("keeps a worktree its launch asked for, because that is the toggle: %s", async (_name, over) => {
    const create = vi.fn(async () => tree("/wt/asked"));
    const worktree = await openNewChatWorktree(
      newChatWorktreeOpenFor(chat({ cwd: "/work/proj", workspaceMode: "worktree", ...over }), {
        setting: "always",
        isFirstTurn: true,
        toggleOn: true,
      }),
      port({ createWorktree: create }),
    );
    expect(worktree?.path).toBe("/wt/asked");
  });

  it.each(KINDS)("does not lose the worktree its launch asked for when git is slow or says no: %s", (_name, over) => {
    const asked = chat({ cwd: "/work/proj", workspaceMode: "worktree", worktreeBase: "HEAD", ...over });
    expect(clearUnconfirmedNewChatWorktree([asked], asked.id, "/work/proj")).toBeNull();
  });
});

describe("what a send asks the worktree function", () => {
  const ask = (session: Session, over: Partial<Parameters<typeof newChatWorktreeOpenFor>[1]> = {}) =>
    newChatWorktreeOpenFor(session, { setting: "always", isFirstTurn: true, toggleOn: false, ...over });

  it("carries the setting, the toggle, the folder and the base", () => {
    const session = chat({ id: "s", cwd: "/work/proj", worktreeBase: "release" });
    expect(ask(session)).toEqual({
      setting: "always",
      firstTurn: true,
      toggleOn: false,
      declined: false,
      cwd: "/work/proj",
      base: "release",
    });
    expect(ask(chat({ id: "s2", cwd: "/work/proj" }), { setting: "ask", toggleOn: true })).toMatchObject({
      setting: "ask",
      toggleOn: true,
      base: "HEAD",
    });
  });

  it.each<[string, Partial<Session>, boolean]>([
    ["a new blank chat", {}, true],
    ["a chat with a worktree already", { worktreeCwd: "/wt" }, false],
    ["a chat that continues one", { providerSessionId: "prov-1" }, false],
    ["a Lead", { orchestrationLeadId: "lead-1" }, false],
    ["an inbox ask", { inboxAsk: {} as Session["inboxAsk"] }, false],
    ["a chat whose worktree was removed", { worktreeRemoved: true }, false],
    ["an automation", { automationId: "auto-1" }, false],
    ["an ephemeral chat", { ephemeral: true }, false],
    ["a worker the app started", { id: "app-x-y" }, false],
  ])("treats %s as a first turn only when it is new: %s", (_name, over, firstTurn) => {
    expect(ask(chat({ id: "s", cwd: "/work/proj", ...over })).firstTurn).toBe(firstTurn);
  });

  it("is not a first turn when the caller says the chat has already started", () => {
    expect(ask(chat({ id: "s", cwd: "/work/proj" }), { isFirstTurn: false }).firstTurn).toBe(false);
  });

  it("says declined for a chat whose person chose this folder", () => {
    const stayed = withNewChatFolderChoice(chat({ id: "s", cwd: "/work/proj" }), "current");
    expect(ask(stayed).declined).toBe(true);
  });
});

describe("choosing this folder", () => {
  it("is held on the chat, and choosing a worktree takes it back", () => {
    const blank = chat({ id: "s", cwd: "/work/proj" });
    const stayed = withNewChatFolderChoice(blank, "current");
    expect(newChatStaysHere(blank)).toBe(false);
    expect(newChatStaysHere(stayed)).toBe(true);
    expect(blank.worktreeDeclined).toBeUndefined();
    expect(newChatStaysHere(withNewChatFolderChoice(stayed, "worktree"))).toBe(false);
    expect(withNewChatFolderChoice(stayed, "current")).toBe(stayed);
    expect(withNewChatFolderChoice(blank, "worktree")).toBe(blank);
  });

  it("leaves one chat's choice out of another", () => {
    const one = withNewChatFolderChoice(chat({ id: "one", cwd: "/work/proj" }), "current");
    const two = chat({ id: "two", cwd: "/work/proj" });
    const next = beginNewChatWorktreeOffer([one, two], "two", "/work/proj", "always");
    expect(next?.find((entry) => entry.id === "two")?.workspaceMode).toBe("worktree");
    expect(beginNewChatWorktreeOffer([one, two], "one", "/work/proj", "always")).toBeNull();
  });

  it("survives a reload: always still leaves the chat in its folder, and an untouched chat is still moved", async () => {
    const chosen = withNewChatFolderChoice(chat({ id: "kept", cwd: "/work/proj" }), "current");
    const untouched = chat({ id: "plain", cwd: "/work/proj" });
    const tab = newTab("kept");
    const snapshot = collectWorkspaceSnapshot(
      [tab, newTab("plain")],
      [chosen, untouched],
      tab.id,
      "/work/proj",
      new Map(),
    );
    // The snapshot goes through the same JSON the app saves, and comes back through the loader.
    const reloaded = hydrateWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)), new Map());
    const kept = reloaded?.sessions.find((session) => session.id === "kept");
    const plain = reloaded?.sessions.find((session) => session.id === "plain");
    expect(kept && newChatStaysHere(kept)).toBe(true);
    expect(plain && newChatStaysHere(plain)).toBe(false);

    const create = vi.fn(async () => tree("/wt/plain"));
    const send = (session: Session) =>
      openNewChatWorktree(
        newChatWorktreeOpenFor(session, { setting: "always", isFirstTurn: true, toggleOn: false }),
        port({ createWorktree: create }),
      );
    expect(await send(kept!)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect((await send(plain!))?.path).toBe("/wt/plain");
    expect(create).toHaveBeenCalledTimes(1);
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
