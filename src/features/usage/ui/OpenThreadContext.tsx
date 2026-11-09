import { ContextMeter } from "../../sessions/ui/ContextMeter";
import type { ContextUsage } from "../../sessions/model/contextUsage";

/**
 * WP-127: the open chat's context meter.
 *
 * The ring is the existing meter. It is rendered outside the transcript
 * scroller, so scrolling the thread does not unmount it or move it off screen.
 */
export function OpenThreadContext({
  open = true,
  usage,
  empty = false,
  onCompact,
  compactDisabled = false,
  ceiling,
}: {
  /** The chat is on screen. Closing it removes the meter. */
  open?: boolean;
  usage?: ContextUsage;
  empty?: boolean;
  onCompact?: () => void;
  compactDisabled?: boolean;
  ceiling?: number;
}) {
  if (!open) return null;
  return (
    <div
      data-open-thread-context
      className="flex shrink-0 items-center justify-end gap-2 px-3 py-1 text-[11px] text-content/55"
    >
      <span>Context</span>
      <ContextMeter
        usage={usage}
        empty={empty}
        onCompact={onCompact}
        compactDisabled={compactDisabled}
        ceiling={ceiling}
      />
    </div>
  );
}
