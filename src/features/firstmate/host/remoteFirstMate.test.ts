import { describe, expect, it, vi } from "vitest";
import type { CatchUpEntry } from "./types";
import { acceptCatchUp, briefRemoteProject, catchUpKey, catchUpRemoteProject, type CursorStore } from "./remoteFirstMate";

function memory(): CursorStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => raw.set(key, value),
  };
}

const entry = (seq: number, text = "The change is in."): CatchUpEntry => ({
  seq,
  projectId: "project-1",
  delegationId: "delegation-1",
  kind: "finished",
  startedBy: "person",
  text,
  at: 1_000 + seq,
});

describe("remote first mate catch-up", () => {
  it("applies a page once and ignores a corrupt cursor", () => {
    const storage = memory();
    storage.setItem(catchUpKey("env", "project-1"), "{");
    const first = acceptCatchUp(storage, "env", "project-1", {
      entries: [entry(1), { seq: "no" }, entry(1)],
    });
    expect(first).toEqual([entry(1)]);
    expect(acceptCatchUp(storage, "env", "project-1", { entries: [entry(1)] })).toEqual([]);
    expect(acceptCatchUp(storage, "env", "project-1", { entries: [entry(2, "Also done.")] })).toEqual([
      entry(2, "Also done."),
    ]);
  });

  it("does not advance the cursor when the host cannot be reached", async () => {
    const storage = memory();
    const request = vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9")));
    await expect(catchUpRemoteProject(request, "env", "project-1", storage)).resolves.toEqual([]);
    expect(storage.raw.size).toBe(0);
    expect(request).toHaveBeenCalledWith("firstmate.catchUp", { projectId: "project-1", after: 0 });
  });

  it("asks for everything after the last entry it kept", async () => {
    const storage = memory();
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      params.after === 0 ? { entries: [entry(4)] } : { entries: [] },
    );
    await expect(catchUpRemoteProject(request, "env", "project-1", storage)).resolves.toEqual([entry(4)]);
    await expect(catchUpRemoteProject(request, "env", "project-1", storage)).resolves.toEqual([]);
    expect(request).toHaveBeenLastCalledWith("firstmate.catchUp", { projectId: "project-1", after: 4 });
  });

  it("reads a brief the host accepted", async () => {
    const delegation = { id: "delegation-1" };
    const request = vi.fn(async () => ({ delegation, created: true }));
    await expect(briefRemoteProject(request, { launchKey: "brief-1" })).resolves.toEqual({
      delegation,
      created: true,
    });
    await expect(briefRemoteProject(vi.fn(async () => ({})), {})).rejects.toThrow(/no brief/);
  });
});
