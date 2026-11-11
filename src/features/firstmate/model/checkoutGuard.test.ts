import { describe, expect, it, vi } from "vitest";
import {
  FirstMateTurnGuard,
  firstMateLaunch,
  type CheckoutFlag,
  type CheckoutGuardBackend,
  type CheckoutSnapshot,
} from "./checkoutGuard";
import { turnEdges } from "../hooks/useFirstMateCheckoutGuard";

const snap = (dir: string): CheckoutSnapshot => ({ dir, head: "abc", dirty: {}, takenAt: 1 });
const flag: CheckoutFlag = {
  dir: "/p",
  changed: [{ path: "README.md", revertable: true, whyNot: null }],
  headMoved: null,
  summary: "The first mate's turn changed README.md in the project's own checkout.",
};

function backend(changed: CheckoutFlag | null): CheckoutGuardBackend & { calls: string[] } {
  const calls: string[] = [];
  let current = changed;
  return {
    calls,
    snapshot: vi.fn(async (cwd: string) => {
      calls.push(`snapshot ${cwd}`);
      return snap(cwd);
    }),
    check: vi.fn(async () => {
      calls.push("check");
      return current;
    }),
    revert: vi.fn(async (_before, _flag, paths: string[]) => {
      calls.push(`revert ${paths.join(",")}`);
      current = null;
      return { reverted: paths, skipped: [] };
    }),
  };
}

describe("the after-turn checkout check (Hivra WP-10)", () => {
  it("flags a first-mate turn that changed the checkout, and reverts only on request", async () => {
    const b = backend(flag);
    const guard = new FirstMateTurnGuard(b, () => 99);
    const heard = vi.fn();
    guard.subscribe(heard);
    guard.begin("mate", "/p");
    const turn = await guard.end("mate");
    expect(turn).toMatchObject({ sessionId: "mate", flag, at: 99 });
    expect(guard.flagged()).toHaveLength(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(b.calls).toEqual(["snapshot /p", "check"]);
    const outcome = await guard.revert("mate", ["README.md"]);
    expect(outcome).toEqual({ reverted: ["README.md"], skipped: [] });
    expect(b.revert).toHaveBeenCalledWith(snap("/p"), expect.objectContaining({ dir: "/p" }), ["README.md"]);
    expect(guard.flagged()).toHaveLength(0);
  });

  it("says nothing for a clean turn, a turn it never saw start, or a folder git can't read", async () => {
    const clean = new FirstMateTurnGuard(backend(null));
    clean.begin("mate", "/p");
    expect(await clean.end("mate")).toBeUndefined();
    expect(await clean.end("other")).toBeUndefined();
    const broken = backend(flag);
    broken.snapshot = vi.fn(async () => Promise.reject(new Error("not a git checkout")));
    const guard = new FirstMateTurnGuard(broken);
    guard.begin("mate", "/tmp/notes");
    expect(await guard.end("mate")).toBeUndefined();
    expect(broken.check).not.toHaveBeenCalled();
  });

  it("watches only first mates' turns, from busy to idle", () => {
    const sessions = [
      { id: "mate", busy: true, cwd: "/p", firstMate: true },
      { id: "worker", busy: true, cwd: "/w" },
    ];
    const first = turnEdges(new Set(), sessions);
    expect(first.started.map((s) => s.id)).toEqual(["mate"]);
    expect(first.ended).toEqual([]);
    const second = turnEdges(first.busy, [{ ...sessions[0], busy: false }, sessions[1]]);
    expect(second.started).toEqual([]);
    expect(second.ended).toEqual(["mate"]);
  });

  it("adds the first mate flag to a launch only for a first mate's chat", () => {
    expect(firstMateLaunch({ firstMate: true })).toEqual({ firstMate: true });
    expect(firstMateLaunch({})).toEqual({});
  });
});

describe("the after-turn protected-file check (WP-178 items 3.3 and 3.4, report only)", () => {
  function withProtected(
    before: Record<string, string>,
    after: Record<string, string>,
  ): CheckoutGuardBackend & { protectedSnapshot: ReturnType<typeof vi.fn> } {
    const b = backend(null);
    let current = before;
    return Object.assign(b, {
      protectedSnapshot: vi.fn(async () => {
        const out = current;
        current = after;
        return out;
      }),
    });
  }

  it("reports a first-mate turn that changed .git/hooks or a secret path, and blocks nothing", async () => {
    const b = withProtected({ ".git/hooks/pre-commit": "1", "~/.ssh/id_ed25519": "1:10" }, {
      ".git/hooks/pre-commit": "2",
      "~/.ssh/id_ed25519": "1:20",
    });
    const guard = new FirstMateTurnGuard(b);
    guard.begin("mate", "/p");
    const report = await guard.endProtected("mate");
    expect(report?.touched.map((t) => `${t.kind}:${t.path}`).sort()).toEqual([
      "protected:.git/hooks/pre-commit",
      "secret:~/.ssh/id_ed25519",
    ]);
    expect(b.revert).not.toHaveBeenCalled();
  });

  it("says nothing when no protected file changed", async () => {
    const b = withProtected({ ".git/config": "a" }, { ".git/config": "a" });
    const guard = new FirstMateTurnGuard(b);
    guard.begin("mate", "/p");
    expect(await guard.endProtected("mate")).toBeUndefined();
  });

  it("is skipped when the backend has no protected snapshot, so older backends still work", async () => {
    const guard = new FirstMateTurnGuard(backend(null));
    guard.begin("mate", "/p");
    expect(await guard.endProtected("mate")).toBeUndefined();
  });
});
