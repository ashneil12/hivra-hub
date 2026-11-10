import { afterEach, describe, expect, it } from "vitest";
import { setHomeDir } from "../../../shared/lib/paths";
import { chatMediaRoots, lexicalPath, mayShowChatMedia } from "./chatMedia";

afterEach(() => setHomeDir(undefined));

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
  const cwd = "/work/repo";

  it("allows a file inside the chat's folder, however deep", () => {
    expect(mayShowChatMedia("/work/repo/shot.png", cwd)).toBe(true);
    expect(mayShowChatMedia("/work/repo/a/b/c/shot.png", cwd)).toBe(true);
    expect(mayShowChatMedia("/work/repo/a/../b/shot.png", cwd)).toBe(true);
    expect(mayShowChatMedia("/work/repo/My Clips/demo.mp4", `${cwd}/`)).toBe(true);
  });

  it("refuses a file outside the chat's folder", () => {
    expect(mayShowChatMedia("/Users/me/.ssh/shot.png", cwd)).toBe(false);
    expect(mayShowChatMedia("/work/shot.png", cwd)).toBe(false);
    expect(mayShowChatMedia("/shot.png", cwd)).toBe(false);
  });

  it("refuses a sibling whose name starts with the chat folder's name", () => {
    expect(mayShowChatMedia("/work/repo-evil/shot.png", cwd)).toBe(false);
    expect(mayShowChatMedia("/work/repository/shot.png", cwd)).toBe(false);
  });

  it("refuses a path that climbs out of the folder, however it comes back", () => {
    expect(mayShowChatMedia("/work/repo/../shot.png", cwd)).toBe(false);
    expect(mayShowChatMedia("/work/repo/../repo-evil/shot.png", cwd)).toBe(false);
    expect(mayShowChatMedia("/work/repo/a/../../../shot.png", cwd)).toBe(false);
  });

  it("refuses the folder itself and a chat with no folder", () => {
    expect(mayShowChatMedia("/work/repo", cwd)).toBe(false);
    expect(mayShowChatMedia("/work/repo/shot.png", undefined)).toBe(false);
    expect(mayShowChatMedia("/work/repo/shot.png", "")).toBe(false);
    expect(mayShowChatMedia("/work/repo/shot.png", "~")).toBe(false);
  });

  it("refuses a folder that is the whole disk or the home folder", () => {
    expect(mayShowChatMedia("/Users/me/shot.png", "/")).toBe(false);
    expect(mayShowChatMedia("C:/Users/me/shot.png", "C:/")).toBe(false);
    setHomeDir("/Users/me");
    expect(mayShowChatMedia("/Users/me/Pictures/shot.png", "/Users/me")).toBe(false);
    expect(chatMediaRoots("/Users/me/")).toEqual([]);
    expect(mayShowChatMedia("/Users/me/proj/shot.png", "/Users/me/proj")).toBe(true);
  });

  it("allows the app's generated-images folder wherever the chat works", () => {
    expect(mayShowChatMedia("/app/data/generated-images/one.png", cwd)).toBe(true);
    expect(mayShowChatMedia("/app/data/generated-images/one.png", undefined)).toBe(true);
    // Only a file directly in a folder of that name.
    expect(mayShowChatMedia("/app/data/generated-images/a/one.png", cwd)).toBe(false);
    expect(mayShowChatMedia("/app/data/generated-images-old/one.png", cwd)).toBe(false);
    expect(mayShowChatMedia("/app/generated-images/../one.png", cwd)).toBe(false);
  });

  it("holds a connected machine's files to that machine's folder", () => {
    const remote = "remote://env-1/home/me/proj";
    expect(mayShowChatMedia(`${remote}/shot.png`, remote)).toBe(true);
    expect(mayShowChatMedia("remote://env-1/home/me/proj-evil/shot.png", remote)).toBe(false);
    expect(mayShowChatMedia(`${remote}/../shot.png`, remote)).toBe(false);
    expect(mayShowChatMedia("remote://env-2/home/me/proj/shot.png", remote)).toBe(false);
    expect(mayShowChatMedia("/home/me/proj/shot.png", remote)).toBe(false);
    expect(mayShowChatMedia(`${remote}/shot.png`, cwd)).toBe(false);
    // The app's generated images are on this computer, never on a machine.
    expect(mayShowChatMedia("remote://env-1/app/generated-images/one.png", remote)).toBe(false);
  });

  it("compares Windows paths the way Windows does", () => {
    const folder = "C:/Users/me/proj";
    expect(mayShowChatMedia("C:/Users/me/proj/shot.png", folder)).toBe(true);
    expect(mayShowChatMedia("c:/users/me/PROJ/shot.png", folder)).toBe(true);
    expect(mayShowChatMedia("C:/Users/me/proj-evil/shot.png", folder)).toBe(false);
    expect(mayShowChatMedia("C:/Users/me/proj/../shot.png", folder)).toBe(false);
    expect(mayShowChatMedia("D:/Users/me/proj/shot.png", folder)).toBe(false);
  });
});

describe("chatMediaRoots", () => {
  it("is the chat's folder, or nothing", () => {
    expect(chatMediaRoots("/work/repo")).toEqual(["/work/repo"]);
    expect(chatMediaRoots(" /work/repo ")).toEqual(["/work/repo"]);
    expect(chatMediaRoots(undefined)).toEqual([]);
    expect(chatMediaRoots("")).toEqual([]);
    expect(chatMediaRoots("~")).toEqual([]);
    expect(chatMediaRoots("/")).toEqual([]);
  });
});
