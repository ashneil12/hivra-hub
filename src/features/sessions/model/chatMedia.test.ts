import { describe, expect, it } from "vitest";
import { lexicalPath, mayShowChatMedia } from "./chatMedia";

describe("lexicalPath", () => {
  it("resolves dots and doubled slashes without a disk", () => {
    expect(lexicalPath("/work/repo/./docs//shot.png")).toBe("/work/repo/docs/shot.png");
    expect(lexicalPath("/work/repo/docs/../shot.png")).toBe("/work/repo/shot.png");
    expect(lexicalPath("/work/repo/../../../shot.png")).toBe("/shot.png");
    expect(lexicalPath("/work/repo/")).toBe("/work/repo");
  });

  it("keeps a connected machine's prefix and a drive letter whole", () => {
    expect(lexicalPath("remote://env-1/home/me/proj/../a.png")).toBe("remote://env-1/home/me/a.png");
    expect(lexicalPath("remote://env-1/../../a.png")).toBe("remote://env-1/a.png");
    expect(lexicalPath("C:/Users/me/proj/../a.png")).toBe("C:/Users/me/a.png");
    expect(lexicalPath("C:/../../a.png")).toBe("C:/a.png");
  });
});

describe("mayShowChatMedia", () => {
  it("lets a chat ask Rust about a path on this computer, which decides", () => {
    expect(mayShowChatMedia("/work/repo/shot.png", "/work/repo", "chat-1")).toBe(true);
    // Rust, not the window, knows the Mono's projects and the worktrees.
    expect(mayShowChatMedia("/home/me/Worktrees/feature/shot.png", "/home/me", "chat-1")).toBe(true);
    expect(mayShowChatMedia("/Users/me/.ssh/shot.png", undefined, "chat-1")).toBe(true);
  });

  it("asks for no local file when there is no chat to hold it to", () => {
    expect(mayShowChatMedia("/work/repo/shot.png", "/work/repo", undefined)).toBe(false);
    expect(mayShowChatMedia("/work/repo/shot.png", "/work/repo", "")).toBe(false);
  });

  it("holds a connected machine's files to the chat's own project there", () => {
    const remote = "remote://env-1/home/me/proj";
    expect(mayShowChatMedia(`${remote}/shot.png`, remote, undefined)).toBe(true);
    expect(mayShowChatMedia(`${remote}/a/b/shot.png`, `${remote}/`, "chat-1")).toBe(true);
    expect(mayShowChatMedia("remote://env-1/home/me/proj-evil/shot.png", remote, undefined)).toBe(false);
    expect(mayShowChatMedia(`${remote}/../shot.png`, remote, undefined)).toBe(false);
    expect(mayShowChatMedia("remote://env-2/home/me/proj/shot.png", remote, undefined)).toBe(false);
    expect(mayShowChatMedia(remote, remote, undefined)).toBe(false);
    // A chat on this computer has no business on a machine.
    expect(mayShowChatMedia(`${remote}/shot.png`, "/work/repo", "chat-1")).toBe(false);
    expect(mayShowChatMedia(`${remote}/shot.png`, undefined, "chat-1")).toBe(false);
  });
});
