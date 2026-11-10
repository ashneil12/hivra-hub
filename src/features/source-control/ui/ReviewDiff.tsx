import { useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  DIFF_PRESENTATION_KEY,
  readDiffPresentation,
  writeDiffPresentation,
  type DiffPresentation,
} from "../model/diffPresentation";
import { canSplit, splitFileText } from "../model/splitDiff";
import { SplitDiffView } from "./SplitDiffView";
import { useSplitPackage } from "./splitPackage";
import { UnifiedDiffView } from "./UnifiedDiffView";

type Props = ComponentProps<typeof UnifiedDiffView>;

/**
 * Unified review, with an optional split view. Unified stays the default.
 * A review that only has a patch (a pull request) has no Split: hunks are not
 * whole files. The saved choice is left alone for the reviews that can split.
 * The split view's package loads on demand. Until it arrives, and if it fails
 * to load, the unified review stays on screen.
 */
export function ReviewDiff(props: Props) {
  const [mode, setMode] = useState<DiffPresentation>(() => readDiffPresentation());
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key != null && event.key !== DIFF_PRESENTATION_KEY) return;
      setMode(readDiffPresentation());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const choose = (next: DiffPresentation) => {
    setMode(next);
    writeDiffPresentation(next);
  };
  const splittable = useMemo(() => canSplit(props.files), [props.files]);
  const shown: DiffPresentation = splittable ? mode : "unified";
  const needsPackage = useMemo(
    () =>
      shown === "split" &&
      props.files.some((file) => splitFileText(file) !== null),
    [shown, props.files],
  );
  const pierre = useSplitPackage(needsPackage);
  const splitDrawn =
    shown === "split" && (pierre.status === "idle" || pierre.status === "ready");
  const canChange = Boolean(
    props.onStageFile || props.onStageHunk || props.onDiscardFile,
  );
  const fill = props.fill !== false;

  return (
    <div
      className={
        fill
          ? "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          : "min-w-0"
      }
    >
      {splittable ? (
        <DiffLayoutControl
          mode={mode}
          onChange={choose}
          viewOnly={splitDrawn && canChange}
        />
      ) : null}
      {splitDrawn ? (
        <SplitDiffView
          files={props.files}
          fill={fill}
          PierreFile={pierre.status === "ready" ? pierre.PierreFile : null}
          focusPath={props.focusPath}
          focusId={props.focusId}
        />
      ) : (
        <>
          {shown === "split" && pierre.status === "failed" ? (
            <p className="shrink-0 border-b border-stroke px-3 py-1.5 text-[12px] text-content/55">
              Split view could not load. Showing Unified.
            </p>
          ) : null}
          <div className={fill ? "min-h-0 flex-1" : undefined}>
            <UnifiedDiffView {...props} />
          </div>
        </>
      )}
    </div>
  );
}

function DiffLayoutControl({
  mode,
  onChange,
  viewOnly,
}: {
  mode: DiffPresentation;
  onChange: (next: DiffPresentation) => void;
  viewOnly: boolean;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-stroke px-3">
      <div
        role="radiogroup"
        aria-label="Diff layout"
        className="flex shrink-0 items-center gap-0.5"
      >
        {(
          [
            ["unified", "Unified"],
            ["split", "Split"],
          ] as const
        ).map(([value, label]) => {
          const selected = mode === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(value)}
              className={`h-6 rounded-md px-2 text-[12px] ${
                selected
                  ? "bg-content/10 text-content"
                  : "text-content/55 hover:bg-content/5 hover:text-content"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {viewOnly ? (
        <p className="min-w-0 truncate text-[12px] text-content/55">
          Split is view only. Staging stays on Unified.
        </p>
      ) : null}
    </div>
  );
}
