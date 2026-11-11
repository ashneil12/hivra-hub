import { expect, it } from "vitest";
import { commonGitDir, gitdirFromGitFile, joinRepoPath, originUrlFromGitConfig, repoFromOriginUrl } from "./projectRepos";

it("reads owner and repo from an origin url", () => {
  expect(repoFromOriginUrl("https://github.com/ash/hivra.git")).toBe("ash/hivra");
  expect(repoFromOriginUrl("https://github.com/ash/hivra.git/")).toBe("ash/hivra");
  expect(repoFromOriginUrl("git@github.com:ash/hivra.git")).toBe("ash/hivra");
  expect(repoFromOriginUrl("ssh://git@github.com/ash/hivra")).toBe("ash/hivra");
  expect(repoFromOriginUrl("git://github.com/ash/hivra.git")).toBe("ash/hivra");
  expect(repoFromOriginUrl("https://github.com/ash/hivra")).toBe("ash/hivra");
  expect(repoFromOriginUrl("")).toBeUndefined();
  expect(repoFromOriginUrl("hivra")).toBeUndefined();
  expect(repoFromOriginUrl("https://github.com/../hivra.git")).toBeUndefined();
  expect(repoFromOriginUrl("git@github.com:../hivra.git")).toBeUndefined();
});

it("reads the origin url out of a git config, including a worktree pointer", () => {
  const config = ["[core]", "\trepositoryformatversion = 0", '[remote "origin"]', "\turl = https://github.com/ash/hivra.git", "\tfetch = +refs/heads/*:refs/remotes/origin/*"].join("\r\n");
  expect(originUrlFromGitConfig(config)).toBe("https://github.com/ash/hivra.git");
  expect(originUrlFromGitConfig("[remote \"upstream\"]\n\turl = https://github.com/other/hivra.git\n")).toBeUndefined();
  expect(gitdirFromGitFile("gitdir: ../.git/worktrees/hivra\n")).toBe("../.git/worktrees/hivra");
  expect(gitdirFromGitFile(config)).toBeUndefined();
  expect(joinRepoPath("/work/hivra", ".git/config")).toBe("/work/hivra/.git/config");
  expect(joinRepoPath("/work/trees/hivra", "../.git/worktrees/hivra")).toBe("/work/trees/.git/worktrees/hivra");
  expect(joinRepoPath("C:\\work\\hivra", ".git\\config")).toBe("C:\\work\\hivra\\.git\\config");
});

it("follows only a worktree or a modules git dir", () => {
  expect(commonGitDir("/work/hivra/.git/worktrees/feature", "../..")).toBe("/work/hivra/.git");
  expect(commonGitDir("/work/hivra/.git/modules/vendor", "../..")).toBe("/work/hivra/.git");
  expect(commonGitDir("C:\\repo\\.git\\worktrees\\name", "..\\..")).toBe("C:\\repo\\.git");
  expect(commonGitDir("/tmp/evil", "../..")).toBeUndefined();
  expect(commonGitDir("/work/hivra/.git/worktrees/name/extra", "../../..")).toBeUndefined();
  expect(commonGitDir("/work/hivra/.git/worktrees/..", "..")).toBeUndefined();
  expect(commonGitDir("/tmp/not-a-worktree", "/work/hivra/.git")).toBeUndefined();
  expect(commonGitDir("/work/hivra/.git/worktrees/feature", "")).toBeUndefined();
  expect(commonGitDir("/work/hivra/.git/worktrees/feature", "   ")).toBeUndefined();
  expect(commonGitDir("/work/hivra/.git/worktrees/feature", "\0")).toBeUndefined();
  expect(commonGitDir("/work/hivra/.git/worktrees/feature", "../..\n/tmp")).toBeUndefined();
});
