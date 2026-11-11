// WP-135: the compare view, with made-up chats, a loser that is still running, and a fake git that behaves like the
// app's: a worktree is clean and at the commit it was made at until a change is made in it, and git refuses to remove
// one with changes in it. `?loser=dirty` makes the loser's worktree hold a change.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { assignFanOutWorktrees, planFanOut, replaceFanOutChildren, type CompareRecord } from "../../src/features/sessions/model/fanOut";
import { discardFanOutLoser, pickFanOutInStore, type CompareStore } from "../../src/features/sessions/model/fanOutDecide";
import { ownWorktreeVerdict } from "../../src/features/sessions/model/fanOutJanitor";
import { fanOutCompareRows } from "../../src/features/sessions/model/fanOutView";
import { FanOutCompare } from "../../src/features/sessions/ui/FanOutCompare";
import "../../src/styles/index.css";

const MADE_AT = "abc1234";
const loserHasChanges = new URLSearchParams(window.location.search).get("loser") === "dirty";

const planned = planFanOut({
  prompt: "Fix the flaky test",
  targets: [
    { provider: "claude", model: "one" },
    { provider: "codex", model: "two" },
  ],
  ids: { next: sequence(["compare-1", "child-a", "child-b"]) },
  now: 1,
});
if (!planned.ok) throw new Error(planned.code);
const assigned = assignFanOutWorktrees(planned.record.children, {
  projectRoot: "/work/proj",
  allowedRoots: ["/work/trees"],
  git: true,
  offers: [
    { path: "/work/trees/a", branch: "mc/fan-a", head: MADE_AT },
    { path: "/work/trees/b", branch: "mc/fan-b", head: MADE_AT },
  ],
});
const written = replaceFanOutChildren(planned.record, planned.record.revision, assigned);
if (!written.ok) throw new Error(written.code);

/** The worktrees git holds, by path. */
const git = new Map<string, { head: string; dirty: boolean }>([
  ["/work/trees/a", { head: MADE_AT, dirty: false }],
  ["/work/trees/b", { head: MADE_AT, dirty: loserHasChanges }],
]);

function sequence(values: string[]) {
  const left = [...values];
  return () => left.shift() ?? "extra";
}

function Page() {
  const held = useRef<CompareRecord>(written.record);
  const [, setRevision] = useState(written.record.revision);
  const [removed, setRemoved] = useState("none");
  const [stopped, setStopped] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const store: CompareStore = {
    get: async (id) => (held.current.id === id ? held.current : null),
    put: async (record) => {
      held.current = record;
      setRevision(record.revision);
      return true;
    },
  };
  const rows = fanOutCompareRows(held.current, [
    {
      id: "child-a",
      busy: true,
      blocks: [
        { role: "user", turnMetrics: { costUsd: 0.25 } },
        { role: "assistant", text: "The flake was a shared clock." },
      ],
    },
    {
      id: "child-b",
      busy: !stopped.includes("child-b"),
      blocks: [{ role: "user", turnMetrics: { inputTokens: 900, outputTokens: 40 } }],
    },
  ]);
  return (
    <>
      <FanOutCompare
        view={{
          rows,
          onPick: (childId) => pickFanOutInStore(held.current.id, childId, store),
          onDiscard: (childId) =>
            discardFanOutLoser(
              held.current.id,
              childId,
              {
                allowedRoots: ["/work/trees"],
                stop: async (id) => {
                  setStopped((list) => [...list, id]);
                  setOrder((list) => [...list, `stop:${id}`]);
                },
                inspect: async (path, madeAt) => {
                  const tree = git.get(path);
                  return ownWorktreeVerdict(
                    tree ? { head: tree.head, dirty: tree.dirty, locked: false, missing: false, isMain: false } : undefined,
                    madeAt,
                  );
                },
                remove: async (path) => {
                  if (git.get(path)?.dirty) throw new Error("contains modified or untracked files");
                  git.delete(path);
                  setRemoved(path);
                  setOrder((list) => [...list, `remove:${path}`]);
                },
              },
              store,
            ),
        }}
      />
      <p data-fan-out-removed="">{removed}</p>
      <p data-fan-out-order="">{order.join(",") || "none"}</p>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
