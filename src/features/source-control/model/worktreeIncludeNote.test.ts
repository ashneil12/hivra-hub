import { afterEach, expect, it } from "vitest";
import {
  rememberWorktreeInclude,
  resetWorktreeIncludeNotes,
  withCreatedInclude,
  worktreeIncludeLine,
  worktreeIncludeLines,
  worktreeIncludeLinesOf,
} from "./worktreeIncludeNote";

const NOTE = "1 file named in .worktreeinclude is in this worktree.";
const SECRET = "SECRET-VALUE-do-not-leak";

afterEach(() => {
  resetWorktreeIncludeNotes();
});

it("keeps a short first line and drops a second line", () => {
  expect(worktreeIncludeLine(NOTE)).toBe(NOTE);
  expect(worktreeIncludeLine(`Could not copy .env into this worktree.\n${SECRET}`)).toBe(
    "Could not copy .env into this worktree.",
  );
  expect(worktreeIncludeLine(`  Left notes.txt as it was.\r\n${SECRET}`)).toBe(
    "Left notes.txt as it was.",
  );
  expect(worktreeIncludeLine(`hello\u0000${SECRET}`)).toBe(`hello${SECRET}`);
  expect(worktreeIncludeLine("   ")).toBeUndefined();
  expect(worktreeIncludeLine("x".repeat(601))).toBeUndefined();
  expect(worktreeIncludeLine(12)).toBeUndefined();
  expect(worktreeIncludeLine(null)).toBeUndefined();
});

it("remembers a note for the worktree it was copied into", () => {
  const lines = rememberWorktreeInclude("chat-1", {
    path: "/work/repo-worktrees/feature",
    includeNote: NOTE,
    includeWarning: `Skipped 1 path that leaves the repository.\n${SECRET}`,
  });
  expect(lines.note).toBe(NOTE);
  expect(lines.warning).toBe("Skipped 1 path that leaves the repository.");
  expect(lines.warning).not.toContain(SECRET);
  expect(lines.note).not.toMatch(/[—–]/);

  rememberWorktreeInclude("chat-1", { path: "/work/repo-worktrees/feature" });
  const kept = worktreeIncludeLines({
    id: "chat-1",
    worktreeCwd: "/work/repo-worktrees/feature",
  });
  expect(kept.note).toBe(NOTE);
  expect(kept.warning).toBe("Skipped 1 path that leaves the repository.");

  expect(
    worktreeIncludeLines({
      id: "chat-1",
      worktreeCwd: "/work/repo-worktrees/other",
    }),
  ).toEqual({});
  expect(
    worktreeIncludeLines({
      id: "chat-1",
      worktreeCwd: "C:\\work\\repo-worktrees\\feature",
      includeNote: NOTE,
    }).note,
  ).toBe(NOTE);
});

it("uses the session fields, and a Windows path still matches the kept note", () => {
  rememberWorktreeInclude("chat-2", {
    path: "C:\\work\\repo-worktrees\\feature",
    includeNote: NOTE,
  });
  expect(
    worktreeIncludeLines({
      id: "chat-2",
      worktreeCwd: "C:/work/repo-worktrees/feature",
    }).note,
  ).toBe(NOTE);
  expect(
    worktreeIncludeLines({
      id: "chat-2",
      worktreeCwd: "C:/work/repo",
      includeWarning: "Could not read .worktreeinclude.",
    }),
  ).toEqual({ warning: "Could not read .worktreeinclude." });
});

it("reads the lines off a create result and drops a second line", () => {
  expect(
    worktreeIncludeLinesOf({
      includeNote: NOTE,
      includeWarning: `Could not copy .env into this worktree.\n${SECRET}`,
    }),
  ).toEqual({ note: NOTE, warning: "Could not copy .env into this worktree." });
  expect(worktreeIncludeLinesOf({})).toEqual({});
});

it("puts a create result's lines on the listed worktree, and leaves a plain one alone", () => {
  const listed = { path: "/w" };
  const merged = withCreatedInclude(listed, {
    includeNote: NOTE,
    includeWarning: `Left .env as it was.\n${SECRET}`,
  });
  expect(merged).toEqual({
    path: "/w",
    includeNote: NOTE,
    includeWarning: "Left .env as it was.",
  });
  expect(withCreatedInclude(listed, {})).toBe(listed);
});
