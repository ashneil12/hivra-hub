// @vitest-environment happy-dom
// attachNewChatWorktree is what every new chat goes through. It reads the stored setting and asks git through
// `gitBranches`, so this file runs it with the real setting key and a git that answers, refuses or times out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../platform/tauri/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/tauri/fs")>()),
  gitBranches: vi.fn(),
}));

import { gitBranches } from "../../../platform/tauri/fs";
import { newSession, type Session } from "../../sessions/model/session";
import { saveNewChatWorktree, type NewChatWorktree } from "../../settings/model/settings";
import type { Worktree } from "./worktrees";
import {
  attachNewChatWorktree,
  gitRepositoryOnThisComputer,
  NEW_CHAT_GIT_WAIT_MS,
  newChatStaysHere,
  newChatWorktreeOpenFor,
  openNewChatWorktree,
  pendingNewChatOfferCheck,
  withNewChatFolderChoice,
} from "./newChatWorktree";

const REPO = {
  current: "main",
  detached: false,
  branches: [{ name: "main", current: true, remote: null }],
};
const NOT_A_REPO = { current: null, detached: false, branches: [] };

function chat(id: string, over: Partial<Session> = {}): Session {
  return { ...newSession("claude", "/work/proj"), id, ...over };
}

/** A window's session list, with the same functional updates the app's setSessions takes. */
function windowWith(...sessions: Session[]) {
  const state = { sessions };
  return {
    state,
    setSessions: (update: (previous: Session[]) => Session[]) => {
      state.sessions = update(state.sessions);
    },
  };
}

const TREE: Worktree = {
  path: "/wt/made",
  branch: "mc/abcd1234",
  head: "abc",
  isMain: false,
  locked: false,
  prunable: false,
  missing: false,
  dirty: false,
  unpushed: 0,
  sessionIds: [],
};

/** What the app's send does with the chat as it stands: the toggle is on when the chat is set to a worktree. */
function sendFrom(
  session: Session,
  value: NewChatWorktree,
  createWorktree: () => Promise<Worktree> = vi.fn(async () => TREE),
) {
  return openNewChatWorktree(
    newChatWorktreeOpenFor(session, {
      setting: value,
      isFirstTurn: true,
      toggleOn: !session.worktreeCwd && session.workspaceMode === "worktree",
    }),
    {
      gitOnThisComputer: gitRepositoryOnThisComputer,
      offerCheck: pendingNewChatOfferCheck,
      createWorktree,
    },
  );
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(gitBranches).mockReset();
});
afterEach(() => {
  localStorage.clear();
});

function setting(value: NewChatWorktree) {
  saveNewChatWorktree(value);
}

