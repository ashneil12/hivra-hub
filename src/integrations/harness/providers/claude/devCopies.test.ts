import { describe, expect, it } from "vitest";
import { devCopyDenyRules, withDevCopiesOff } from "./devCopies";

describe("hub chats never read our dev copies (~/Worktrees)", () => {
  it("adds the deny rules to a chat in a project, keeping its own settings and rules", () => {
    const out = withDevCopiesOff({ fastMode: true, permissions: { deny: ["Read(./.env)"] } }, "/Users/ash/Projects/monocode-hub");
    expect(out.fastMode).toBe(true);
    expect(out.permissions?.deny).toEqual(["Read(./.env)", ...devCopyDenyRules()]);
    expect(devCopyDenyRules()).toEqual(["Read(~/Worktrees/**)", "Edit(~/Worktrees/**)", "Bash(*Worktrees/*)", "Bash(*Worktrees)"]);
  });

  it("covers a Mono's home-folder chat and a chat with no folder", () => {
    expect(withDevCopiesOff(undefined, "/Users/ash").permissions?.deny).toEqual(devCopyDenyRules());
    expect(withDevCopiesOff({}, undefined).permissions?.deny).toEqual(devCopyDenyRules());
  });

  it("leaves a chat that works inside a dev copy alone, and never touches the hub's own session worktrees", () => {
    expect(withDevCopiesOff({}, "/Users/ash/Worktrees/cos-r45")).toEqual({});
    expect(withDevCopiesOff({}, "/Users/ash/Worktrees")).toEqual({});
    const hubWt = withDevCopiesOff({}, "/Users/ash/Projects/monocode-hub-worktrees/mc-1");
    expect(hubWt.permissions?.deny).toEqual(devCopyDenyRules());
    expect(devCopyDenyRules().some((r) => r.includes("monocode-hub-worktrees"))).toBe(false);
  });
});
