import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { allowCommitGuardLine, listCommitGuardAllows, removeCommitGuardAllow } from "./allows";

describe("commit guard allow commands", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("allows one line with the repository path, file and line, as the app's command expects", async () => {
    await allowCommitGuardLine("/srv/project", "src/config.rs", 12);
    expect(invoke).toHaveBeenCalledWith("commit_guard_allow", {
      repo: "/srv/project",
      file: "src/config.rs",
      line: 12,
    });
  });

  it("lists the allows on record", async () => {
    invoke.mockResolvedValueOnce([{ repo: "abc", file: "src/a.rs", hash: "def" }]);
    expect(await listCommitGuardAllows()).toEqual([{ repo: "abc", file: "src/a.rs", hash: "def" }]);
    expect(invoke).toHaveBeenCalledWith("commit_guard_allows");
  });

  it("removes one allow by its repository id, file and hash", async () => {
    await removeCommitGuardAllow({ repo: "abc", file: "src/a.rs", hash: "def" });
    expect(invoke).toHaveBeenCalledWith("commit_guard_remove", { repo: "abc", file: "src/a.rs", hash: "def" });
  });
});
