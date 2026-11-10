import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  AUTO_CLEAR_DEFAULT,
  describeAutoClearRun,
  loadAutoClear,
  saveAutoClear,
  type AutoClearRun,
} from "./worktreeAutoClear";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

const run = (over: Partial<AutoClearRun> = {}): AutoClearRun => ({
  at: 1_000_000,
  tookMs: 4_200,
  checked: 0,
  cleared: [],
  clearedBytes: 0,
  heldBack: 0,
  errors: [],
  ...over,
});

describe("clear build output of finished worktrees", () => {
  it("is on until it is turned off", () => {
    expect(AUTO_CLEAR_DEFAULT).toBe(true);
  });

  it("reads and writes the app's setting through its two commands", async () => {
    vi.mocked(invoke).mockResolvedValue({ enabled: true, running: false, lastRun: null });
    expect(await loadAutoClear()).toEqual({ enabled: true, running: false, lastRun: null });
    expect(invoke).toHaveBeenLastCalledWith("worktree_autoclean_status");
    await saveAutoClear(false);
    expect(invoke).toHaveBeenLastCalledWith("worktree_autoclean_set", { enabled: false });
  });

  it("says what the last check did in plain words", () => {
    const now = 1_000_000 + 5 * 60_000;
    expect(describeAutoClearRun(run(), now)).toBe("Last check 5 min ago: nothing to clear.");
    const done = run({
      cleared: [
        { path: "/w/a", branch: "a", why: "pull request #7 merged", folders: [], bytes: 9_100_000_000 },
        { path: "/w/b", branch: "b", why: "branch merged", folders: [], bytes: 400_000_000 },
      ],
      clearedBytes: 9_500_000_000,
      heldBack: 1,
      errors: ["/w/c: target: Permission denied"],
    });
    const line = describeAutoClearRun(done, now);
    expect(line).toContain("cleared build output in 2 worktrees (9.5 GB).");
    expect(line).toContain("1 worktree with build output stayed: not finished, in use or with changes.");
    expect(line).toContain("1 problem: /w/c: target: Permission denied");
    expect(line).not.toMatch(/[—–]/);
  });
});
