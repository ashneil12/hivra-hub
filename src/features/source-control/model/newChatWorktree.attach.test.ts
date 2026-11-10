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
import {
  attachNewChatWorktree,
  gitRepositoryOnThisComputer,
  NEW_CHAT_GIT_WAIT_MS,
  newChatStaysHere,
  newChatWorktreeOpenFor,
  openNewChatWorktree,
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

  it("lets the first send go ahead in this folder, with no worktree made", async () => {
    const created = vi.fn();
    let outcome: "pending" | "skipped" | "made" = "pending";
    const sent = openNewChatWorktree(
      newChatWorktreeOpenFor(chat("s"), { setting: "always", isFirstTurn: true, toggleOn: false }),
      { gitOnThisComputer: gitRepositoryOnThisComputer, createWorktree: created },
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
