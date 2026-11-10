import { describe, expect, it } from "vitest";
import { hasChatFolder, withRelinkedFolder } from "./chatFolder";

describe("a relinked chat", () => {
  const chats = [
    { id: "a", cwd: "", title: "A" },
    { id: "b", cwd: "", title: "B" },
    { id: "c", cwd: "/work/mine", title: "C" },
  ];

  it("takes its folder and nothing else, and no other chat changes", () => {
    const next = withRelinkedFolder(chats, "a", "/work/app/src");
    expect(next[0]).toEqual({ id: "a", cwd: "/work/app/src", title: "A" });
    expect(next[1]).toBe(chats[1]);
    expect(next[2]).toBe(chats[2]);
  });

  it("never replaces a folder the chat already has", () => {
    expect(withRelinkedFolder(chats, "c", "/work/other")[2].cwd).toBe("/work/mine");
  });

  it("reads a blank, a space and a missing folder as no folder, and the home folder as one", () => {
    expect([hasChatFolder(""), hasChatFolder("  "), hasChatFolder(undefined), hasChatFolder("~")]).toEqual([false, false, false, true]);
  });
});
