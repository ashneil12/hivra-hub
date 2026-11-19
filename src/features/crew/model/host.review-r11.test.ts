import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { projectDefaultForFolder } from "./host";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

// PR #194 round 11 review (head f91297483). crew_projects_owning already returns the owners most specific first, sorted
// by the CANONICAL path (store.rs specific_first, path_key resolves links). projectDefaultForFolder sorts them again by
// the TEXT length of the spelling it got back (mostSpecificFirst, host.ts:218). A hub root returned in a linked spelling
// is short while the project that contains it is long, so the outer project's default wins.
describe("PR #194 r11 review: the worker default keeps the gate's most-specific-first order", () => {
  it("does not re-sort the owners by the length of their spelling", async () => {
    // "/u/r/pkg" is a hub folder whose /u/r is a link to /Volumes/LongDiskName/Projects/repo: canonically the package
    // (…/repo/pkg) is inside the repo, so the gate answers it first.
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "crew_projects_owning") return ["/u/r/pkg", "/Volumes/LongDiskName/Projects/repo"];
      return undefined;
    });
    const pick = await projectDefaultForFolder("/Users/ash/Worktrees/repo-wt/pkg", (key) => {
      if (key === "/u/r/pkg") return { cli: "claude" } as never;
      if (key === "/Volumes/LongDiskName/Projects/repo") return { cli: "codex" } as never;
      return undefined;
    });
    expect(pick).toMatchObject({ cli: "claude" });
  });
});
