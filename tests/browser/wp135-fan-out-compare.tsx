// WP-135: the compare view, with made-up chats and a janitor that can remove one loser.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { assignFanOutWorktrees, planFanOut, replaceFanOutChildren, type CompareRecord } from "../../src/features/sessions/model/fanOut";
import { discardFanOutLoser, pickFanOutInStore } from "../../src/features/sessions/model/fanOutDecide";
import { fanOutCompareRows } from "../../src/features/sessions/model/fanOutView";
import { FanOutCompare } from "../../src/features/sessions/ui/FanOutCompare";
import "../../src/styles/index.css";

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
    { path: "/work/trees/a", branch: "mc/fan-a" },
    { path: "/work/trees/b", branch: "mc/fan-b" },
  ],
});
const written = replaceFanOutChildren(planned.record, planned.record.revision, assigned);
if (!written.ok) throw new Error(written.code);

function sequence(values: string[]) {
  const left = [...values];
  return () => left.shift() ?? "extra";
}

function Page() {
  const held = useRef<CompareRecord>(written.record);
  const [, setRevision] = useState(written.record.revision);
  const [removed, setRemoved] = useState("none");
  const store = {
    get: (id: string) => (held.current.id === id ? held.current : null),
    put: (record: CompareRecord) => {
      held.current = record;
      setRevision(record.revision);
      return true;
    },
  };
  const rows = fanOutCompareRows(held.current, [
    {
      id: "child-a",
      busy: true,
      blocks: [{ role: "assistant", text: "The flake was a shared clock." }],
    },
    { id: "child-b", blocks: [] },
  ]);
  return (
    <>
      <FanOutCompare
        view={{
          rows,
          onPick: (childId) => {
            pickFanOutInStore(held.current.id, childId, store);
          },
          onDiscard: (childId) =>
            discardFanOutLoser(
              held.current.id,
              childId,
              {
                allowedRoots: ["/work/trees"],
                inspect: async () => "remove",
                remove: async (path) => {
                  setRemoved(path);
                },
              },
              store,
            ),
        }}
      />
      <p data-fan-out-removed="">{removed}</p>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