describe("a new chat and the stored setting", () => {
  it.each(["ask", "always"] as const)("keeps the offer in a git repository for %s", async (value) => {
    setting(value);
    vi.mocked(gitBranches).mockResolvedValue(REPO);
    const { state, setSessions } = windowWith(chat("s"));
    attachNewChatWorktree("s", "/work/proj", setSessions);
    expect(state.sessions[0].workspaceMode).toBe("worktree");
    await settle();
    expect(state.sessions[0].workspaceMode).toBe("worktree");
    expect(gitBranches).toHaveBeenCalledWith("/work/proj");
  });

  it("takes the offer back when the folder is not a repository", async () => {
    setting("always");
    vi.mocked(gitBranches).mockResolvedValue(NOT_A_REPO);
    const { state, setSessions } = windowWith(chat("s"));
    attachNewChatWorktree("s", "/work/proj", setSessions);
    await settle();
    expect(state.sessions[0].workspaceMode).toBeUndefined();
    expect(state.sessions[0].worktreeBase).toBeUndefined();
  });

  it.each(["ask", "always"] as const)(
    "skips the chat when git times out for %s, and leaves it free to be offered next time",
    async (value) => {
      setting(value);
      vi.mocked(gitBranches).mockRejectedValue(new Error("git_branches timed out"));
      const { state, setSessions } = windowWith(chat("s"));
      attachNewChatWorktree("s", "/work/proj", setSessions);
      expect(state.sessions[0].workspaceMode).toBe("worktree");
      await settle();
      expect(state.sessions[0].workspaceMode).toBeUndefined();
      expect(state.sessions[0].worktreeBase).toBeUndefined();
      expect(newChatStaysHere(state.sessions[0])).toBe(false);

      vi.mocked(gitBranches).mockResolvedValue(REPO);
      const next = windowWith(chat("t"));
      attachNewChatWorktree("t", "/work/proj", next.setSessions);
      await settle();
      expect(next.state.sessions[0].workspaceMode).toBe("worktree");
    },
  );

  it("makes the worktree at once for a send after git has answered, and does not ask git again", async () => {
    setting("ask");
    vi.mocked(gitBranches).mockResolvedValue(REPO);
    const { state, setSessions } = windowWith(chat("s"));
    attachNewChatWorktree("s", "/work/proj", setSessions);
    await settle();
    expect(pendingNewChatOfferCheck("s")).toBeNull();
    const created = vi.fn(async () => TREE);
    const worktree = await sendFrom(state.sessions[0], "ask", created);
    expect(worktree?.path).toBe("/wt/made");
    expect(created).toHaveBeenCalledTimes(1);
    expect(gitBranches).toHaveBeenCalledTimes(1);
  });

  it("does not hold a send whose worktree the person chose a base for", async () => {
    setting("ask");
    vi.mocked(gitBranches).mockResolvedValue(REPO);
    const { state, setSessions } = windowWith(chat("s"));
    attachNewChatWorktree("s", "/work/proj", setSessions);
    expect(pendingNewChatOfferCheck("s")).not.toBeNull();
    const chosen = { ...state.sessions[0], worktreeBase: "release" };
    const created = vi.fn(async () => TREE);
    expect((await sendFrom(chosen, "ask", created))?.path).toBe("/wt/made");
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("does not hold a worker whose launch asked for a worktree", async () => {
    setting("ask");
    vi.mocked(gitBranches).mockReturnValue(new Promise<never>(() => {}));
    const worker = chat("app-s1-r2", { workspaceMode: "worktree", worktreeBase: "HEAD" });
    const { state, setSessions } = windowWith(worker);
    attachNewChatWorktree("app-s1-r2", "/work/proj", setSessions);
    expect(state.sessions[0].workspaceMode).toBe("worktree");
    const created = vi.fn(async () => TREE);
    expect((await sendFrom(state.sessions[0], "ask", created))?.path).toBe("/wt/made");
    expect(created).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a council seat", "council:room-9:claude-anthropic-1", {}],
    ["a Mono's or a Lead's chat", "mono-chat-1", { firstMate: true }],
  ] as const)("does nothing for %s", async (_name, id, over) => {
    setting("always");
    vi.mocked(gitBranches).mockResolvedValue(REPO);
    const { state, setSessions } = windowWith(chat(id, over));
    attachNewChatWorktree(id, "/work/proj", setSessions);
    await settle();
    expect(state.sessions[0].workspaceMode).toBeUndefined();
    const created = vi.fn(async () => TREE);
    expect(await sendFrom(state.sessions[0], "always", created)).toBeNull();
    expect(created).not.toHaveBeenCalled();
  });

  it("does nothing for a chat the app started for a Lead", async () => {
    setting("always");
    vi.mocked(gitBranches).mockResolvedValue(REPO);
    const { state, setSessions } = windowWith(chat("app-s1-r2"));
    attachNewChatWorktree("app-s1-r2", "/work/proj", setSessions);
    await settle();
    expect(state.sessions[0].workspaceMode).toBeUndefined();
  });

  it("does nothing for a chat whose person chose this folder", async () => {
    setting("always");
    vi.mocked(gitBranches).mockResolvedValue(REPO);
    const { state, setSessions } = windowWith(withNewChatFolderChoice(chat("s"), "current"));
    attachNewChatWorktree("s", "/work/proj", setSessions);
    await settle();
    expect(state.sessions[0].workspaceMode).toBeUndefined();
    expect(newChatStaysHere(state.sessions[0])).toBe(true);
  });
});

// A git that never answers does not reject, so only a time limit can end the wait.
describe("a git that never answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(gitBranches).mockReturnValue(new Promise<never>(() => {}));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["ask", "always"] as const)(
    "skips a new chat once the wait is over for %s",
    async (value) => {
      setting(value);
      const { state, setSessions } = windowWith(chat("s"));
      attachNewChatWorktree("s", "/work/proj", setSessions);
      expect(state.sessions[0].workspaceMode).toBe("worktree");
      await vi.advanceTimersByTimeAsync(NEW_CHAT_GIT_WAIT_MS - 1);
      expect(state.sessions[0].workspaceMode).toBe("worktree");
      await vi.advanceTimersByTimeAsync(1);
      expect(state.sessions[0].workspaceMode).toBeUndefined();
      expect(state.sessions[0].worktreeBase).toBeUndefined();
      expect(newChatStaysHere(state.sessions[0])).toBe(false);
    },
  );

  // The offer switches the composer to "New worktree" before git answers, so a send in the first seconds is a send
  // with the toggle on. It must wait for the offer's own check and not go straight to createWorktree.
  it.each(["ask", "always"] as const)(
    "lets a send that comes before git answers go on in this folder within the wait, for %s",
    async (value) => {
      setting(value);
      const { state, setSessions } = windowWith(chat("s"));
      attachNewChatWorktree("s", "/work/proj", setSessions);
      const offered = state.sessions[0];
      expect(offered.workspaceMode).toBe("worktree");

      const created = vi.fn(async () => TREE);
      let outcome: "pending" | "skipped" | "made" = "pending";
      const sent = sendFrom(offered, value, created).then((worktree) => {
        outcome = worktree ? "made" : "skipped";
      });
      await vi.advanceTimersByTimeAsync(NEW_CHAT_GIT_WAIT_MS - 1);
      expect(outcome).toBe("pending");
      expect(created).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await sent;
      expect(outcome).toBe("skipped");
      expect(created).not.toHaveBeenCalled();
      // One check for the chat, shared by the offer and the send.
      expect(gitBranches).toHaveBeenCalledTimes(1);
      expect(state.sessions[0].workspaceMode).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("makes the worktree once git answers that this is a repository, and asks git once", async () => {
    setting("ask");
    let answer: (value: typeof REPO) => void = () => {};
    vi.mocked(gitBranches).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { state, setSessions } = windowWith(chat("s"));
    attachNewChatWorktree("s", "/work/proj", setSessions);
    const created = vi.fn(async () => TREE);
    const sent = sendFrom(state.sessions[0], "ask", created);
    await vi.advanceTimersByTimeAsync(2000);
    expect(created).not.toHaveBeenCalled();
    answer(REPO);
    expect((await sent)?.path).toBe("/wt/made");
    expect(created).toHaveBeenCalledTimes(1);
    expect(gitBranches).toHaveBeenCalledTimes(1);
    expect(state.sessions[0].workspaceMode).toBe("worktree");
  });

  it("lets a send go on in this folder when git answers that this is not a repository", async () => {
    setting("ask");
    let answer: (value: typeof NOT_A_REPO) => void = () => {};
    vi.mocked(gitBranches).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { state, setSessions } = windowWith(chat("s", { cwd: "/work/notes" }));
    attachNewChatWorktree("s", "/work/notes", setSessions);
    expect(state.sessions[0].workspaceMode).toBe("worktree");
    const created = vi.fn(async () => TREE);
    const sent = sendFrom(state.sessions[0], "ask", created);
    answer(NOT_A_REPO);
    expect(await sent).toBeNull();
    expect(created).not.toHaveBeenCalled();
  });

  it("lets a send go on in this folder when git fails before the wait is over", async () => {
    setting("ask");
    let fail: (error: Error) => void = () => {};
    vi.mocked(gitBranches).mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const { state, setSessions } = windowWith(chat("s"));
    attachNewChatWorktree("s", "/work/proj", setSessions);
    const created = vi.fn(async () => TREE);
    const sent = sendFrom(state.sessions[0], "ask", created);
    fail(new Error("git_branches failed"));
    expect(await sent).toBeNull();
    expect(created).not.toHaveBeenCalled();
  });

  it("lets the first send go ahead in this folder, with no worktree made", async () => {
    const created = vi.fn();
    let outcome: "pending" | "skipped" | "made" = "pending";
    const sent = openNewChatWorktree(
      newChatWorktreeOpenFor(chat("s"), { setting: "always", isFirstTurn: true, toggleOn: false }),
      {
        gitOnThisComputer: gitRepositoryOnThisComputer,
        offerCheck: pendingNewChatOfferCheck,
        createWorktree: created,
      },
    ).then((worktree) => {
      outcome = worktree ? "made" : "skipped";
    });
    await vi.advanceTimersByTimeAsync(NEW_CHAT_GIT_WAIT_MS - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await sent;
    expect(outcome).toBe("skipped");
    expect(created).not.toHaveBeenCalled();
  });

  it("still takes an answer that comes before the wait is over, and leaves no timer behind", async () => {
    let answer: (value: typeof REPO) => void = () => {};
    vi.mocked(gitBranches).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const asked = gitRepositoryOnThisComputer("/work/proj");
    await vi.advanceTimersByTimeAsync(NEW_CHAT_GIT_WAIT_MS - 1);
    answer(REPO);
    await expect(asked).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
