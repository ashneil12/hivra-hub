// WP-126: the sentence on a handoff or a mid-thread switch.

import type { ReactNode } from "react";

export function SkillSwitchLine({
  notice,
  onRetry,
}: {
  notice: string | null;
  onRetry?: () => void;
}): ReactNode {
  if (!notice) return null;
  return (
    <p
      data-skill-switch-notice
      role="status"
      className="px-3 pt-2 text-[12px] leading-4 text-content/70"
    >
      {notice}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="ml-2 underline">
          Try again
        </button>
      ) : null}
    </p>
  );
}
