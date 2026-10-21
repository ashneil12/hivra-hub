// The long chat's view in a Mono's settings ("Keep one long chat", monoTreeStore.ts): its whole chat as the Mono sees
// it, oldest first. A line that stands for several messages is folded and says how many ("12 earlier messages");
// opening it shows the two lines it was made from, down to the messages word for word, and "Fold" closes it again.
// (UniiChat draws these as "8x" and "▾ 8x · fold"; the tree underneath is the same.)
import { useEffect, useState } from "react";
import { treeLines, treeView, treeZoom, type TreeLine } from "../model/monoTreeStore";

type Zoom = (id: number, n: number) => Promise<TreeLine[]>;

/** The speaker tags as Ash reads them. */
function speakers(text: string): string {
  return text.replace(/(^|[;.]\s|\s)(user|mono|seat|tool|echo|work|note): /g, (_, lead: string, kind: string) => {
    const label: Record<string, string> = { user: "Ash", mono: "Mono", seat: "Room", tool: "Tool", echo: "Result", work: "Report", note: "Note" };
    return `${lead}${label[kind]}: `;
  });
}

export function earlierLabel(n: number): string {
  return `${n} earlier message${n === 1 ? "" : "s"}`;
}

function Line({ line, zoom, depth }: { line: TreeLine; zoom: Zoom; depth: number }) {
  const [open, setOpen] = useState<TreeLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const folded = line.n > 1;
  return (
    <div className="flex flex-col" style={{ paddingLeft: depth ? 12 : 0 }} data-tree-line={`${line.id}+${line.n}`}>
      <div className="flex items-start gap-2 py-1.5">
        {folded ? (
          <button
            type="button"
            disabled={busy}
            aria-expanded={open !== null}
            onClick={async () => {
              if (open) return setOpen(null);
              setBusy(true);
              try {
                setOpen(await zoom(line.id, line.n));
              } finally {
                setBusy(false);
              }
            }}
            className="shrink-0 rounded-md border border-stroke px-2 py-0.5 text-[11px] leading-4 text-content/70 hover:bg-content/[0.06]"
          >
            {open ? "Fold" : earlierLabel(line.n)}
          </button>
        ) : null}
        {open ? null : (
          <span className={`min-w-0 flex-1 text-[12px] leading-5 ${folded ? "text-content/55" : "text-content/85"}`}>
            {speakers(line.text)}
          </span>
        )}
      </div>
      {open ? (
        <div className="flex flex-col border-l border-stroke">
          {open.map((half) => (
            <Line key={`${half.id}+${half.n}`} line={half} zoom={zoom} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The view's lines, each folded one opening in place. */
export function LongChatLines({ lines, zoom }: { lines: readonly TreeLine[]; zoom: Zoom }) {
  if (!lines.length)
    return <p className="px-3 py-3 text-[12px] leading-5 text-content/40">Nothing yet. Its next finished turn starts the long chat.</p>;
  return (
    <div className="flex max-h-96 flex-col overflow-y-auto px-3 py-1.5" data-long-chat-view>
      {lines.map((line) => (
        <Line key={`${line.id}+${line.n}`} line={line} zoom={zoom} depth={0} />
      ))}
    </div>
  );
}

export function LongChatView({ monoId }: { monoId: string }) {
  const [lines, setLines] = useState<TreeLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    treeView(monoId).then(
      (next) => live && setLines(next),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [monoId]);
  if (failed) return <p className="px-3 py-3 text-[12px] leading-5 text-red-400">Couldn't open its long chat.</p>;
  if (!lines) return <p className="px-3 py-3 text-[12px] leading-5 text-content/40">Opening its long chat…</p>;
  return <LongChatLines lines={lines} zoom={async (id, n) => treeLines(await treeZoom(monoId, id, n))} />;
}
