// @vitest-environment happy-dom
// WP-34. The agent may draft and read a creator session. Preview, keep, undo, discard, approve and probe stay taps.
import { beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";

const draft = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => vi.fn());

vi.mock("../../creator/model/creator", () => ({
  creatorDraft: draft,
  creatorState: state,
}));

import { appActions } from "./agentApp";
import { handleSelfBuild } from "./agentAppSelfBuild";

const SESSION = { id: "s1", harness: "claude", cwd: "/w" } as unknown as Session;
const HOST = {
  isMono: () => true,
  monoOf: () => ({ id: "creator", name: "Creator", projects: [] }),
};

beforeEach(() => {
  draft.mockReset();
  state.mockReset();
});

it("lists creator.draft and creator.state and no other creator action", () => {
  expect(appActions().filter((action) => action.startsWith("creator."))).toEqual([
    "creator.draft",
    "creator.state",
  ]);
});

it("a seated Mono drafts through creator.draft and reads creator.state", async () => {
  draft.mockResolvedValue({ id: "c1", revision: 3, phase: "drafted" });
  state.mockResolvedValue({ id: "c1", revision: 3, phase: "drafted", reports: [] });
  const delegate = vi.fn();
  await expect(
    handleSelfBuild(
      SESSION,
      "creator.draft",
      { id: "c1", revision: 2, files: [{ path: "plugin.json", content: "{}" }] },
      HOST as never,
      delegate,
    ),
  ).resolves.toMatchObject({ phase: "drafted" });
  expect(draft).toHaveBeenCalledWith("c1", 2, [{ path: "plugin.json", content: "{}" }]);
  await expect(handleSelfBuild(SESSION, "creator.state", { id: "c1" }, HOST as never, delegate)).resolves.toMatchObject({
    id: "c1",
  });
  expect(state).toHaveBeenCalledWith("c1");
  expect(delegate).not.toHaveBeenCalled();
});

it("a temporary worker cannot draft, and a draft with no files is refused", async () => {
  const delegate = vi.fn();
  await expect(
    handleSelfBuild(SESSION, "creator.draft", { id: "c1", revision: 1, files: [] }, { isMono: () => false } as never, delegate),
  ).rejects.toThrow("Only one of your own Monos");
  await expect(
    handleSelfBuild(SESSION, "creator.draft", { id: "c1", revision: 1, files: [] }, HOST as never, delegate),
  ).rejects.toThrow("nothing to write");
  expect(draft).not.toHaveBeenCalled();
});
