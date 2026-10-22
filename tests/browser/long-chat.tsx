import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as T from "../../src/features/monos/model/monoTree";
import { treeLines, type TreeLine } from "../../src/features/monos/model/monoTreeStore";
import { LongChatLines } from "../../src/features/monos/ui/LongChatView";
import { SwitchRow } from "../../src/features/monos/ui/monoPanelParts";
import "../../src/styles/index.css";

// The long chat's panel in a Mono's settings: the real engine (monoTree.ts) over an in-memory disk, past the view's
// 128 KB so its oldest lines fold, with a stand-in summariser (each summary: its input cut to 470 bytes). The lines
// about Fridays are test lines written in Ash's style, not things Ash said.
const files = new Map<string, string>();
const disk: T.TreeDisk = {
  read: (p) => files.get(p) ?? null,
  list: (d) => [...files.keys()].filter((p) => p.startsWith(d + "/")).map((p) => p.slice(d.length + 1)),
  mkdir: () => {},
  append: (p, t) => void files.set(p, (files.get(p) ?? "") + t),
  write: (p, t) => void files.set(p, t),
};
const summarise: T.Compactor = async (_system, blocks) => {
  const task = blocks[blocks.length - 1].text;
  const input = task.slice(task.indexOf("<input>\n") + 8, task.lastIndexOf("\n</input>")).replace(/\s*\n\s*/g, " ");
  return { ok: true, text: T.cut(input).slice(0, 470) };
};
const tree = T.load("tree", "fixture", summarise, disk);
const opening: Array<[T.Kind, string]> = [
  ["user", "hivra, for the onboarding refactor: keep the review async in the PR thread, no meetings. and frank owns the migration script, not you"],
  ["mono", "Got it: reviews stay async in the PR thread, no meetings, and frank owns the migration script."],
  ["user", "we said fridays for the review right?"],
  ["mono", "I have nothing on file about Fridays. What I have is your word from this morning: reviews stay async in the PR thread, no day set. Do you want me to save Fridays as the review day?"],
];
const filler = (i: number): [T.Kind, string] => [
  (["tool", "echo", "mono", "user"] as const)[i % 4],
  `step ${i} of the onboarding refactor: ${"the step state moves to the ?s= URL param, tests stay green, PR #212 waits for its review ".repeat(2)}`,
];
const script = [...opening, ...Array.from({ length: 640 }, (_, i) => filler(i))];
for (const [kind, text] of script) T.push(tree, [{ kind, text }]);

function Fixture() {
  const [lines, setLines] = useState<TreeLine[] | null>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    const done = () => !tree.busy.size && tree.ready.every((q) => !q || !q.length);
    const timer = setInterval(() => {
      if (!done()) return;
      clearInterval(timer);
      setLines(treeLines(T.view(tree).map((b) => b.text).join("")).slice(0, 6));
      (window as unknown as { ready: boolean }).ready = true;
    }, 50);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex flex-col">
      <div className="px-1 pb-2 pt-2">
        <h4 className="text-[12px] font-medium text-content/70">Long chat</h4>
        <p className="text-[12px] leading-5 text-content/40">Off: each conversation starts on its soul and memory notes. On: it also remembers the whole chat.</p>
      </div>
      <div className="flex flex-col divide-y divide-stroke rounded-xl border border-stroke bg-content/[0.02]">
        <SwitchRow
          label="Keep one long chat"
          description="Remembers the whole chat and opens it back up word for word. Memory notes and New conversation stay as they are."
          on={on}
          onChange={setOn}
        />
        {on && lines ? <LongChatLines lines={lines} zoom={async (id, n) => treeLines(T.zoom(tree, id, n))} /> : null}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
