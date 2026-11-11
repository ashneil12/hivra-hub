import type { ReactNode } from "react";
import { PanelBottom, PanelRight } from "../../../shared/ui/icons";
import type { LayoutNode, SplitDir } from "../model/layout";
import { splitBlockReason } from "../model/paneSplit";

const ACTIONS: { dir: SplitDir; label: string; Icon: typeof PanelRight }[] = [
  { dir: "right", label: "Split right", Icon: PanelRight },
  { dir: "down", label: "Split down", Icon: PanelBottom },
];

/**
 * Split right and split down for one pane. Both call `onSplit`, the same
 * handler the shortcut uses, after focusing this pane so the split lands
 * here. A direction the layout cannot take is disabled, with the reason
 * as its label.
 */
export function PaneSplitButtons({
  layout,
  paneId,
  onFocus,
  onSplit,
}: {
  layout: LayoutNode;
  paneId: string;
  onFocus: (paneId: string, reason?: "pointer") => void;
  onSplit: (dir: SplitDir) => void;
}) {
  return (
    <div data-pane-splits="" data-no-drag="" className="flex shrink-0 items-center">
      {ACTIONS.map(({ dir, label, Icon }) => {
        const reason = splitBlockReason(layout, paneId, dir);
        const name = reason ? `${label}. ${reason}` : label;
        return (
          <button
            key={dir}
            type="button"
            data-pane-split={dir}
            data-no-drag=""
            aria-label={name}
            title={reason ?? label}
            disabled={reason !== null}
            className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (reason) return;
              onFocus(paneId, "pointer");
              onSplit(dir);
            }}
          >
            <Icon className="size-3.5" strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A pane that is on its own has no header bar: a bar above every lone chat or file only to hold two icons costs a
 * row of the screen. Its split buttons sit in the top right corner instead, out of the layout, and show while the
 * pane is hovered or one of them has keyboard focus (`:focus-visible`, so a mouse click that leaves a button focused
 * does not keep the corner showing). The pane's root carries `group/pane`. Once the pane is in a
 * split, its own header (or tab strip) holds the buttons and this corner is not used.
 */
export function PaneSplitCorner({ children }: { children: ReactNode }) {
  return (
    <div
      data-pane-corner=""
      className="absolute top-2 right-2 z-20 flex rounded-md bg-content/10 opacity-0 backdrop-blur-xl transition-opacity duration-150 group-hover/pane:opacity-100 has-[:focus-visible]:opacity-100 motion-reduce:transition-none"
    >
      {children}
    </div>
  );
}
